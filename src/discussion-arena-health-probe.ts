/**
 * src/discussion-arena-health-probe.ts — Health probe per il lock pending-research (M013/S02).
 *
 * Modulo DEDICATO (NON inline in `withPendingResearchLock`) per tre ragioni:
 *
 * 1. **Separazione observability/locking** — il modulo `discussion-arena-pending-research.ts`
 *    gestisce già 4 pattern critici (atomic write, lock file, stale recovery, render JSON);
 *    aggiungere un quinto blocco di side-effect ne aumenta la complessità cognitiva.
 *
 * 2. **Test isolati** — il probe è testabile in unità senza dover mockare l'intero
 *    lock cross-process: la firma sincrona `recordPendingResearchOutcome(args)` riceve
 *    tutti gli outcome come parametri e li propaga a 3 superfici.
 *
 * 3. **Riuso futuro** — altri call site (es. `milestone_end` ingestion di M015) possono
 *    chiamare lo stesso helper senza dover dipendere dal lock file.
 *
 * Le 3 superfici osservative sono attivate ad ogni write pending-research:
 *
 * - **(a) Stderr plain + NDJSON** — `LOG_PREFIX + " pending-research: <outcome> (<durationMs>ms)"`
 *   (grep umano-friendly) + una riga NDJSON `{ts, level: "info", event:
 *   "health_probe.pending_research", outcome, durationMs, lockHeld, tierFingerprint, cwd}`
 *   consumabile da pino/winston lato agent. `cwd` è omesso dal NDJSON se assente.
 *
 * - **(b) Health.json atomico** — `<cwd>/.gsd/discussion-arena/health.json` con snapshot
 *   cumulativo `HealthSnapshot` (write-then-rename riusando lo stesso pattern di
 *   `writeFileAtomicPending`, MEM195). Lo snapshot propaga `lastWriteTimestamp` del write
 *   precedente (idempotenza byte-per-byte): due chiamate con `outcome` identico producono
 *   contenuto serializzato identico → la 2ª chiamata viene saltata (no fsync/rename).
 *
 * - **(c) Counter + Histogram** — `recordPendingResearchWrite(outcome, durationMs)` di T01
 *   registra `pending_research_writes_total{outcome}` e `pending_research_write_duration_ms{outcome}`
 *   con bucket dedicati `PENDING_RESEARCH_DURATION_BUCKETS_MS = [10, 50, 100, 500, 1000, 5000]`.
 *
 * Tutti i side-effect I/O (stderr, file) sono wrapped in un singolo `try/catch` (D022 +
 * MEM117): ogni failure diventa un log di errore `probe emit failed: <err>` sullo stream,
 * MAI un'eccezione propagata. La metrica `recordPendingResearchWrite` è chiamata SYNCHRONOUSLY
 * FUORI dal try/catch globale (è in-memory, immune a failure I/O): così il test "best-effort"
 * trova la telemetria aggiornata SUBITO anche se log o file falliscono asincronamente.
 *
 * `recordPendingResearchOutcome` è sincrona (`void`, no Promise esposta). L'operazione async
 * di I/O su `health.json` viene accodata in una chain interna serializzata (`emitChain`):
 * le emissioni sono ordinate in FIFO senza esposizione di promise al caller. La chain
 * cattura TUTTE le rejection con `.catch()`, senza mai loggarle come unhandled.
 *
 * Coerente con:
 * - D004 — zero deps (solo `node:fs/promises`, `node:path`, moduli locali).
 * - D022 + MEM117 — side-effect best-effort, mai propagazione.
 * - MEM195 — pattern `write-then-rename` condiviso con `writeFileAtomicPending`.
 * - T01/M013/S02 — helper `recordPendingResearchWrite` in `src/metrics.ts`.
 */

import { open, rename, mkdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import { recordPendingResearchWrite } from "./metrics.js";
import { LOG_PREFIX } from "./log-prefix.js";

/**
 * Nome del file health snapshot, sotto `<cwd>/.gsd/discussion-arena/`. Esportato
 * come costante per consentire ai test di calcolare il path assoluto e per future
 * CLI di dump (`gsd discussion-arena health`) di identificare il file canonico.
 */
export const HEALTH_JSON_FILENAME = "health.json";

/**
 * Fingerprint della classificazione Tier effettuata sul workspace al momento
 * del write pending-research. `tier` è uno dei 4 valori (F/A/D/unknown)
 * con `reasons` come lista di codici diagnostici (`no_GSD_VERSION`,
 * `missing_capability:<id>`, ecc.). Vedi M013-CONTEXT per il modello di
 * classificazione completo.
 */
export interface TierFingerprint {
	tier: "F" | "A" | "D" | "unknown";
	reasons: string[];
}

/**
 * Snapshot cumulativo dello stato di salute del write pending-research,
 * persistito atomicamente su `<cwd>/.gsd/discussion-arena/health.json`. È il
 * CONTRATTO verso tooling esterno (CLI dump, dashboard, snapshot validation).
 *
 * Campi:
 * - `lastWriteTimestamp` — ISO 8601 del write andato a buon fine. Propagato
 *   dalle scritture precedenti per idempotenza byte-per-byte (due write con
 *   outcome identico e stesso workspace producono serializzazione identica).
 * - `lastOutcome` — esito del lock all'ultima emissione: `success`/`timeout`/`fail`.
 * - `lockHeld` — true se al momento dell'emit il caller riteneva di possedere
 *   ancora il lock (informativo; tipicamente false perché `withPendingResearchLock`
 *   ha già rilasciato quando il probe viene chiamato).
 * - `pendingResearchWritten` — true SOLO per `outcome === "success"`. Per
 *   timeout/fail il file pending-research NON è stato scritto, e questo campo
 *   riflette fedelmente la mancata scrittura (non mascherata da false-positive).
 * - `tierFingerprint` — classificazione Tier del workspace al momento del write.
 */
export interface HealthSnapshot {
	lastWriteTimestamp: string;
	lastOutcome: "success" | "timeout" | "fail";
	lockHeld: boolean;
	pendingResearchWritten: boolean;
	tierFingerprint: TierFingerprint;
}

/**
 * Args di `recordPendingResearchOutcome`. `cwd` è opzionale: se assente, lo
 * snapshot su disco NON viene scritto (solo log stderr + metrica). `stderr`
 * è opzionale e permette ai test di redirezionare il flusso; default
 * `process.stderr`. `cwd` viene inoltre propagato al NDJSON quando presente.
 */
export interface RecordPendingResearchOutcomeArgs {
	outcome: "success" | "timeout" | "fail";
	durationMs: number;
	lockHeld: boolean;
	tierFingerprint: TierFingerprint;
	cwd?: string;
	stderr?: NodeJS.WritableStream;
}

/**
 * Chain interna serializzata per le emissioni async di `health.json`. Garantisce
 * che le emissioni siano processate in ordine FIFO (la successiva attende la
 * risoluzione della precedente), così due `recordPendingResearchOutcome` consecutivi
 * sullo stesso workspace non fanno race sul read-then-write di `lastWriteTimestamp`.
 *
 * `Promise.resolve()` come seed → la chain è sempre risolta al primo `.then()`.
 * `.catch()` finale assorbe QUALSIASI rejection (incluso un rejection di lettura
 * file, mkdir, write, rename) senza propagarla come unhandled rejection.
 */
let emitChain: Promise<void> = Promise.resolve();

/**
 * Risolve quando TUTTE le emissioni di `health.json` accodate fino a questo
 * momento sono state completate (atomic write andato a buon fine oppure errore
 * intercettato dal `.catch()` interno). **NON** espone la promise raw della
 * chain (che resta mutabile); espone solo una view deterministica del suo
 * stato al momento della chiamata.
 *
 * Marcato `@internal` perché è un helper di determinismo per i test di unit:
 * senza questo, le asserzioni su `health.json` dopo `recordPendingResearchOutcome`
 * sarebbero race-y (l'atomic write avviene in un microtask successivo al return
 * sincrono della funzione). I test fanno `await flushPendingHealthEmits()` per
 * stabilizzare lo stato del file system prima di asserire.
 *
 * In produzione NON serve: nessun call site di `recordPendingResearchOutcome`
 * dipende dal completamento della write atomic di `health.json` per rilasciare
 * il lock o procedere (è fire-and-forget by design).
 *
 * @internal
 */
export async function flushPendingHealthEmits(): Promise<void> {
	await emitChain;
}

/**
 * Legge e parsa lo snapshot di health persistente su `<cwd>/.gsd/discussion-arena/health.json`.
 * Ritorna `null` se il file è assente (ENOENT) o se il parsing fallisce — ENTRAMBI i casi
 * sono considerati "stato iniziale non ancora popolato" e non sono errori. Un throw sul
 * parsing sarebbe fuorviante per un file corrotto scritto da una versione precedente.
 */
export async function readHealthSnapshot(cwd: string): Promise<HealthSnapshot | null> {
	try {
		const healthPath = path.join(cwd, ".gsd", "discussion-arena", HEALTH_JSON_FILENAME);
		const raw = await readFile(healthPath, "utf-8");
		const parsed = JSON.parse(raw) as Partial<HealthSnapshot>;
		if (
			typeof parsed.lastWriteTimestamp !== "string" ||
			(parsed.lastOutcome !== "success" &&
				parsed.lastOutcome !== "timeout" &&
				parsed.lastOutcome !== "fail") ||
			typeof parsed.lockHeld !== "boolean" ||
			typeof parsed.pendingResearchWritten !== "boolean" ||
			!parsed.tierFingerprint ||
			typeof parsed.tierFingerprint !== "object"
		) {
			return null;
		}
		return parsed as HealthSnapshot;
	} catch {
		return null;
	}
}

/**
 * Scrittura atomica (write-then-rename) per `health.json`. Riusa lo stesso pattern di
 * `writeFileAtomicPending` (linea 117 di `discussion-arena-pending-research.ts`) per
 * coerenza MEM195: temp file nella stessa directory → fsync → rename → fsync della
 * directory best-effort. Il prefisso `.health.` distingue i temp file da quelli
 * pending-research (`.pending-research.`) e da altri domini futuri.
 *
 * `mkdir(dir, { recursive: true })` rende la funzione idempotente anche su prima
 * invocazione (la `.gsd/discussion-arena/` non esiste). Il `fsync` della directory
 * è best-effort: alcuni filesystem (es. FAT, alcuni overlay FS) non lo supportano —
 * in tal caso viene silenzemente ignorato, perché il `rename` è già durevole
 * sulla maggior parte dei filesystem POSIX.
 */
export async function writeFileAtomicHealth(
	filePath: string,
	content: string,
): Promise<void> {
	const dir = path.dirname(filePath);
	await mkdir(dir, { recursive: true });
	const tmp = path.join(
		dir,
		`.health.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`,
	);
	const fh = await open(tmp, "w");
	try {
		await fh.writeFile(content, "utf-8");
		await fh.sync();
	} finally {
		await fh.close();
	}
	await rename(tmp, filePath);
	// Best-effort dir fsync.
	let dh: Awaited<ReturnType<typeof open>> | undefined;
	try {
		dh = await open(dir, "r");
		await dh.sync();
	} catch {
		/* ignora — rename già durevole sulla maggior parte dei filesystem */
	} finally {
		await dh?.close().catch(() => {});
	}
}

/**
 * Funzione principale del probe — entry point per i 3 punti di emissione di
 * `withPendingResearchLock` (success/timeout/fail).
 *
 * **Sincrona** (`void`, no Promise esposta) — il caller NON deve attendere il probe
 * per rilasciare il lock o procedere. Quattro step in ordine:
 *
 * 1. **Log stderr plain text** — `LOG_PREFIX + " pending-research: <outcome> (<durationMs>ms)"`
 *    per grep umano-friendly. Sempre emesso se `stderr.write` non fallisce.
 * 2. **Log stderr NDJSON** — riga singola `{ts, level: "info", event: "health_probe.pending_research", ...}`
 *    consumabile da pino/winston.
 * 3. **Metriche in-memory** — `recordPendingResearchWrite(outcome, durationMs)` di T01.
 *    SYNCHRONOUSLY, FUORI dal try/catch globale, PRIMA dell'operazione async di I/O su
 *    `health.json`. La telemetria sopravvive a failure di log o file.
 * 4. **Atomic write health.json** — `cwd/.gsd/discussion-arena/health.json`, IDEMPOTENTE
 *    (legge lo snapshot esistente per propagare `lastWriteTimestamp` e short-circuit
 *    se il contenuto serializzato è byte-identico). Fire-and-forget serializzato via
 *    `emitChain`; ogni failure intercettata da `.catch()` diventa `probe emit failed: ...`
 *    sullo stderr, MAI un'eccezione propagata o unhandled rejection.
 */
export function recordPendingResearchOutcome(
	args: RecordPendingResearchOutcomeArgs,
): void {
	const stderr = args.stderr ?? process.stderr;

	// (1) Log stderr plain text — grep umano-friendly.
	// Formato: "[discussion-arena] pending-research: success (5ms)"
	try {
		stderr.write(
			`${LOG_PREFIX} pending-research: ${args.outcome} (${args.durationMs}ms)\n`,
		);
	} catch {
		/* stderr.write non dovrebbe mai lanciare; ignora */
	}

	// (2) Log stderr NDJSON — `{ts, level: "info", event: "health_probe.pending_research", ...}`.
	// `cwd` viene omesso dal NDJSON se assente (campi undefined sono omessi da JSON.stringify
	// se l'oggetto è built come literal, ma con `exactOptionalPropertyTypes` TS rimuove il campo).
	const ndjsonFields: Record<string, unknown> = {
		ts: new Date().toISOString(),
		level: "info",
		event: "health_probe.pending_research",
		outcome: args.outcome,
		durationMs: args.durationMs,
		lockHeld: args.lockHeld,
		tierFingerprint: args.tierFingerprint,
	};
	if (args.cwd !== undefined) {
		ndjsonFields.cwd = args.cwd;
	}
	try {
		stderr.write(`${JSON.stringify(ndjsonFields)}\n`);
	} catch {
		/* ignora errori di logging */
	}

	// (3) Metriche SYNCHRONOUSLY — FUORI dal try/catch globale (telemetria immune a I/O failure).
	recordPendingResearchWrite(args.outcome, args.durationMs);

	// (4) Atomic write health.json — fire-and-forget serializzato. Errori → stderr, mai propagati.
	if (args.cwd !== undefined) {
		const cwd = args.cwd;
		emitChain = emitChain
			.then(async () => {
				const healthPath = path.join(
					cwd,
					".gsd",
					"discussion-arena",
					HEALTH_JSON_FILENAME,
				);
				// Propaga `lastWriteTimestamp` dallo snapshot esistente: due write con
				// outcome identico e stesso workspace producono contenuto serializzato
				// identico → la 2ª chiamata viene short-circuitata (nessun rename, fsync).
				const existing = await readHealthSnapshot(cwd);
				const lastWriteTimestamp =
					existing?.lastWriteTimestamp ?? new Date().toISOString();
				const snapshot: HealthSnapshot = {
					lastWriteTimestamp,
					lastOutcome: args.outcome,
					lockHeld: args.lockHeld,
					pendingResearchWritten: args.outcome === "success",
					tierFingerprint: args.tierFingerprint,
				};
				const content = `${JSON.stringify(snapshot, null, 2)}\n`;

				// Confronto byte-per-byte con il contenuto esistente: se identico, skip
				// write+fsync+rename (l'outcome OS-level è "file on disk invariato").
				let existingRaw: string | null = null;
				try {
					existingRaw = await readFile(healthPath, "utf-8");
				} catch {
					existingRaw = null;
				}
				if (content !== existingRaw) {
					await writeFileAtomicHealth(healthPath, content);
				}
			})
			.catch((err: unknown) => {
				try {
					stderr.write(
						`${LOG_PREFIX} pending-research: probe emit failed: ${String(err)}\n`,
					);
				} catch {
					/* ignora — nessuna telemetria se anche lo stderr è rotto */
				}
			});
	}
}
