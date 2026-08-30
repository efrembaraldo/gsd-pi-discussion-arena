/**
 * Agent Discussion Arena — Participant execution
 *
 * Esegue un singolo partecipante come sottoprocesso `gsd` isolato in
 * modalità print/JSON, con contesto azzerato (--no-session) e system prompt
 * di ruolo iniettato via --append-system-prompt.
 *
 * Pattern di spawn e parsing eventi copiato 1:1 da
 * packages/pi-coding-agent/examples/extensions/subagent/index.ts (runSingleAgent),
 * con una sola modifica strutturale: il binario invocato è `gsd`, non `pi`,
 * perché la discussion-arena gira dentro il processo gsd-pi, non pi vanilla.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import type { ParticipantConfig } from "./participants.js";
import {
	type ResolvedLimits,
	type FailureKind,
	DEFAULT_PARTICIPANT_LIMITS,
} from "./helpers.js";
import { isHermesAvailable } from "./src/hermes-readiness.js";

export interface ParticipantTurnResult {
	participant: string;
	role: string;
	exitCode: number;
	text: string;
	stderr: string;
	usage: { input: number; output: number; cost: number; turns: number };
	/**
	 * Durata del turno in millisecondi, dallo spawn alla chiusura del
	 * subprocess (S04). Alimenta l'istogramma `discussion_arena_round_duration_seconds`
	 * del consumer S08.
	 */
	durationMs: number;
	/**
	 * Kind di failure del turno (S04, esteso S09/T01). Valorizzato quando il
	 * turno è terminato dai timer interni — `"timeout_round"` (round_timeout_ms
	 * superato) o `"timeout_event"` (nessun evento per event_timeout_ms) —
	 * oppure quando il subprocess muore per un segnale fatale esterno o esce
	 * con exit code non-zero senza timeout/abort (`"failed"`, classificatore
	 * SIGKILL S09/T01). Assente negli altri casi: successo, cancel esterno
	 * (abortReason="external", comportamento pre-S04 preservato).
	 */
	failureKind?: FailureKind;
	/** Descrizione leggibile della failure (soglia superata e valore). */
	failureReason?: string;
	/**
	 * Marker engine iniettato dal dispatcher (M015/S03/R045/R041). Valorizzato
	 * solo da `dispatchParticipantTurn`:
	 *   - `'<!-- engine: hermes -->'` quando il turno è stato eseguito
	 *     via `runParticipantTurnViaHermes` con successo;
	 *   - `'<!-- engine: gsd (degradato da hermes: binario non disponibile) -->'`
	 *     quando il binario `hermes` non era disponibile e il dispatcher è
	 *     caduto su `runParticipantTurn` (R045);
	 * Assente per i turni eseguiti direttamente da `runParticipantTurn` /
	 * `runParticipantTurnViaHermes` (retrocompat: call site pre-S03 che non
	 * passano per il dispatcher non ricevono il campo). Surface consumata da
	 * `runDiscussionArena` (index.ts) per iniettare il marker nell'entry del
	 * round dopo l'outputText.
	 */
	engineMarker?: string;
}

/**
 * Grace dopo SIGTERM nella soft termination prima dell'escalation a SIGKILL
 * (S04: soft = SIGTERM + 5s grace + SIGKILL).
 */
const SOFT_TERMINATION_GRACE_MS = 5_000;

/**
 * Coerce difensiva a number: il contratto dichiara `usage.{input,output,cost}: number`
 * ma in eventi message_end reali alcuni provider/modelli emettono valori come stringa
 * (es. `"0.001"`). Sommare una stringa a un number in JS lo converte in stringa, e
 * `string.toFixed()` lancia. Questa funzione normalizza al tipo dichiarato.
 */
function toNumber(v: unknown): number {
	if (typeof v === "number" && Number.isFinite(v)) return v;
	if (typeof v === "string") {
		const n = Number(v);
		return Number.isFinite(n) ? n : 0;
	}
	return 0;
}

/** Scrive il system prompt in un file temporaneo (evita limiti di lunghezza argv). */
async function writePromptToTempFile(
	name: string,
	prompt: string,
): Promise<{ dir: string; filePath: string }> {
	const dir = await fs.promises.mkdtemp(
		path.join(os.tmpdir(), `gsd-discussion-arena-${name}-`),
	);
	const filePath = path.join(dir, "system-prompt.md");
	await fs.promises.writeFile(filePath, prompt, "utf-8");
	return { dir, filePath };
}

function getGsdInvocation(args: string[]): { command: string; args: string[] } {
	// A differenza del subagent example (che rileva se sta girando dentro il
	// binario pi compilato per auto-invocarsi), qui assumiamo `gsd` presente
	// in PATH — è la stessa assunzione che fa già il resto di gsd-pi per i
	// comandi worktree/CLI. Se in futuro serve il fallback all'eseguibile
	// corrente compilato, applicare la stessa logica di getPiInvocation().
	return { command: "gsd", args };
}

/**
 * Costruisce il prompt per il runner hermes (M015/S02/R040) unendo
 * ruolo + systemPrompt + turno con separatori markdown D127.
 *
 * Decisione D127: il prompt hermes `-z` non ha hook di system-prompt
 * separato, quindi il system prompt del ruolo va prepended al prompt del
 * turno con separatori leggibili (markdown H1 + horizontal rule). Tre
 * sezioni nette — Ruolo, System prompt del partecipante, Turno corrente —
 * rendono il prompt hermes ispezionabile a colpo d'occhio durante debug
 * (utile perché hermes -z emette il prompt trasformato ma non lo riepiloga).
 *
 * Formato output:
 * ```
 * # Ruolo: <role>
 *
 * <systemPrompt opzionale>
 *
 * ---
 *
 * # Turno di discussione
 *
 * <turnPrompt>
 * ```
 *
 * `systemPrompt` vuoto o assente -> sezione Ruolo seguita direttamente
 * dal separatore `---` (nessun doppio newline anomalo). Funzione pura:
 * nessuno spawn, nessun I/O, nessun side-effect — riusata dal test unit
 * `tests/hermes-participant.test.ts` (T03/R047) per verifiche di shape.
 *
 * @param participant configurazione del participant (ruolo + systemPrompt).
 * @param turnPrompt prompt del turno corrente (topic + transcript accumulato).
 * @returns prompt markdown completo pronto per `hermes -z`.
 */
export function buildHermesPrompt(
	participant: ParticipantConfig,
	turnPrompt: string,
): string {
	const systemSection = participant.systemPrompt
		? `${participant.systemPrompt}\n\n`
		: "";
	return `# Ruolo: ${participant.role}\n\n${systemSection}---\n\n# Turno di discussione\n\n${turnPrompt}`;
}

/**
 * Risultato della costruzione argv hermes (M015/S02/R040). Funzione pura:
 * nessuno spawn, nessuna scrittura su stderr (i warnings sono accumulati in
 * `warnings[]` e il caller decide dedup ed emissione). Riusata dal test unit
 * `tests/hermes-participant.test.ts` (T03/R047) per verifiche di shape.
 */
export interface HermesInvocation {
	command: "hermes";
	args: string[];
	/**
	 * Path del usage-file generato da `mkdtemp`, o `null` se mkdtemp è
	 * fallito (in tal caso `--usage-file` è assente da `args` e `warnings`
	 * contiene il messaggio di failure).
	 */
	usageFilePath: string | null;
	/**
	 * Directory temporanea del usage-file (`mkdtemp`), da pulire nel `finally`
	 * del runner. `null` se mkdtemp è fallito.
	 */
	tmpDir: string | null;
	/**
	 * Messaggi di warning da emettere su stderr (dedup a carico del caller).
	 * Includono: (a) mkdtemp failure per usage-file, (b) provider valorizzato
	 * senza model (D126). Empty nel happy path.
	 */
	warnings: string[];
}

/**
 * Costruisce argv + usage-file path per `hermes -z` (M015/S02/R040).
 *
 * Contratto D126 (sintesi): `hermes -z PROMPT --usage-file PATH --yolo
 * [--model M] [--provider P] [--toolsets CSV] [--skills CSV]`. Order argv:
 * `--usage-file <path>` per primo (hermes deve sapere dove scrivere prima di
 * processare il prompt), `--yolo` sempre presente, opzioni condizionali
 * (`--model M`, `--provider P`, `--toolsets CSV`, `--skills CSV`), infine
 * `-z PROMPT` posizionato in coda (il prompt è il valore del flag `-z`,
 * non un argomento posizionale).
 *
 * Funzione pura: nessuno spawn, nessuna scrittura su stderr. I messaggi di
 * warning (mkdtemp failure, provider-without-model) sono accumulati in
 * `warnings[]` e il caller (runner) decide dedup ed emissione. Consente
 * unit test argv diretti senza spawn (`tests/hermes-participant.test.ts`,
 * T03/R047).
 *
 * Provider-without-model D126: hermes CLI rifiuta la combinazione `--provider`
 * senza `--model`. Se `participant.provider` è valorizzato ma `effectiveModel`
 * è vuoto, il flag `--provider` viene omesso da argv e `warnings` contiene
 * il messaggio da emettere (a carico del runner per il dedup una volta per
 * sessione per `participant.name`).
 */
export async function buildHermesInvocation(
	participant: ParticipantConfig,
	promptForThisTurn: string,
	modelOverride?: string,
): Promise<HermesInvocation> {
	const warnings: string[] = [];
	const args: string[] = [];
	let tmpDir: string | null = null;
	let usageFilePath: string | null = null;

	// mkdtemp best-effort: hermes CLI rifiuta `--usage-file <mancante>`.
	try {
		const usageDir = await fs.promises.mkdtemp(
			path.join(os.tmpdir(), `gsd-hermes-usage-${participant.name}-`),
		);
		tmpDir = usageDir;
		usageFilePath = path.join(usageDir, "usage.json");
		args.push("--usage-file", usageFilePath);
	} catch (err) {
		warnings.push(
			`[discussion-arena] warning: runParticipantTurnViaHermes: mkdtemp fallito per usage-file (${participant.name}): ${(err as Error).message}\n`,
		);
	}

	// --yolo sempre presente (D126: approvazioni auto-bypassed).
	args.push("--yolo");

	// model/provider (provider solo se model valorizzato, D126).
	const effectiveModel = modelOverride ?? participant.model;
	let argvProvider = participant.provider;
	if (argvProvider && !effectiveModel) {
		warnings.push(
			`[discussion-arena] warning: runParticipantTurnViaHermes: participant "${participant.name}" ha provider valorizzato ma model assente/vuoto — --provider verra omesso da argv (D126: --provider richiede --model)\n`,
		);
		argvProvider = undefined;
	}
	if (effectiveModel) args.push("--model", effectiveModel);
	if (argvProvider) args.push("--provider", argvProvider);

	// toolsets/skills opzionali (CSV join, speculare a `tools` in `gsd`).
	if (participant.hermesToolsets && participant.hermesToolsets.length > 0) {
		args.push("--toolsets", participant.hermesToolsets.join(","));
	}
	if (participant.hermesSkills && participant.hermesSkills.length > 0) {
		args.push("--skills", participant.hermesSkills.join(","));
	}

	// `-z PROMPT` posizionato in coda (D126 argv order).
	args.push("-z", promptForThisTurn);

	return { command: "hermes", args, usageFilePath, tmpDir, warnings };
}

/**
 * Esegue un turno di un partecipante: riceve il topic/transcript accumulato
 * come task, restituisce il suo intervento testuale.
 *
 * S04/M003: il turno è protetto da due timer indipendenti e da una modalità
 * di terminazione configurabile:
 * - `round_timeout_ms` (`limits.roundTimeoutMs`): cap assoluto del turno,
 *   indipendente dall'attività del subprocess;
 * - `event_watchdog` (`limits.eventTimeoutMs`): nessuna linea JSON parsata su
 *   stdout per la soglia => subprocess in hang;
 * - `termination`: `"soft"` = SIGTERM + 5s grace + SIGKILL, `"hard"` =
 *   SIGKILL immediato (non intercettabile dal processo).
 * Il segnale esterno (cancel gsd-pi) e i due timer confluiscono in un unico
 * `AbortController` combinato: il primo abort vince, gli altri sono no-op
 * (guardo `abortReason` prima di abortire e l'evento `abort` è disperso una
 * sola volta). Il timeout NON lancia: produce un `ParticipantTurnResult` con
 * `failureKind` = `"timeout_round"` | `"timeout_event"`, `failureReason` e
 * `durationMs` (dallo spawn alla chiusura del subprocess). Un abort esterno
 * lascia `failureKind` assente (non è un timeout: il subprocess viene solo
 * terminato, comportamento pre-S04 preservato).
 *
 * S09/T01: un subprocess terminato da un segnale fatale esterno (es.
 * SIGKILL/SIGSEGV/SIGABRT) o uscito con exit code non-zero SENZA che
 * timeout/abort esterno abbiano agito viene classificato come
 * `failureKind = "failed"` con `failureReason` = `"crash <signal>"` |
 * `"crash exit=<code>"` (classificatore SIGKILL). L'ordine dei branch nel
 * listener `close` conta: il timeout prevale sul crash (un timeout che
 * escalation a SIGKILL di hard termination resta un timeout).
 *
 * @param modelOverride se passato, sovrascrive `participant.model` (utile per
 *   il flag `--model` a livello comando che forza un modello per tutta la run).
 * @param limits limiti risolti del partecipante (S04). Parametro opzionale e
 *   retrocompatibile: se omesso usa `DEFAULT_PARTICIPANT_LIMITS` (comportamento
 *   dei call site non ancora aggiornati a S04).
 */
export async function runParticipantTurn(
	participant: ParticipantConfig,
	promptForThisTurn: string,
	cwd: string,
	signal: AbortSignal | undefined,
	modelOverride?: string,
	limits?: ResolvedLimits,
): Promise<ParticipantTurnResult> {
	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	const effectiveModel = modelOverride ?? participant.model;
	if (effectiveModel) args.push("--model", effectiveModel);
	if (participant.tools && participant.tools.length > 0)
		args.push("--tools", participant.tools.join(","));

	// Limiti effettivi: chi non passa `limits` (call site pre-S04) riceve i
	// default — i timer scattano comunque, con le soglie predefinite.
	const resolvedLimits: ResolvedLimits = limits ?? DEFAULT_PARTICIPANT_LIMITS;

	let tmpDir: string | null = null;
	const result: ParticipantTurnResult = {
		participant: participant.name,
		role: participant.role,
		exitCode: 0,
		text: "",
		stderr: "",
		usage: { input: 0, output: 0, cost: 0, turns: 0 },
		durationMs: 0,
	};
	const startedAt = performance.now();

	try {
		if (participant.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(
				participant.name,
				participant.systemPrompt,
			);
			tmpDir = tmp.dir;
			args.push("--append-system-prompt", tmp.filePath);
		}

		args.push(promptForThisTurn);

		const invocation = getGsdInvocation(args);

		const exitCode = await new Promise<number>((resolve, reject) => {
			const proc = spawn(invocation.command, invocation.args, {
				cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});

			let buffer = "";
			let lastAssistantText = "";

			// ── Timer + watchdog + termination (S04/M003) ──────────────────
			// AbortController combinato: fonde il segnale esterno (cancel
			// gsd-pi) con i due timer interni (round_timeout + event_watchdog).
			// Il primo abort vince: l'evento "abort" viene disperso una sola
			// volta e ogni sorgente controlla `abortReason` prima di abortire,
			// quindi un secondo abort (es. round ed event quasi simultanei) è
			// un no-op. La termination (soft/hard) è applicata dall'handler
			// unico `onAbort` — nessuna race tra kill concorrenti.
			const controller = new AbortController();
			let abortReason:
				| "external"
				| "timeout_round"
				| "timeout_event"
				| null = null;
			let closed = false;
			let roundTimer: ReturnType<typeof setTimeout> | undefined;
			let graceTimer: ReturnType<typeof setTimeout> | undefined;
			let watchdogInterval: ReturnType<typeof setInterval> | undefined;
			let externalAbortListener: (() => void) | undefined;

			const abortTurn = (
				reason: "external" | "timeout_round" | "timeout_event",
			) => {
				if (abortReason !== null) return; // secondo abort ignorato
				abortReason = reason;
				controller.abort();
			};

			// kill silenzioso: ESRCH (processo già terminato) non è un errore.
			const safeKill = (sig: NodeJS.Signals) => {
				try {
					proc.kill(sig);
				} catch {
					/* processo già morto — ok */
				}
			};

			const onAbort = () => {
				if (closed) return;
				if (resolvedLimits.termination === "hard") {
					// hard: SIGKILL immediato, non intercettabile dal processo.
					safeKill("SIGKILL");
				} else {
					// soft: SIGTERM, poi grace; se il processo non si chiude da
					// solo entro il grace, escalation a SIGKILL. Se si chiude nel
					// frattempo, il close handler cancella il grace timer e
					// `closed` blocca il SIGKILL (soft termination race).
					safeKill("SIGTERM");
					graceTimer = setTimeout(() => {
						if (closed) return;
						safeKill("SIGKILL");
					}, SOFT_TERMINATION_GRACE_MS);
				}
			};
			controller.signal.addEventListener("abort", onAbort, { once: true });

			// Sorgente 1 — segnale esterno (gsd-pi cancel): se già abortito al
			// momento dello spawn, abort subito; altrimenti sottoscrizione once.
			if (signal) {
				if (signal.aborted) {
					abortTurn("external");
				} else {
					externalAbortListener = () => abortTurn("external");
					signal.addEventListener("abort", externalAbortListener, {
						once: true,
					});
				}
			}

			// Sorgente 2 — round_timeout: cap assoluto dell'intero turno,
			// indipendente dall'attività del subprocess.
			if (resolvedLimits.roundTimeoutMs > 0) {
				roundTimer = setTimeout(
					() => abortTurn("timeout_round"),
					resolvedLimits.roundTimeoutMs,
				);
			}

			// Sorgente 3 — event_watchdog: se non arriva alcuna linea JSON
			// parsata per eventTimeoutMs, il subprocess è in hang. Polling a
			// intervallo (granularità ~max(25ms, eventTimeoutMs/4), capped 500ms)
			// invece di un timeout restartato a ogni evento: più semplice da
			// cancellare e abbastanza preciso anche per soglie piccole.
			let lastEventAt = Date.now();
			if (resolvedLimits.eventTimeoutMs > 0) {
				const pollMs = Math.min(
					500,
					Math.max(25, Math.floor(resolvedLimits.eventTimeoutMs / 4)),
				);
				watchdogInterval = setInterval(() => {
					if (closed) return;
					if (Date.now() - lastEventAt > resolvedLimits.eventTimeoutMs) {
						abortTurn("timeout_event");
					}
				}, pollMs);
			}

			// Cancella tutti i timer alla chiusura/errore: senza questa cleanup
			// i callback proverebbero a killare un processo già morto (ESRCH)
			// e l'interval terrebbe vivo l'event loop inutilmente.
			const clearTimers = () => {
				if (roundTimer) clearTimeout(roundTimer);
				if (graceTimer) clearTimeout(graceTimer);
				if (watchdogInterval) clearInterval(watchdogInterval);
				if (signal && externalAbortListener) {
					signal.removeEventListener("abort", externalAbortListener);
				}
			};

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				// Qualsiasi linea JSON parsata = attività vitale del subprocess:
				// il watchdog viene riarmato a ogni evento.
				lastEventAt = Date.now();

				if (
					event.type === "message_end" &&
					event.message?.role === "assistant"
				) {
					result.usage.turns++;
					const usage = event.message.usage;
					if (usage) {
						result.usage.input += toNumber(usage.input);
						result.usage.output += toNumber(usage.output);
						result.usage.cost += toNumber(usage.cost);
					}
					const textParts = (event.message.content ?? [])
						.filter((c: any) => c.type === "text")
						.map((c: any) => c.text);
					if (textParts.length > 0) lastAssistantText = textParts.join("\n");
				}
			};

			proc.stdout?.on("data", (chunk: Buffer) => {
				buffer += chunk.toString("utf-8");
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) processLine(line);
			});

			proc.stderr?.on("data", (chunk: Buffer) => {
				result.stderr += chunk.toString("utf-8");
			});

			proc.on("error", (err: Error) => {
				// Spawn fallito (es. binario assente): nessun processo da
				// terminare — cancella i timer e propaga l'errore.
				closed = true;
				clearTimers();
				reject(err);
			});

			proc.on("close", (code: number | null, signalName: NodeJS.Signals | null) => {
				closed = true;
				clearTimers();
				if (buffer.trim()) processLine(buffer);
				result.text = lastAssistantText;
				// Il timeout non lancia: emerge come result con failureKind —
				// il consumer (runDiscussionArena, T02) decide il marker.
				if (abortReason === "timeout_round") {
					result.failureKind = "timeout_round";
					result.failureReason = `round timeout superato (${resolvedLimits.roundTimeoutMs} ms)`;
				} else if (abortReason === "timeout_event") {
					result.failureKind = "timeout_event";
					result.failureReason = `nessun evento per ${resolvedLimits.eventTimeoutMs} ms (watchdog)`;
				} else if (abortReason === null && (signalName !== null || code !== 0)) {
					// Classificatore SIGKILL (S09/T01): un subprocess terminato da un
					// segnale fatale esterno (es. SIGKILL/SIGSEGV/SIGABRT — Node passa
					// il nome del segnale come secondo argomento del listener close)
					// o uscito con exit code non-zero senza che timeout/abort esterno
					// abbiano agito viene classificato come crash. Nessun test sul
					// nome letterale del segnale: robusto a qualsiasi fatal signal.
					// L'ordine conta: il branch abortReason (timeout_round/
					// timeout_event) resta PRIMA — un timeout che escalation a SIGKILL
					// di hard termination NON è un crash (il timeout prevale). L'abort
					// esterno (abortReason="external") preserva il comportamento
					// pre-S04: failureKind assente.
					result.failureKind = "failed";
					result.failureReason = signalName
						? `crash ${signalName}`
						: `crash exit=${code}`;
				}
				resolve(code ?? 1);
			});
		});

		result.exitCode = exitCode;
	} finally {
		result.durationMs = performance.now() - startedAt;
		if (tmpDir) {
			await fs.promises
				.rm(tmpDir, { recursive: true, force: true })
				.catch(() => {});
		}
	}

	return result;
}

// ────────────────────────────────────────────────────────────────────────────
// Hermes runner (M015/S02/R040)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Flag module-scope per emissione una volta per sessione del warning
 * provider-without-model (D126). Chiave = participant.name: evita spam stderr
 * anche se la stessa configurazione invalida è presente su più partecipanti
 * nella stessa sessione di gsd-pi.
 */
const providerWarned = new Set<string>();

/**
 * Flag module-scope per emissione una volta per sessione del warning
 * watchdog-skip (D128). Booleano singolo perché il warning è globale per il
 * processo (la scelta di saltare il watchdog per-evento è di design, non
 * per-participant).
 */
let watchdogSkipWarned = false;

/**
 * Lettura best-effort del usage-file prodotto da `hermes -z --usage-file`
 * (M015/S02/D126). Tre fail-mode tollerati silenziosamente:
 *   - ENOENT: file non scritto (hermes non arrivato a scriverlo, oppure mode
 *     `no-usage-file` della fixture di test);
 *   - JSON.parse SyntaxError: file corrotto (mode `corrupt-usage-file`);
 *   - `failed: true` nel JSON: hermes segnala model/provider error
 *     (mode `model-error` della fixture) — non propaga, lascia usage a zero
 *     e lascia che il consumer gestisca `failureKind` separatamente (qui
 *     non propaghiamo l'errore: un fallimento di modello non è un crash del
 *     turno a livello di protocollo).
 *
 * Schema D126 letto (campi tolleranti — assenti/corrotti -> usage a zero):
 *   - `estimated_cost_usd` -> usage.cost
 *   - `input_tokens`       -> usage.input
 *   - `output_tokens`      -> usage.output
 *   - `api_calls`          -> usage.turns
 * Riusa `toNumber()` per la coerci number-string-difensiva (vedi sopra).
 */
export function readHermesUsageFile(
	usageFilePath: string,
	result: ParticipantTurnResult,
): void {
	let raw: string;
	try {
		raw = fs.readFileSync(usageFilePath, "utf-8");
	} catch {
		// ENOENT/EACCES: usage a zero, nessuna stderr aggiuntiva.
		return;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		// JSON corrotto: usage a zero, nessuna stderr aggiuntiva.
		return;
	}
	if (parsed === null || typeof parsed !== "object") {
		return;
	}
	const obj = parsed as Record<string, unknown>;
	// failed:true = model/provider error di hermes (D126 schema). Non
	// propaga: il turno è "completato" dal punto di vista del protocollo,
	// spetta al consumer decidere cosa fare.
	if (obj.failed === true) {
		return;
	}
	result.usage.input += toNumber(obj.input_tokens);
	result.usage.output += toNumber(obj.output_tokens);
	result.usage.cost += toNumber(obj.estimated_cost_usd);
	result.usage.turns += toNumber(obj.api_calls);
}

/**
 * Esegue un turno di un partecipante via `hermes -z` (M015/S02/R040).
 *
 * Contratto D126 (sintesi): `hermes -z PROMPT --usage-file PATH --yolo
 * [--model M] [--provider P] [--toolsets CSV] [--skills CSV]` emette su
 * stdout **solo il testo finale puro** (no JSON, no banner, no spinner). Le
 * approvazioni sono auto-bypassed via `--yolo` (il flag è sempre presente).
 * Il `--usage-file` è opzionale ma sempre richiesto qui (consente di leggere
 * usage anche se hermes fallisce prima di scrivere il testo: lo schema
 * include `failed: true` + `failure.reason` in quel caso, ma questo runner
 * non propaga errori di modello — li segnala come turno "valido ma usage
 * vuoto" lasciando `failureKind` assente).
 *
 * Differenze strutturali rispetto a `runParticipantTurn`:
 * - argv fisso: `-z PROMPT` viene dopo `--usage-file --yolo [--model M]
 *   [--provider P] [--toolsets CSV] [--skills CSV]` (D126 argv order:
 *   flags/config prima, prompt alla fine). Il prompt è l'argomento del flag
 *   `-z`, non un argomento posizionale come in `gsd -p PROMPT`.
 * - stdout accumulato verbatim (no parsing per riga): hermes -z è single-shot
 *   e il buffer è già il payload finale del turno.
 * - watchdog per-evento (D128) **intenzionalmente non implementato**:
 *   hermes -z emette solo il testo finale, quindi non ci sono "eventi"
 *   da monitorare — il rilevamento hang si affida al solo `round_timeout_ms`.
 *   Se `eventTimeoutMs > 0`, viene emesso un warning stderr una volta per
 *   sessione (configurazione tipica: 20-30 min su `round_timeout_ms`).
 * - provider-without-model D126: se `participant.provider` è valorizzato ma
 *   `participant.model` manca (o viene azzerato dal modelOverride), il
 *   `--provider` viene omesso da argv e si emette un warning stderr una
 *   volta per sessione per participant.name (hermes CLI rifiuta la
 *   combinazione).
 *
 * La macchina timer/abort/kill è riutilizzata 1:1 dalla controparte
 * `runParticipantTurn` (combinazione AbortController, safeKill con try/catch
 * ESRCH, SIGTERM+5s+SIGKILL, clearTimers su close/error) — vedi S04/T01.
 * Anche la classificazione failure è identica: `failureKind="timeout_round"`
 * su `abortReason="timeout_round"`, altrimenti `failureKind="failed"` con
 * reason `crash <signal>` | `crash exit=<code>` (classificatore SIGKILL
 * S09/T01).
 *
 * @param modelOverride se passato, sovrascrive `participant.model`.
 * @param limits opzionale; default `DEFAULT_PARTICIPANT_LIMITS`.
 */
export function runParticipantTurnViaHermes(
	participant: ParticipantConfig,
	promptForThisTurn: string,
	cwd: string,
	signal: AbortSignal | undefined,
	modelOverride?: string,
	limits?: ResolvedLimits,
): Promise<ParticipantTurnResult> {
	return (async () => {
	const resolvedLimits: ResolvedLimits = limits ?? DEFAULT_PARTICIPANT_LIMITS;
	const result: ParticipantTurnResult = {
		participant: participant.name,
		role: participant.role,
		exitCode: 0,
		text: "",
		stderr: "",
		usage: { input: 0, output: 0, cost: 0, turns: 0 },
		durationMs: 0,
	};
	const startedAt = performance.now();

	// ── Costruzione argv (D126 order) via builder puro ─────────────────
	// Il builder (buildHermesInvocation) è una funzione async pura che
	// produce args + usageFilePath + tmpDir + warnings[]. Il runner gestisce
	// dedup per sessione (providerWarned) ed emissione stderr (incluso il
	// warning mkdtemp-failure, già rarissimo).
	const invocation = await buildHermesInvocation(
		participant,
		promptForThisTurn,
		modelOverride,
	);
	const { args, usageFilePath, tmpDir } = invocation;

	// Dedup + emit warnings argv-construction. Ordine preservato dall'array:
	// mkdtemp failure prima, provider-without-model dopo. Dedup del
	// provider-without-model per participant.name (module-scope Set,
	// preservato dal refactor T03 per testabilità del builder puro).
	for (const w of invocation.warnings) {
		if (w.includes("provider valorizzato ma model assente")) {
			if (providerWarned.has(participant.name)) continue;
			providerWarned.add(participant.name);
		}
		process.stderr.write(w);
	}

	// D128 — skip watchdog per-evento (intenzionale): hermes -z emette solo
	// il testo finale, non un flusso di eventi JSON. Se il consumatore
	// configura `eventTimeoutMs > 0`, lo ignoriamo ed emettiamo un warning
	// stderr una volta per sessione. Il cap del turno rimane affidato a
	// `round_timeout_ms` (default 300_000 ms = 5 min, configurabile 20-30
	// min per turni pesanti).
	if (resolvedLimits.eventTimeoutMs > 0 && !watchdogSkipWarned) {
		process.stderr.write(
			`[discussion-arena] warning: runParticipantTurnViaHermes: eventTimeoutMs>0 (${resolvedLimits.eventTimeoutMs} ms) ignorato per hermes -z (D128: il runner emette solo testo finale puro, il watchdog per-evento non e applicabile). Configura round_timeout_ms (default 20-30 min) per il cap del turno.\n`,
		);
		watchdogSkipWarned = true;
	}

	try {
		const exitCode = await new Promise<number>((resolve, reject) => {
			const proc = spawn(invocation.command, args, {
				cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});

			let stdoutBuf = "";
			let closed = false;
			let abortReason: "external" | "timeout_round" | "timeout_event" | null = null;
			let roundTimer: ReturnType<typeof setTimeout> | undefined;
			let graceTimer: ReturnType<typeof setTimeout> | undefined;
			let externalAbortListener: (() => void) | undefined;

			const controller = new AbortController();
			const abortTurn = (
				reason: "external" | "timeout_round" | "timeout_event",
			) => {
				if (abortReason !== null) return; // secondo abort ignorato
				abortReason = reason;
				controller.abort();
			};

			const safeKill = (sig: NodeJS.Signals) => {
				try {
					proc.kill(sig);
				} catch {
					/* ESRCH — processo già morto */
				}
			};

			const onAbort = () => {
				if (closed) return;
				if (resolvedLimits.termination === "hard") {
					safeKill("SIGKILL");
				} else {
					safeKill("SIGTERM");
					graceTimer = setTimeout(() => {
						if (closed) return;
						safeKill("SIGKILL");
					}, SOFT_TERMINATION_GRACE_MS);
				}
			};
			controller.signal.addEventListener("abort", onAbort, { once: true });

			// Sorgente 1 — segnale esterno (gsd-pi cancel).
			if (signal) {
				if (signal.aborted) {
					abortTurn("external");
				} else {
					externalAbortListener = () => abortTurn("external");
					signal.addEventListener("abort", externalAbortListener, { once: true });
				}
			}

			// Sorgente 2 — round_timeout (watchdog per-evento omesso: D128).
			if (resolvedLimits.roundTimeoutMs > 0) {
				roundTimer = setTimeout(
					() => abortTurn("timeout_round"),
					resolvedLimits.roundTimeoutMs,
				);
			}

			const clearTimers = () => {
				if (roundTimer) clearTimeout(roundTimer);
				if (graceTimer) clearTimeout(graceTimer);
				if (signal && externalAbortListener) {
					signal.removeEventListener("abort", externalAbortListener);
				}
			};

			proc.stdout?.on("data", (chunk: Buffer) => {
				// D126: hermes -z emette SOLO il testo finale puro. Nessun
				// parsing per riga: il buffer è già il payload del turno.
				stdoutBuf += chunk.toString("utf-8");
			});

			proc.stderr?.on("data", (chunk: Buffer) => {
				result.stderr += chunk.toString("utf-8");
			});

			proc.on("error", (err: Error) => {
				closed = true;
				clearTimers();
				reject(err);
			});

			proc.on("close", (code: number | null, signalName: NodeJS.Signals | null) => {
				closed = true;
				clearTimers();
				result.text = stdoutBuf;
				// Lettura usage-file best-effort post-spawn (D126). Tre
				// fail-mode tollerati silenziosamente (vedi helper).
				if (usageFilePath) {
					readHermesUsageFile(usageFilePath, result);
				}
				// Classificazione failure identica a runParticipantTurn S09/T01:
				// il timeout_round prevale sul crash (un timeout che escalation
				// a SIGKILL di hard termination NON è un crash).
				if (abortReason === "timeout_round") {
					result.failureKind = "timeout_round";
					result.failureReason = `round timeout superato (${resolvedLimits.roundTimeoutMs} ms)`;
				} else if (abortReason === "timeout_event") {
					result.failureKind = "timeout_event";
					result.failureReason = `nessun evento per ${resolvedLimits.eventTimeoutMs} ms (watchdog)`;
				} else if (abortReason === null && (signalName !== null || code !== 0)) {
					result.failureKind = "failed";
					result.failureReason = signalName
						? `crash ${signalName}`
						: `crash exit=${code}`;
				}
				resolve(code ?? 1);
			});
		});

		result.exitCode = exitCode;
	} finally {
		result.durationMs = performance.now() - startedAt;
		if (tmpDir) {
			await fs.promises
				.rm(tmpDir, { recursive: true, force: true })
				.catch(() => {});
		}
	}

	return result;
	})();
}

// ────────────────────────────────────────────────────────────────────────
// M015/S03 — Dispatcher + degradazione marker (D039 seam, R041/R045)
// ────────────────────────────────────────────────────────────────────────

/**
 * Flag module-scope per dedup del warning stderr degradazione hermes→gsd
 * (R045). Chiave = `participant.name`: anche con più partecipanti hermes
 * nella stessa sessione, il warning stderr viene emesso una sola volta per
 * participant. Precedente: `providerWarned` (S02/T03) per il warning
 * provider-without-model di `runParticipantTurnViaHermes`.
 */
const hermesDegradationWarned = new Set<string>();

/**
 * Test seam (S03/M015): binding module-scope che `dispatchParticipantTurn`
 * usa per invocare i runner reali. I test unit sostituiscono i binding via
 * `__setDispatcherRunnersForTest` per mockare i runner senza dover mockare
 * l'intero modulo (impossibile: dispatcher e runner condividono lo stesso
 * lexical environment, e un `t.mock.module` sull'intero run-participant.js
 * sostituirebbe anche il dispatcher). In produzione i binding puntano
 * sempre alle funzioni reali — l'override è solo @internal.
 *
 * @internal
 */
let __dispatcherRunG: typeof runParticipantTurn = runParticipantTurn;
let __dispatcherRunH: typeof runParticipantTurnViaHermes = runParticipantTurnViaHermes;

/** @internal */
export function __setDispatcherRunnersForTest(
	g: typeof runParticipantTurn,
	h: typeof runParticipantTurnViaHermes,
): void {
	__dispatcherRunG = g;
	__dispatcherRunH = h;
}

/** @internal */
export function __resetDispatcherRunnersForTest(): void {
	__dispatcherRunG = runParticipantTurn;
	__dispatcherRunH = runParticipantTurnViaHermes;
	hermesDegradationWarned.clear();
}

/**
 * Dispatcher M015/S03 (R041, R045): chiude il seam D039 iniettando
 * `runParticipantTurnViaHermes` quando `participant.engine === "hermes"` e
 * `hermes` è disponibile nel PATH, cadendo deterministicamente su
 * `runParticipantTurn` (con marker di degradazione + warning stderr una
 * volta per sessione) quando il binario manca. Engine "gsd" o undefined
 * delega direttamente a `runParticipantTurn` (retrocompat pre-M015: i
 * participants esistenti senza `engine` continuano a funzionare invariati).
 *
 * Stessa firma di `RunTurnFn` (index.ts) — il default di `runDiscussionArena`
 * (S03, R041) viene cablato qui in S03.
 *
 * Popola `result.engineMarker` con:
 *   - `'<!-- engine: hermes -->'` quando esegue hermes con successo;
 *   - `'<!-- engine: gsd (degradato da hermes: binario non disponibile) -->'`
 *     in fallback (R045).
 * Assente per engine "gsd"/undefined (retrocompat).
 */
export async function dispatchParticipantTurn(
	participant: ParticipantConfig,
	promptForThisTurn: string,
	cwd: string,
	signal: AbortSignal | undefined,
	modelOverride?: string,
	limits?: ResolvedLimits,
): Promise<ParticipantTurnResult> {
	if (participant.engine === "hermes") {
		if (isHermesAvailable()) {
			const result = await __dispatcherRunH(
				participant,
				promptForThisTurn,
				cwd,
				signal,
				modelOverride,
				limits,
			);
			result.engineMarker = "<!-- engine: hermes -->";
			return result;
		}
		if (!hermesDegradationWarned.has(participant.name)) {
			process.stderr.write(
				`[discussion-arena] ${participant.name}: engine "hermes" richiesto ma binario non disponibile — degradazione a "gsd"\n`,
			);
			hermesDegradationWarned.add(participant.name);
		}
		const result = await __dispatcherRunG(
			participant,
			promptForThisTurn,
			cwd,
			signal,
			modelOverride,
			limits,
		);
		result.engineMarker =
			"<!-- engine: gsd (degradato da hermes: binario non disponibile) -->";
		return result;
	}
	return __dispatcherRunG(
		participant,
		promptForThisTurn,
		cwd,
		signal,
		modelOverride,
		limits,
	);
}
