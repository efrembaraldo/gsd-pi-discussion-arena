/**
 * Status read-only della discussion-arena (M018/S07, T01 — modulo root
 * speculare a viewer.ts/replay.ts/branch.ts/decision.ts, D153: deviazione
 * consapevole da R061 `src/status.ts` per il pattern root-module M018).
 *
 * Espone tre superfici:
 * - `computeStatus(cwd)` — I/O asincrono SOLA LETTURA su
 *   `<cwd>/.gsd/discussion-arena/`; MAI throw (errori come dati:
 *   `unreadableCount` conta i file illeggibili/corrotti, mai eccezioni
 *   verso il caller — failure-mode-as-result, skill api-design);
 * - `formatStatus(report)` — PURA, zero I/O, zero ANSI: stessi dati →
 *   stessa stringa byte-identica (counters ordinati per chiave, nessun
 *   clock); il caller decide la superficie di output;
 * - `StatusReport` — shape machine-readable dell'aggregato (sessioni,
 *   turni, costo, engine, outcomes, health probe, metriche, paths).
 *
 * Fonti (TUTTE sotto `<cwd>/.gsd/discussion-arena/`, NESSUN parent-directory
 * traversal — D154: il "walk-up" D007 è interpretato come scansione
 * strettamente project-local):
 * 1. `transcripts/*.md` — sessioni; sort per mtime desc, CAP 20 (D007) con
 *    `truncated: true`; turni = occorrenze dell'header canonico `### Round `;
 *    engine dal marker `<!-- engine: hermes -->` (run-participant.ts) o dal
 *    prefisso degradato `<!-- engine: gsd` — tutto il resto è `unknown`.
 * 2. `events/*.jsonl` — per file: `readEvents` (helpers.ts) + `extractReplayMetrics`
 *    (replay.ts, riuso 1:1) → `totalCostUsd` (somma dei costi terminali per
 *    sessione) e distribuzione outcomes.
 * 3. `health.json` — via `readHealthSnapshot` (src/discussion-arena-health-probe.ts,
 *    già mai-throw): `failureCount = 1` solo se lo snapshot esiste e l'ultimo
 *    esito NON è `success` (semantica "ultimo esito", D154 — NON è un contatore
 *    storico dei fallimenti).
 * 4. `metrics.json` — consumer read-only con validazione minimale della shape
 *    `MetricsSnapshot` di src/metrics.ts (NESSUN writer nel repo): assente o
 *    malformato → `present: false` (malformato incrementa anche
 *    `unreadableCount`).
 *
 * Questo modulo non scrive nulla, non lancia subprocess e non produce output
 * diretto (né stdout né log): la presentazione è demandata a `formatStatus` +
 * caller.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { DiscussionArenaEvent } from "./helpers.js";
import { readEvents } from "./helpers.js";
import { extractReplayMetrics } from "./replay.js";
import { readHealthSnapshot } from "./src/discussion-arena-health-probe.js";

/** CAP canonico D007: al massimo le 20 sessioni modificate più di recente. */
export const STATUS_TRANSCRIPT_CAP = 20;

/**
 * Report machine-readable dello stato della discussion-arena di un cwd.
 * Conteggi `0` e flag `present: false` sono VALORI VALIDI (cwd vuoto),
 * non errori: gli errori di lettura emergono solo come `unreadableCount`.
 */
export interface StatusReport {
	/** Numero di sessioni transcript LEGGE con successo (max 20, D007). */
	sessionCount: number;
	/** Totale turni (`### Round `) sui transcript letti. */
	turnCount: number;
	/** Somma dei costi terminali per sessione (USD, da extractReplayMetrics). */
	totalCostUsd: number;
	/** Distribuzione engine dai marker transcript. */
	engines: { gsd: number; hermes: number; unknown: number };
	/** Distribuzione outcomes terminali dai log eventi (ultimo write vince). */
	outcomes: { complete: number; partial: number; unknown: number };
	/** Health probe persistente (`health.json`). */
	health: {
		present: boolean;
		lastOutcome: string | null;
		/** 1 se lo snapshot esiste e lastOutcome ≠ "success", altrimenti 0 (D154). */
		failureCount: number;
		tierFingerprint?: unknown;
		path: string;
	};
	/** Metriche strutturate (`metrics.json`), consumer read-only. */
	metrics: {
		present: boolean;
		path: string;
		counters?: Record<string, Record<string, number>>;
	};
	/** Paths osservabili, SEMPRE valorizzati anche su assenza dei file. */
	paths: {
		transcriptsDir: string;
		eventsDir: string;
		healthPath: string;
		metricsPath: string;
	};
	/** true se c'erano più transcript del cap 20 (D007). */
	truncated: boolean;
	/** File transcript/event-log illeggibili o metrics.json malformati. */
	unreadableCount: number;
}

/**
 * Conta le occorrenze dell'header round canonico `### Round ` nel body di un
 * transcript (stessa convenzione di `reconstructTranscript` in replay.ts).
 */
function countRounds(transcriptBody: string): number {
	let count = 0;
	let idx = transcriptBody.indexOf("### Round ");
	while (idx !== -1) {
		count++;
		idx = transcriptBody.indexOf("### Round ", idx + 1);
	}
	return count;
}

/** Classifica il marker engine di un transcript (marker canonici di run-participant.ts). */
function classifyEngine(transcriptBody: string): "gsd" | "hermes" | "unknown" {
	if (transcriptBody.includes("<!-- engine: hermes -->")) return "hermes";
	// Prefisso (non match esatto): copre il marker degradato
	// `<!-- engine: gsd (degradato da hermes: binario non disponibile) -->`.
	if (transcriptBody.includes("<!-- engine: gsd")) return "gsd";
	return "unknown";
}

/** Valida minimalmente la shape `counters` di `MetricsSnapshot` (src/metrics.ts). */
function isValidCounters(value: unknown): value is Record<string, Record<string, number>> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	for (const inner of Object.values(value)) {
		if (inner === null || typeof inner !== "object" || Array.isArray(inner)) return false;
		for (const v of Object.values(inner)) {
			if (typeof v !== "number" || !Number.isFinite(v)) return false;
		}
	}
	return true;
}

/** Result interno del passo transcript: file idonei ordinati per mtime desc. */
interface TranscriptFile {
	name: string;
	mtimeMs: number;
}

/**
 * Aggrega i transcript markdown sotto `<cwd>/.gsd/discussion-arena/transcripts/`
 * (cap 20 per mtime desc, D007). Ritorna i conteggi parziali; gli errori di
 * readdir (directory assente) producono un insieme vuoto, NON un throw.
 */
async function aggregateTranscripts(
	transcriptsDir: string,
	unreadable: { count: number },
): Promise<{
	sessionCount: number;
	turnCount: number;
	engines: StatusReport["engines"];
	truncated: boolean;
}> {
	const engines: StatusReport["engines"] = { gsd: 0, hermes: 0, unknown: 0 };
	const empty = { sessionCount: 0, turnCount: 0, engines, truncated: false };

	let names: string[];
	try {
		names = await fs.readdir(transcriptsDir);
	} catch {
		return empty; // directory assente (cwd vergine) o non attraversabile: zero dati, nessun errore
	}
	const mdNames = names.filter((n) => n.endsWith(".md"));

	const files: TranscriptFile[] = [];
	for (const name of mdNames) {
		try {
			const st = await fs.stat(path.join(transcriptsDir, name));
			files.push({ name, mtimeMs: st.mtimeMs });
		} catch {
			unreadable.count++;
		}
	}
	// mtime desc (ultime sessioni modificate), tie-break per nome asc (determinismo).
	files.sort((a, b) => (b.mtimeMs - a.mtimeMs) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

	const truncated = files.length > STATUS_TRANSCRIPT_CAP;
	const selected = files.slice(0, STATUS_TRANSCRIPT_CAP);

	let turnCount = 0;
	let sessionCount = 0;
	for (const file of selected) {
		let body: string;
		try {
			body = await fs.readFile(path.join(transcriptsDir, file.name), "utf-8");
		} catch {
			unreadable.count++;
			continue; // transcript illeggibile: contabilizzato, mai fatale
		}
		sessionCount++;
		turnCount += countRounds(body);
		engines[classifyEngine(body)]++;
	}

	return { sessionCount, turnCount, engines, truncated };
}

/**
 * Aggrega gli event log JSONL sotto `<cwd>/.gsd/discussion-arena/events/`
 * riusando 1:1 `readEvents` (helpers.ts) + `extractReplayMetrics` (replay.ts).
 * File corrotto o illeggibile → `unreadableCount`, mai throw.
 */
async function aggregateEvents(
	eventsDir: string,
	unreadable: { count: number },
): Promise<{ totalCostUsd: number; outcomes: StatusReport["outcomes"] }> {
	const outcomes: StatusReport["outcomes"] = { complete: 0, partial: 0, unknown: 0 };
	let totalCostUsd = 0;

	let names: string[];
	try {
		names = await fs.readdir(eventsDir);
	} catch {
		return { totalCostUsd, outcomes }; // directory assente: zero dati
	}
	// Ordine deterministico per nome: la somma dei costi è riproducibile.
	const jsonlNames = names.filter((n) => n.endsWith(".jsonl")).sort();

	for (const name of jsonlNames) {
		const events: DiscussionArenaEvent[] = [];
		try {
			for await (const ev of readEvents(path.join(eventsDir, name))) {
				events.push(ev);
			}
		} catch {
			unreadable.count++; // errore I/O non-ENOENT su un log: contabilizzato, mai fatale
			continue;
		}
		const metrics = extractReplayMetrics(events);
		totalCostUsd += metrics.restoredCost;
		outcomes[metrics.restoredOutcome]++;
	}

	return { totalCostUsd, outcomes };
}

/** Shape tollerante di `health.json` letta da `readHealthSnapshot`. */
async function aggregateHealth(cwd: string, healthPath: string): Promise<StatusReport["health"]> {
	const snapshot = await readHealthSnapshot(cwd); // già mai-throw (null su assente/corrotto)
	const present = snapshot !== null;
	return {
		present,
		lastOutcome: present ? snapshot.lastOutcome : null,
		// Semantica "ultimo esito" (D154): 1 se l'ultimo esito noto non è
		// "success"; 0 se è "success" o se non c'è alcuno snapshot.
		failureCount: present && snapshot.lastOutcome !== "success" ? 1 : 0,
		tierFingerprint: present ? snapshot.tierFingerprint : undefined,
		path: healthPath,
	};
}

/** Legge e valida minimalmente `metrics.json` (consumer read-only, nessun writer nel repo). */
async function aggregateMetrics(
	metricsPath: string,
	unreadable: { count: number },
): Promise<StatusReport["metrics"]> {
	let raw: string;
	try {
		raw = await fs.readFile(metricsPath, "utf-8");
	} catch {
		// Assente (ENOENT) o illeggibile: nessuna metrica disponibile.
		// L'assenza NON è un errore → unreadableCount invariato.
		return { present: false, path: metricsPath };
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (
			parsed !== null &&
			typeof parsed === "object" &&
			isValidCounters((parsed as { counters?: unknown }).counters)
		) {
			return { present: true, path: metricsPath, counters: (parsed as { counters: Record<string, Record<string, number>> }).counters };
		}
	} catch {
		// JSON malformato: gestione condivisa col ramo shape-invalida sotto.
	}
	unreadable.count++; // presente ma malformato/shape-invalida: contabilizzato
	return { present: false, path: metricsPath };
}

/**
 * Calcola lo stato read-only della discussion-arena di `cwd`. MAI throw:
 * ogni sorgente è letta in modo tollerante e gli errori emergono SOLO come
 * dati (`unreadableCount`, `present: false`, conteggi a zero). Le fonti sono
 * ESCLUSIVAMENTE sotto `<cwd>/.gsd/discussion-arena/` — nessun
 * parent-directory traversal (D154); i `paths` sono valorizzati anche quando
 * i file non esistono.
 *
 * @param cwd - working directory di progetto (assoluta o relativa; usata così com'è)
 */
export async function computeStatus(cwd: string): Promise<StatusReport> {
	const baseDir = path.join(cwd, ".gsd", "discussion-arena");
	const paths = {
		transcriptsDir: path.join(baseDir, "transcripts"),
		eventsDir: path.join(baseDir, "events"),
		healthPath: path.join(baseDir, "health.json"),
		metricsPath: path.join(baseDir, "metrics.json"),
	};

	// Contatore condiviso dei file illeggibili/corrotti (errori come dati).
	const unreadable = { count: 0 };

	const transcripts = await aggregateTranscripts(paths.transcriptsDir, unreadable);
	const eventsAgg = await aggregateEvents(paths.eventsDir, unreadable);
	const health = await aggregateHealth(cwd, paths.healthPath);
	const metrics = await aggregateMetrics(paths.metricsPath, unreadable);

	return {
		sessionCount: transcripts.sessionCount,
		turnCount: transcripts.turnCount,
		totalCostUsd: eventsAgg.totalCostUsd,
		engines: transcripts.engines,
		outcomes: eventsAgg.outcomes,
		health,
		metrics,
		paths,
		truncated: transcripts.truncated,
		unreadableCount: unreadable.count,
	};
}

/**
 * Formatta un `StatusReport` in testo leggibile. PURA: zero I/O, zero ANSI,
 * zero dipendenza dal clock — lo stesso report produce SEMPRE la stessa
 * stringa (le chiavi dei counters sono iterate in ordine canonico). Il
 * failure counter della health probe è SEMPRE visibile, anche a 0; la sezione
 * metriche mostra esplicitamente `non disponibili (<path>)` quando il file è
 * assente o malformato (mai silenzio — skill observability).
 */
export function formatStatus(report: StatusReport): string {
	const lines: string[] = [];

	lines.push("Discussion Arena status");
	lines.push(`Sessions: ${report.sessionCount}`);
	lines.push(`Turns: ${report.turnCount}`);
	lines.push(`Cost: $${report.totalCostUsd.toFixed(4)}`);
	if (report.truncated) {
		lines.push(
			`(showing the latest ${STATUS_TRANSCRIPT_CAP} sessions by mtime — older sessions not counted)`,
		);
	}

	const engines = report.engines;
	lines.push(
		`Engine distribution: gsd ${engines.gsd}, hermes ${engines.hermes}, unknown ${engines.unknown}`,
	);

	const outcomes = report.outcomes;
	lines.push(
		`Outcomes: complete ${outcomes.complete}, partial ${outcomes.partial}, unknown ${outcomes.unknown}`,
	);

	const health = report.health;
	const healthLines = [
		`Health probe: ${health.present ? "present" : "not present"}`,
		`last outcome: ${health.lastOutcome ?? "n/a"}`,
		`failures: ${health.failureCount} (1 if the last known outcome is not "success")`,
	];
	lines.push(healthLines.join(", "));

	if (report.metrics.present && report.metrics.counters !== undefined) {
		const counterLines: string[] = [];
		for (const name of Object.keys(report.metrics.counters).sort()) {
			const inner = report.metrics.counters[name] ?? {};
			const parts: string[] = [];
			for (const key of Object.keys(inner).sort()) {
				parts.push(`${key}=${inner[key]}`);
			}
			counterLines.push(`  ${name}: ${parts.join(", ")}`);
		}
		// Il path è incluso anche nel ramo "presente": l'osservatore sa sempre
		// DOVE si trova la fonte letta (skill observability — mai silenzio).
		lines.push(`Metriche strutturate (${report.metrics.path}):`);
		lines.push(...counterLines);
	} else {
		lines.push(`Metriche strutturate: non disponibili (${report.metrics.path})`);
	}

	lines.push("Paths:");
	lines.push(`  transcripts: ${report.paths.transcriptsDir}`);
	lines.push(`  events: ${report.paths.eventsDir}`);
	lines.push(`  health: ${report.paths.healthPath}`);
	lines.push(`  metrics: ${report.paths.metricsPath}`);

	return lines.join("\n");
}
