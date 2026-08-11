/**
 * Agent Discussion Arena — estensione gsd-pi
 *
 * Aggiunge un tool `discussion_arena` che l'agente attivo (in qualsiasi
 * fase del ciclo auto: researching, planning, executing, verifying...) può
 * invocare per far discutere N partecipanti con ruoli/competenze definiti
 * dall'utente, per K round, e ricevere il transcript risultante come testo
 * da usare nella propria risposta.
 *
 * Punto chiave architetturale: gsd-pi resta il coordinatore. Questo tool
 * non lancia un processo parallelo indipendente — viene chiamato come
 * qualsiasi altro tool DALL'agente che gsd-pi sta già eseguendo nella unit
 * corrente. L'orchestratore di auto mode (resolveDispatch, orchestrator.ts)
 * non sa nulla della discussion-arena: vede solo una tool call che dura
 * più a lungo, esattamente come vedrebbe una bash o una web-search.
 *
 * Formato dei partecipanti: vedi participants.ts — file .md con frontmatter
 * in .gsd/discussion-arena/participants/ (progetto) o
 * ~/.gsd/agent/discussion-arena/participants/ (utente). Compatibile 1:1 con
 * le persona portate da BMAD-METHOD.
 */

import { Type } from "typebox";
import * as path from "node:path";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@gsd/pi-coding-agent";
import {
	discoverParticipants,
	type ParticipantConfig,
} from "./participants.js";
import {
	runParticipantTurn,
	type ParticipantTurnResult,
} from "./run-participant.js";
import {
	accumulateCost,
	resolveParticipantLimits,
	DEFAULT_PARTICIPANT_LIMITS,
	shouldSkipParticipant,
	formatFailureMarker,
	truncateOutput,
	type ParticipantLimitsInput,
	type ResolvedLimits,
	type FailureKind,
} from "./helpers.js";
import {
	getSessionFilePath,
	loadSession,
	saveSession,
	type DiscussionArenaSession,
} from "./discussion-arena-session.js";
import {
	resolveTrigger,
	resolveTriggerWithLogging,
	type ResolveTriggerInput,
	type ResolveTriggerOutput,
	type PreferencesConfig,
} from "./trigger-resolver.js";
import { attachArenaHooks } from "./src/hooks-planning.js";
import { attachArenaWizard, type WizardWriteTarget } from "./src/tui-wizard.js";
import { writeArenaPreference } from "./src/preferences-writer.js";

export const MAX_PARTICIPANTS = 8;
export const MAX_ROUNDS = 5;
export const DEFAULT_ROUNDS = 2;

const ArenaParamsSchema = Type.Object({
	topic: Type.String({
		description:
			"Il tema/domanda su cui i partecipanti devono discutere o su cui devono deliberare.",
	}),
	participants: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Nomi dei partecipanti da coinvolgere (devono corrispondere a un file .md in .gsd/discussion-arena/participants/, ~/.gsd/agent/discussion-arena/participants/ o ai partecipanti bundled dell'estensione). Se omesso, vengono usati tutti i partecipanti disponibili.",
		}),
	),
	rounds: Type.Optional(
		Type.Integer({
			description: `Numero di round di discussione (ogni partecipante vede il transcript dei round precedenti). Default ${DEFAULT_ROUNDS}, massimo ${MAX_ROUNDS}.`,
			minimum: 1,
			maximum: MAX_ROUNDS,
		}),
	),
	contTopic: Type.Optional(
		Type.String({
			description:
				"(solo command) Path del file di sessione esistente da cui continuare (--continue). Se omesso, si cerca la sessione per il topic nel cwd.",
		}),
	),
	model: Type.Optional(
		Type.String({
			description:
				"(solo command) Modello che sovrascrive participant.model per tutti i turn di questa sessione.",
		}),
	),
	roundTimeoutMs: Type.Optional(
		Type.Number({
			description:
				`Timeout massimo (ms) per il completamento di un round da parte di un partecipante. Sovrascrive il frontmatter del partecipante (round_timeout_ms) e il default (${DEFAULT_PARTICIPANT_LIMITS.roundTimeoutMs} ms). Solo calcolato/loggato in questa fase, nessun enforcement.`,
			minimum: 1,
		}),
	),
	eventTimeoutMs: Type.Optional(
		Type.Number({
			description:
				`Timeout massimo (ms) tra un evento e il successivo (watchdog) durante un turno partecipante. Sovrascrive il frontmatter del partecipante (event_timeout_ms) e il default (${DEFAULT_PARTICIPANT_LIMITS.eventTimeoutMs} ms). Solo calcolato/loggato in questa fase, nessun enforcement.`,
			minimum: 1,
		}),
	),
	outputLimitChars: Type.Optional(
		Type.Number({
			description:
				`Limite massimo di caratteri per l'output di un partecipante prima della troncatura. Sovrascrive il frontmatter del partecipante (output_limit_chars) e il default (${DEFAULT_PARTICIPANT_LIMITS.outputLimitChars} char). Solo calcolato/loggato in questa fase, nessun enforcement.`,
			minimum: 1,
		}),
	),
	costBudgetUsd: Type.Optional(
		Type.Number({
			description:
				`Budget massimo in USD per i turn di un partecipante. Sovrascrive il frontmatter del partecipante (cost_budget_usd) e il default ($${DEFAULT_PARTICIPANT_LIMITS.costBudgetUsd}). Solo calcolato/loggato in questa fase, nessun enforcement.`,
			minimum: 0,
		}),
	),
	termination: Type.Optional(
		Type.Union([Type.Literal("soft"), Type.Literal("hard")], {
			description:
				`Modalità di terminazione al superamento di una soglia ("soft" = degradazione controllata, "hard" = interruzione immediata). Sovrascrive il frontmatter del partecipante (termination) e il default ("${DEFAULT_PARTICIPANT_LIMITS.termination}"). Solo calcolato/loggato in questa fase, nessun enforcement.`,
		}),
	),
});

function formatParticipantList(participants: ParticipantConfig[]): string {
	if (participants.length === 0) return "(nessun partecipante configurato)";
	return participants
		.map((p) => `- ${p.name} (${p.role}): ${p.description}`)
		.join("\n");
}

/**
 * Tronca il transcript a `maxBytes` mantenendo i round più recenti e scartando
 * i più vecchi. Necessario per evitare `spawn E2BIG` quando il transcript
 * cresce oltre il limite argv (tipicamente ~2MB su Linux, ~256KB su macOS)
 * a causa di --continue che appende round o topic con risposte molto lunghe.
 * Il transcript completo viene comunque salvato su disco dalla sessione, quindi
 * la troncatura è solo per il prompt — l'utente può sempre rileggere la
 * versione integrale dal file di sessione.
 */
function truncateTranscriptForPrompt(
	transcript: string,
	maxBytes: number = 100_000,
): string {
	if (transcript.length <= maxBytes) return transcript;
	const re = /\n\n(?=### Round \d+)/g;
	const parts: string[] = [];
	let lastIdx = 0;
	let m: RegExpExecArray | null;
	while ((m = re.exec(transcript)) !== null) {
		parts.push(transcript.slice(lastIdx, m.index));
		lastIdx = m.index + 2;
	}
	parts.push(transcript.slice(lastIdx));

	let kept = "";
	for (let i = parts.length - 1; i >= 0; i--) {
		const candidate = parts.slice(i).join("\n\n");
		if (candidate.length <= maxBytes) {
			kept = candidate;
			break;
		}
	}
	if (!kept) {
		// Singolo round più grande del budget: tronca l'ultimo blocco.
		kept =
			"[...troncato per limite prompt...]\n\n" +
			parts[parts.length - 1]!.slice(-(maxBytes - 100));
	} else {
		kept = "[...round più vecchi omessi per limite prompt...]\n\n" + kept;
	}
	return kept;
}

export function buildRoundPrompt(
	topic: string,
	roundIndex: number,
	transcript: string,
	participant: ParticipantConfig,
): string {
	if (roundIndex === 0) {
		return [
			`Tema della discussione: ${topic}`,
			``,
			`Sei ${participant.name} (${participant.role}). Esprimi la tua posizione iniziale, basandoti esclusivamente sulla tua competenza. Sii specifico e conciso — niente premesse generiche.`,
		].join("\n");
	}
	return [
		`Tema della discussione: ${topic}`,
		``,
		`Transcript finora:`,
		transcript,
		``,
		`Sei ${participant.name} (${participant.role}). Rispondi agli altri partecipanti dal tuo punto di vista: dove concordi, dove dissenti e perché, cosa aggiungeresti. Sii specifico e conciso.`,
	].join("\n");
}

/**
 * Parsing argomenti del comando. Pura, testabile. Restituisce le opzioni
 * strutturate oppure null se manca il topic (per mostrare usage).
 *
 * Formato: <topic> [N rounds] [--continue|--new] [--model <id>]
 * Il topic può contenere spazi; --model accetta il token successivo come
 * valore; --continue/--new sono flag standalone; l'ultimo token numerico
 * non consumato da --model è rounds.
 */
export interface ParsedCommandArgs {
	topic: string;
	rounds: number;
	continueSession: boolean;
	explicitNew: boolean;
	modelOverride: string | undefined;
}

export function parseCommandArgs(
	rawArgs: string,
	defaults: { rounds: number },
): ParsedCommandArgs | null {
	const rawTokens = rawArgs.trim().split(/\s+/).filter(Boolean);
	let continueSession = false;
	let explicitNew = false;
	let modelOverride: string | undefined;
	const topicTokens: string[] = [];
	let rounds = defaults.rounds;

	for (let i = 0; i < rawTokens.length; i++) {
		const t = rawTokens[i]!;
		if (t === "--continue" || t === "-c") {
			continueSession = true;
		} else if (t === "--new") {
			explicitNew = true;
		} else if (t === "--model" || t === "-m") {
			const value = rawTokens[i + 1];
			if (value && !value.startsWith("--")) {
				modelOverride = value;
				i++;
			}
		} else if (
			topicTokens.length === 0 &&
			/^\d+$/.test(t) &&
			i === rawTokens.length - 1
		) {
			const parsed = parseInt(t, 10);
			if (Number.isFinite(parsed) && parsed >= 1) {
				rounds = Math.min(parsed, MAX_ROUNDS);
			}
		} else {
			topicTokens.push(t);
		}
	}

	const lastTopic = topicTokens[topicTokens.length - 1];
	if (lastTopic && /^\d+$/.test(lastTopic)) {
		const parsed = parseInt(lastTopic, 10);
		if (Number.isFinite(parsed) && parsed >= 1) {
			rounds = Math.min(parsed, MAX_ROUNDS);
			topicTokens.pop();
		}
	}

	const topic = topicTokens.join(" ").trim();
	if (!topic) return null;
	return { topic, rounds, continueSession, explicitNew, modelOverride };
}

/**
 * Seleziona i partecipanti da coinvolgere nella discussion-arena: se
 * `requestedNames` è fornito e non vuoto, filtra `all` per quei nomi (scartando
 * i nomi senza corrispondenza); altrimenti usa tutti i partecipanti disponibili.
 * In ogni caso applica il cap MAX_PARTICIPANTS troncando la selezione.
 * Funzione pura, nessun I/O — estratta da runDiscussionArena per essere
 * testabile direttamente (D020).
 */
export function selectParticipants(
	all: ParticipantConfig[],
	requestedNames: string[] | undefined,
): ParticipantConfig[] {
	let selected: ParticipantConfig[];
	if (requestedNames && requestedNames.length > 0) {
		selected = requestedNames
			.map((name) => all.find((p) => p.name === name))
			.filter((p): p is ParticipantConfig => Boolean(p));
	} else {
		selected = all;
	}
	if (selected.length > MAX_PARTICIPANTS) {
		selected = selected.slice(0, MAX_PARTICIPANTS);
	}
	return selected;
}

/**
 * Risolve i `ResolvedLimits` di un partecipante applicando la precedenza
 * `toolParams > frontmatter (participant.limits) > defaults` (S02/M003).
 * Funzione pura — nessun I/O, nessun enforcement: il chiamante (S04/S05/S06)
 * decide come applicare i limiti risolti. `resolveParticipantLimits` fa la
 * validazione/merge vera e propria (helpers.ts, S01); qui ci limitiamo a
 * cablare l'input `participant.limits` (frontmatter, sempre presente — vedi
 * participants.ts) con i `toolParams` (dal tool `discussion_arena`).
 */
export function resolveParticipantLimitsForParticipant(
	participant: ParticipantConfig,
	toolParams: ParticipantLimitsInput,
	defaults: ResolvedLimits = DEFAULT_PARTICIPANT_LIMITS,
): ResolvedLimits {
	return resolveParticipantLimits(toolParams, participant.limits ?? {}, defaults);
}

/**
 * Firma del turno-runner: identica a `runParticipantTurn` (run-participant.ts).
 * Iniettabile in `runDiscussionArena` (S03/M003, D022/D020) per permettere ai
 * test di mockare l'esecuzione di un turno senza spawnare un subprocess `gsd`
 * reale. Default = `runParticipantTurn` vero (comportamento di produzione).
 */
export type RunTurnFn = (
	participant: ParticipantConfig,
	promptForThisTurn: string,
	cwd: string,
	signal: AbortSignal | undefined,
	modelOverride?: string,
	limits?: ResolvedLimits,
) => Promise<ParticipantTurnResult>;

/**
 * Loop centrale della discussion-arena, reso resiliente al crash parziale di
 * un partecipante (S03/M003). Stato "morti" locale alla chiamata (non
 * persistito — la persistenza dell'event-log arriva in S07): prima di ogni
 * turno consulta `shouldSkipParticipant` (helpers.ts, S01) e, se il
 * partecipante è già morto, emette `[PARTICIPANT SKIPPED: <id>]` senza
 * invocare `runTurn`. Se `runTurn` lancia/rigetta per un partecipante vivo,
 * lo marca morto ("failed") ed emette `[PARTICIPANT FAILED: <id> <reason>
 * <timestamp>]` — il round prosegue con gli altri partecipanti vivi. Se al
 * termine di un round tutti i partecipanti selezionati risultano morti, il
 * ciclo dei round si interrompe (nessun round successivo viene eseguito).
 * `outcome` è `"partial"` se almeno un partecipante è morto, altrimenti
 * `"complete"`.
 */
export async function runDiscussionArena(
	topic: string,
	requestedNames: string[] | undefined,
	rounds: number,
	cwd: string,
	signal: AbortSignal | undefined,
	onProgress: (partialTranscript: string) => void,
	onRoundComplete?: (
		roundIndex: number,
		cumulativeTranscript: string,
		totalCost: number,
	) => void,
	continuation?: { transcript: string; roundOffset: number },
	modelOverride?: string,
	toolLimits?: ParticipantLimitsInput,
	runTurn: RunTurnFn = runParticipantTurn,
): Promise<{
	transcript: string;
	participantsUsed: string[];
	totalCost: number;
	outcome: "complete" | "partial";
}> {
	const { participants: all } = discoverParticipants(cwd);

	const selected = selectParticipants(all, requestedNames);

	if (selected.length === 0) {
		const available = all.map((p) => p.name).join(", ") || "nessuno";
		throw new Error(
			`Nessun partecipante valido trovato. Disponibili: ${available}. ` +
				`Definisci ruoli in .gsd/discussion-arena/participants/*.md o ~/.gsd/agent/discussion-arena/participants/*.md.`,
		);
	}

	// Limiti per-partecipante (tool > frontmatter > defaults, S02/M003): calcolati
	// una sola volta prima del loop dei round (toolLimits è costante per tutta
	// l'arena) e loggati su stderr — predispone la superficie che S04/S05/S06
	// useranno per l'enforcement effettivo (S02 non introduce enforcement).
	const resolvedLimitsByParticipant = new Map<string, ResolvedLimits>();
	for (const participant of selected) {
		const limits = resolveParticipantLimitsForParticipant(
			participant,
			toolLimits ?? {},
		);
		resolvedLimitsByParticipant.set(participant.name, limits);
		process.stderr.write(
			`[discussion-arena] limits ${participant.name}: ${JSON.stringify(limits)}\n`,
		);
	}

	let transcript = continuation?.transcript ?? "";
	const roundOffset = continuation?.roundOffset ?? 0;
	let totalCost = 0;
	// Stato locale (D043/ArenaState.morti compatibile) dei partecipanti morti
	// durante questa chiamata — non persistito tra chiamate (S03 non introduce
	// persistenza, arriva in S07).
	const morti = new Map<string, FailureKind>();
	// Costo cumulato per partecipante (S06/M003): Map<string, number> locale
	// per chiamata, aggiornata dopo ogni turno riuscito (il turno che fa
	// scattare il budget guard paga il suo costo). Dato grezzo per S08
	// (arena_cost_usd{participant}); non persistito tra chiamate (S07).
	const costByParticipant = new Map<string, number>();

	for (let round = 0; round < rounds; round++) {
		const turnsThisRound: string[] = [];

		// Sequenziale di proposito: ogni partecipante nel round vede gli
		// interventi gia' dati dagli altri nello stesso round (dialogo reale,
		// non N risposte indipendenti). Per un dibattito realmente
		// simultaneo (nessuno vede gli altri nel round corrente) invertire
		// l'ordine: costruire tutti i prompt del round prima di eseguirli e
		// lanciarli con Promise.all.
		for (const participant of selected) {
			const { skip } = shouldSkipParticipant({ morti }, participant.name);
			if (skip) {
				const entry = `### Round ${round + 1 + roundOffset} — ${participant.name} (${participant.role})\n${formatFailureMarker(
					"skipped",
					participant.name,
				)}`;
				turnsThisRound.push(entry);
				onProgress(transcript + "\n\n" + turnsThisRound.join("\n\n"));
				continue;
			}

			// Tronca il transcript prima di passarlo al prompt per evitare
			// E2BIG su argv quando --continue accumula molti round.
			const fullContext = transcript + turnsThisRound.join("\n\n");
			const promptContext = truncateTranscriptForPrompt(fullContext);
			const prompt = buildRoundPrompt(topic, round, promptContext, participant);

			let turn: ParticipantTurnResult;
			try {
				turn = await runTurn(
					participant,
					prompt,
					cwd,
					signal,
					modelOverride,
					// Limiti risolti per-partecipante (S04): soglie di timeout e
					// modalità di terminazione che runParticipantTurn applica ai
					// timer round/event. Opzionale e retrocompatibile: un mock
					// che non lo dichiara compila invariato.
					resolvedLimitsByParticipant.get(participant.name),
				);
			} catch (err) {
				const reason = err instanceof Error ? err.message : String(err);
				const timestamp = new Date().toISOString();
				morti.set(participant.name, "failed");
				const entry = `### Round ${round + 1 + roundOffset} — ${participant.name} (${participant.role})\n${formatFailureMarker(
					"failed",
					participant.name,
					reason,
					timestamp,
				)}`;
				turnsThisRound.push(entry);
				onProgress(transcript + "\n\n" + turnsThisRound.join("\n\n"));
				continue;
			}

			// Estrazione del costo centralizzata in accumulateCost (fix §4.1,
			// S06/M003): gestisce usage.cost come number | string | {total},
			// clamp >= 0 e tollera null/undefined — resiliente a future fonti
			// che bypassano il toNumber interno di run-participant.ts (es.
			// replay event log S07). Sostituisce l'estrazione inline
			// `totalCost += turn.usage.cost` (index.ts:462).
			totalCost = accumulateCost(turn.usage, totalCost);
			// Costo per partecipante: aggiornato QUI (prima del budget guard)
			// così costByParticipant riflette il costo reale fino al momento
			// dell'exhaustion — il turno che fa scattare il guard è contato.
			costByParticipant.set(
				participant.name,
				accumulateCost(turn.usage, costByParticipant.get(participant.name) ?? 0),
			);

			// Timeout watchdog (S04/M003): runParticipantTurn non lancia per i
			// timeout — produce un result con `failureKind` = "timeout_round" |
			// "timeout_event" (primo abort vinto tra round/event/external). Il
			// marker canonico [TIMEOUT: <id> round_timeout|event_watchdog <ts>]
			// sostituisce il testo del turno e il partecipante è marcato morto:
			// nei round successivi il loop di resilienza di S03 lo salta
			// ([PARTICIPANT SKIPPED: <id>]) e l'outcome diventa "partial".
			if (
				turn.failureKind === "timeout_round" ||
				turn.failureKind === "timeout_event"
			) {
				const timestamp = new Date().toISOString();
				morti.set(participant.name, turn.failureKind);
				const entry = `### Round ${round + 1 + roundOffset} — ${participant.name} (${participant.role})\n${formatFailureMarker(
					turn.failureKind,
					participant.name,
					undefined,
					timestamp,
				)}`;
				turnsThisRound.push(entry);
				onProgress(transcript + "\n\n" + turnsThisRound.join("\n\n"));
				continue;
			}

			// Post-processing del turno (S05/M003): troncatura dell'output a
			// `outputLimitChars` (da ResolvedLimits, S02) con marker di coda
			// `[OUTPUT TRUNCATED at N chars]` (helper puro S01). L'over-limit
			// NON è un crash: il turno resta completo, il partecipante non
			// entra in `morti` (continua ai round successivi) e `outcome` resta
			// determinato dal crash tracking di S03. Il marker distingue
			// l'over-limit da crash (FAILED) e timeout (TIMEOUT) ed è la
			// superficie di osservabilità di S05 (regex-matchabile da S08/S09).
			const limits = resolvedLimitsByParticipant.get(participant.name);
			let outputText = turn.text || "(nessuna risposta)";
			if (limits && turn.text && turn.text.length > limits.outputLimitChars) {
				try {
					outputText = truncateOutput(turn.text, limits.outputLimitChars).text;
				} catch {
					// Guard (helper S01): outputLimitChars < lunghezza del marker —
					// config non utilizzabile per la troncatura. Il testo passa
					// integro: over-limit non è mai un crash, il turno resta
					// completo e il partecipante non muore.
					process.stderr.write(
						`[discussion-arena] warning: outputLimitChars=${limits.outputLimitChars} < marker length, troncatura saltata per ${participant.name}\n`,
					);
				}
			}
			// Budget guard (S06/M003): se il costo cumulato del partecipante ha
			// raggiunto/superato costBudgetUsd il turno termina con il marker
			// canonico [BUDGET EXHAUSTED: <id> at round <N> <ts>], il
			// partecipante è marcato morto ("budget_exhausted") e nei round
			// successivi il loop di resilienza S03 lo salta ([PARTICIPANT
			// SKIPPED: <id>]) con outcome "partial". Il guard è DOPO la
			// troncatura S05 (l'over-limit resta un successo; l'over-budget è
			// una failure distinta — ordine pinnato dal test combinato) e
			// PRIMA della costruzione dell'entry (il marker sostituisce il
			// testo del turno). Condizione `cost > 0 && cost >= limit`: per
			// budget=0 (clamp S02 a min:0) un turno a costo zero non fa
			// scattare il guard — non c'è costo da proteggere.
			const participantCost = costByParticipant.get(participant.name) ?? 0;
			if (
				limits &&
				participantCost > 0 &&
				participantCost >= limits.costBudgetUsd
			) {
				const timestamp = new Date().toISOString();
				morti.set(participant.name, "budget_exhausted");
				const entry = `### Round ${round + 1 + roundOffset} — ${participant.name} (${participant.role})\n${formatFailureMarker(
					"budget_exhausted",
					participant.name,
					`at round ${round + 1 + roundOffset}`,
					timestamp,
				)}`;
				turnsThisRound.push(entry);
				onProgress(transcript + "\n\n" + turnsThisRound.join("\n\n"));
				continue;
			}
			const entry = `### Round ${round + 1 + roundOffset} — ${participant.name} (${participant.role})\n${outputText}`;
			turnsThisRound.push(entry);
			onProgress(transcript + "\n\n" + turnsThisRound.join("\n\n"));
		}

		transcript += (transcript ? "\n\n" : "") + turnsThisRound.join("\n\n");
		onRoundComplete?.(round + 1 + roundOffset, transcript, totalCost);

		// Se tutti i partecipanti selezionati sono morti al termine di questo
		// round, non ha senso eseguire round successivi (nessuno risponderebbe).
		const allDead = selected.every((p) => morti.has(p.name));
		if (allDead) break;
	}

	return {
		transcript,
		participantsUsed: selected.map((p) => p.name),
		totalCost,
		outcome: morti.size > 0 ? "partial" : "complete",
	};
}

export default function activate(api: ExtensionAPI) {
	// Get a placeholder context for testing purposes; in production, the hooks
	// themselves don't need cwd directly, but we pass it for API consistency.
	// This will be called synchronously once at extension load time.
	const placeholderCtx: ExtensionContext = {
		cwd: process.cwd(),
		// Other properties will be undefined but that's fine since we don't use them
	} as ExtensionContext;

	// Resolve the trigger decision for discussion-arena auto-mode injection.
	// This is synchronous using env var and PREFERENCES.md checking.
	// We'll call resolveTrigger() now to set up the hooks with the decision.
	// NOTE: This is async but we call it without awaiting for now as a fire-and-forget.
	// In a real scenario, activate() might be async or we defer to first-use.
	// For testing, we initialize eagerly with the current decision.
	resolveTrigger({
		cwd: placeholderCtx.cwd,
		milestoneId: process.env.GSD_MILESTONE_ID ?? "unknown",
		env: process.env,
	})
		.then((triggerResult) => {
			// Attach arena hooks with the resolved trigger decision
			attachArenaHooks(api, placeholderCtx, triggerResult);
		})
		.catch((err) => {
			// Log error but don't block extension activation
			const msg = err instanceof Error ? err.message : String(err);
			process.stderr.write(
				`[discussion-arena] error resolving trigger during activate: ${msg}\n`,
			);
		});

	// Milestone-start TUI wizard: lets the user pick the activation strategy
	// (per-milestone / always-on / availability-only) when a TUI is present.
	// writePreferences derives the canonical PREFERENCES.md path from the
	// event cwd and delegates to the atomic writer (D025).
	attachArenaWizard(api, placeholderCtx, async (target: WizardWriteTarget) => {
		const prefsPath = path.join(target.cwd, ".gsd", "PREFERENCES.md");
		await writeArenaPreference(prefsPath, {
			mode: target.mode,
			milestoneId: target.milestoneId,
		});
	});

	api.registerTool({
		name: "discussion_arena",
		label: "Discussion Arena",
		description:
			"Fa discutere più partecipanti (ruoli/competenze definiti dall'utente in .gsd/discussion-arena/participants/) su un tema per N round, e restituisce il transcript. Usalo quando la fase corrente beneficia di prospettive multiple e dedicate (es. valutare un'architettura, un trade-off di design, un piano di rischio) prima di procedere.",
		promptSnippet:
			"discussion_arena — consiglio di agenti con ruoli configurabili per deliberare su un tema",
		promptGuidelines: [
			"Usa discussion_arena quando una decisione beneficia di più punti di vista specializzati invece di un'unica risposta.",
			"Non usarlo per compiti puramente esecutivi (scrivere codice, eseguire comandi) — è pensato per discussione e deliberazione, non per implementazione.",
		],
		parameters: ArenaParamsSchema,
		execute: async (
			_toolCallId,
			params,
			signal,
			onUpdate,
			ctx: ExtensionContext,
		) => {
			const rounds = Math.min(params.rounds ?? DEFAULT_ROUNDS, MAX_ROUNDS);
			// Limiti a livello tool (S02/M003): precedenza massima nel merge
			// tool > frontmatter > defaults applicato da runDiscussionArena per
			// ogni partecipante selezionato. Campi omessi restano `undefined`,
			// così il merge scende al livello frontmatter/default.
			const toolLimits: ParticipantLimitsInput = {
				roundTimeoutMs: params.roundTimeoutMs,
				eventTimeoutMs: params.eventTimeoutMs,
				outputLimitChars: params.outputLimitChars,
				costBudgetUsd: params.costBudgetUsd,
				termination: params.termination,
			};
			try {
				const { transcript, participantsUsed, totalCost, outcome } =
					await runDiscussionArena(
						params.topic,
						params.participants,
						rounds,
						ctx.cwd,
						signal,
						(partial) => {
							onUpdate?.({
								content: [{ type: "text", text: partial || "(in corso...)" }],
								details: { participantsUsed: [], totalCost: 0, rounds },
							});
						},
						undefined,
						undefined,
						undefined,
						toolLimits,
					);

				// Persistenza anche per il tool (oltre che per il command): l'agente
				// puo' fare sessioni continue invocando piu' volte con --continue
				// via params.contTopic (futuro) o riaprendo la sessione salvata.
				// Per ora salvataggio semplice su file cwd-relative.
				const sessionPath = getSessionFilePath(ctx.cwd, params.topic);
				const existing = await loadSession(sessionPath);
				const now = new Date().toISOString();
				const session: DiscussionArenaSession = {
					topic: params.topic,
					participants: participantsUsed,
					startedAt: existing?.startedAt ?? now,
					lastUpdatedAt: now,
					rounds,
					transcript,
				};
				await saveSession(sessionPath, session).catch((err) => {
					// Non fatale: la run è riuscita, solo persistenza fallita
					process.stderr.write(
						`[discussion-arena] warning: impossibile salvare sessione in ${sessionPath}: ${err instanceof Error ? err.message : err}\n`,
					);
				});

				return {
					content: [
						{
							type: "text",
							text: `## Discussion Arena — "${params.topic}"\nPartecipanti: ${participantsUsed.join(", ")} | Round: ${rounds} | Costo totale stimato: $${totalCost.toFixed(4)} | Esito: ${outcome}\n\n${transcript}\n\nSession salvata: ${sessionPath}`,
						},
					],
					details: { participantsUsed, totalCost, rounds, outcome },
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [
						{
							type: "text",
							text: `Errore nell'esecuzione della discussion-arena: ${message}`,
						},
					],
					details: { participantsUsed: [], totalCost: 0, rounds },
				};
			}
		},
	});

	api.registerCommand("discussion-arena", {
		description:
			"Avvia una Discussion Arena: /discussion-arena <topic> [N rounds] [--continue|--new] [--model <id>]",
		handler: async (args, ctx) => {
			const { participants } = discoverParticipants(ctx.cwd);

			const parsed = parseCommandArgs(args, { rounds: DEFAULT_ROUNDS });
			if (!parsed) {
				await ctx.ui.notify(
					`Partecipanti disponibili:\n${formatParticipantList(participants)}\n\nUso: /discussion-arena <topic> [N rounds] [--continue|--new] [--model <id>]`,
				);
				return;
			}

			const sessionPath = getSessionFilePath(ctx.cwd, parsed.topic);
			const existing =
				parsed.continueSession && !parsed.explicitNew
					? await loadSession(sessionPath)
					: null;

			if (parsed.continueSession && !existing) {
				await ctx.ui.notify(
					`Nessuna sessione esistente per "${parsed.topic}" — avvio da zero.`,
				);
			}

			const continuation = existing
				? { transcript: existing.transcript, roundOffset: existing.rounds }
				: undefined;
			const totalRoundsToRun = parsed.rounds + (existing?.rounds ?? 0);

			const modelInfo = parsed.modelOverride
				? `, modello forzato: ${parsed.modelOverride}`
				: "";

			await ctx.ui.notify(
				`Avvio discussion-arena su: "${parsed.topic}" — ${participants.length} partecipanti, ${parsed.rounds} round(s) da eseguire (totale sessione: ${totalRoundsToRun})${modelInfo}.`,
			);

			const { transcript, participantsUsed, totalCost, outcome } =
				await runDiscussionArena(
					parsed.topic,
					undefined,
					parsed.rounds,
					ctx.cwd,
					undefined,
					() => {},
					async (roundIndex, cumulative, cost) => {
						await ctx.ui.notify(
							`[Round ${roundIndex} di ${totalRoundsToRun} completato — costo cumulato $${cost.toFixed(4)}]\n\n${cumulative}`,
						);
					},
					continuation,
					parsed.modelOverride,
				);

			const now = new Date().toISOString();
			const session: DiscussionArenaSession = {
				topic: parsed.topic,
				participants: participantsUsed,
				startedAt: existing?.startedAt ?? now,
				lastUpdatedAt: now,
				rounds: totalRoundsToRun,
				transcript,
			};
			await saveSession(sessionPath, session);

			await ctx.ui.notify(
				`Discussion arena completata (esito: ${outcome}) — ${participantsUsed.join(", ")} — ${totalRoundsToRun} round(s) totali (${parsed.rounds} nuovi) — costo cumulato $${totalCost.toFixed(4)}.\n\nSession salvata: ${sessionPath}\n\nTranscript finale:\n\n${transcript}`,
			);
		},
	});
}
