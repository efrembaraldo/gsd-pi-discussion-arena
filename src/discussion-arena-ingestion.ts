/**
 * src/discussion-arena-ingestion.ts — Ingestion idempotente dei
 * pending-research verso gli intent di salvataggio GSD (M008/S04, T02).
 *
 * Dopo che la discussion_arena ha prodotto `pending-research.json` (M008/S03)
 * e l'utente/orchestratore ha approvato il gate research-decision, l'ingestion
 * flow legge la struttura estratta e produce per ogni voce un *intent* di
 * salvataggio:
 *   - ogni `requirement` → intento per gsd_requirement_save;
 *   - ogni `decision`    → intento per gsd_decision_save.
 *
 * Il modulo è DECOUPLED dalla firma vera dei tool GSD: riceve due adapter
 * iniettati `saveRequirement` / `saveDecision` che traducono l'intent (shape
 * stabile dell'extractor: requirement {id?, title, description, priority},
 * decision {statement, rationale?, dissent?}) nella firma esatta del tool
 * (che può evolvere). Così la logica qui accoppiata è il contratto stabile
 * dell'estrazione, non la firma del tool. Il default di produzione
 * (`createFileOutboxAdapters`) accoda l'intent su un outbox file
 * (`ingestion-outbox.jsonl`) nella stessa directory dei pending: un
 * "handoff" durevole che l'orchestratore/harness converte nelle chiamate
 * reali a gsd_requirement_save / gsd_decision_save (in questo ambiente le
 * chiamate reali ai tool sono eseguite dall'harness/agente, non dall'estensione)
 * — l'outbox garantisce che nessun intent vada perso.
 *
 * Proprietà contrattuali:
 *   - Idempotente: un registro `ingestion-ledger.json` nella stessa
 *     directory dei pending memorizza le chiavi delle voci già ingerite
 *     (requirement: chiave = `id` se presente, altrimenti hash stabile di
 *     `title`+`description`; decision: chiave = hash stabile della
 *     `statement`). Al ri-run le voci già nel ledger vengono saltate →
 *     nessun duplicato su gsd_requirement_save / gsd_decision_save.
 *   - Chiave stabile e deterministica: buildIngestionPlan è pura (nessun
 *     timestamp), quindi ripetere l'ingest sullo stesso file produce le
 *     stesse chiavi → idempotenza reale anche tra processi.
 *   - Best-effort, mai throw: un errore su un adapter (vuoi timeout, vuoi
 *     scrittura fallita) viene catturato; la chiave NON viene aggiunta al
 *     ledger (così un ri-trial la ripesca), la voce finisce in `errors`.
 *     Le altre voci continuano e il ledger viene comunque aggiornato.
 *   - Nessun file pending → no-op silenzioso ma log stderr diagnostico.
 *   - File pending malformato (JSON invalido / version != 1 / structured
 *     assente) → mai throw: log stderr diagnostico, nessuna voce.
 *   - Osservabilità: log stderr strutturato per ogni voce ingerita
 *     `ingestion: requirement saved <id>` / `ingestion: decision saved
 *     <statement-truncated>` (prefisso LOG_PREFIX canonico D053), più i log
 *     di skip/no-op/error.
 *   - Svuotamento: `clearIngestionLedger(cwd)` azzera il registro (per i
 *     test e per un eventuale refresh esplicito).
 *
 * Zero nuove dipendenze runtime (D004): solo node:fs/promises e node:path.
 */

import * as fs from "node:fs";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { LOG_PREFIX } from "./log-prefix.js";
import {
	PENDING_RESEARCH_JSON_FILENAME,
	writeFileAtomicPending,
} from "./discussion-arena-pending-research.js";
import {
	DISCUSSION_ARENA_COORDINATION_DIR,
	DISCUSSION_ARENA_COORDINATION_FILENAME,
	loadDiscussionArenaCoordination,
	type DiscussionArenaCoordinationConfig,
} from "./discussion-arena-coordination.js";
import type {
	ResearchDecisions,
	RequirementItem,
	DecisionItem,
	RequirementPriority,
} from "./discussion-arena-research-extractor.js";

/** Prefisso canonico delle chiavi requisito nel ledger. */
const REQ_KEY_PREFIX = "req";
/** Prefisso canonico delle chiavi decisione nel ledger. */
const DEC_KEY_PREFIX = "dec";

/** Nome del file JSON di registro di idempotenza dell'ingestion. */
export const INGESTION_LEDGER_FILENAME = "ingestion-ledger.json";

/** Nome del file outbox (default adapter) con gli intenti da salvare. */
export const INGESTION_OUTBOX_FILENAME = "ingestion-outbox.jsonl";

/** Priorità accettate dall'extractor per un requisito. */
type Priority = RequirementPriority;

/** Intent di salvataggio di un requisito (firma stabile dell'extractor). */
export interface RequirementIngestionIntent {
	/** Identificativo opzionale (R1, REQ-1...). La chiave di idempotenza usa
	 * `id` se presente, altrimenti un hash stabile di title+description. */
	id?: string;
	/** Titolo del requisito. */
	title: string;
	/** Descrizione dettagliata (vuota se non fornita). */
	description: string;
	/** Priorità normalizzata. */
	priority: Priority;
}

/** Intent di salvataggio di una decisione (firma stabile dell'extractor). */
export interface DecisionIngestion {
	/** Enunciato della decisione (statement). */
	statement: string;
	/** Rationale opzionale. */
	rationale?: string;
	/** Dissensi/obiezioni opzionali. */
	dissent?: string[];
}

/** Adapter che traduce un requisito nell'invocazione a gsd_requirement_save. */
export type SaveRequirementAdapter = (
	intent: RequirementIngestionIntent,
) => Promise<unknown>;

/** Adapter che traduce una decisione nell'invocazione a gsd_decision_save. */
export type SaveDecisionAdapter = (intent: DecisionIngestion) => Promise<unknown>;

/** Contratto del mittente: gli adapter iniettati per eseguire i salvataggi. */
export interface IngestionAdapters {
	/** Chiamato per ogni requisito non ancora ingerito. */
	saveRequirement: SaveRequirementAdapter;
	/** Chiamato per ogni decisione non ancora ingerita. */
	saveDecision: SaveDecisionAdapter;
}

/** Result di una run di ingestPendingResearch. */
export interface IngestionResult {
	/** Requisiti salvati in questa run (voce aggiunta al ledger). */
	requirementsSaved: number;
	/** Decisioni salvate in questa run. */
	decisionsSaved: number;
	/** Requisiti saltati (già nel ledger). */
	requirementsSkipped: number;
	/** Decisioni saltate (già nel ledger). */
	decisionsSkipped: number;
	/** Voci per cui l'adapter ha fallito (chiave NON committata nel ledger). */
	errors: { kind: "requirement" | "decision"; key: string; reason: string }[];
	/** Path del file pending-research.json letto (null se assente). */
	sourcePath: string | null;
}

/** Registro di idempotenza (shape del file ingestion-ledger.json). */
export interface IngestionLedger {
	requirements: string[];
	decisions: string[];
}

/** Path assoluti dei file di ingest sotto `<cwd>`. */
export function ingestionPaths(cwd: string): {
	sourceJsonPath: string;
	sourceMdPath: string;
	ledgerPath: string;
	outboxPath: string;
} {
	const dir = path.join(cwd, DISCUSSION_ARENA_COORDINATION_DIR);
	return {
		sourceJsonPath: path.join(dir, PENDING_RESEARCH_JSON_FILENAME),
		sourceMdPath: path.join(dir, "pending-research.md"),
		ledgerPath: path.join(dir, INGESTION_LEDGER_FILENAME),
		outboxPath: path.join(dir, INGESTION_OUTBOX_FILENAME),
	};
}

/** Hash stabile (FNV-1a 32-bit + base36), senza timestamp → deterministica. */
function stableHash(input: string): string {
	let h = 0x811c9dc5;
	const str = String(input);
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(36);
}

/** Chiave deterministica di idempotenza per un requisito. */
export function buildRequirementKey(requirement: RequirementItem): string {
	if (requirement.id && requirement.id.trim() !== "") {
		return `${REQ_KEY_PREFIX}:${requirement.id}`;
	}
	const stable = `${requirement.title}\u0000${requirement.description}`;
	return `${REQ_KEY_PREFIX}:${stableHash(stable)}`;
}

/** Chiave deterministica di idempotenza per una decisione. */
export function buildDecisionKey(decision: DecisionItem): string {
	const stable = decision.statement.trim();
	return `${DEC_KEY_PREFIX}:${stableHash(stable)}`;
}

/**
 * Costruisce il piano di ingestion (ordinato) a partire dalla struttura
 * estratta. Puro e deterministico: non legge né scrive nulla.
 */
export function buildIngestionPlan(structured: ResearchDecisions): {
	requirements: RequirementIngestionIntent[];
	decisions: DecisionIngestion[];
} {
	const requirements: RequirementIngestionIntent[] = structured.requirements.map(
		(r) => ({
			id: r.id,
			title: r.title,
			description: r.description ?? "",
			priority: r.priority,
		}),
	);
	const decisions: DecisionIngestion[] = (structured.decisions ?? []).map(
		(d) => ({
			statement: d.statement,
			...(d.rationale ? { rationale: d.rationale } : {}),
			...(d.dissent && d.dissent.length > 0 ? { dissent: d.dissent } : {}),
		}),
	);
	return { requirements, decisions };
}

/** Log stderr best-effort con prefisso canonico (non propaga errori). */
function log(stderr: NodeJS.WritableStream, message: string): void {
	try {
		stderr.write(`${LOG_PREFIX} ${message}\n`);
	} catch {
		/* ignora errori di logging */
	}
}

/** true se err è ENOENT. */
function isEnoent(err: unknown): boolean {
	return (
		err instanceof Error &&
		"code" in err &&
		(err as { code?: unknown }).code === "ENOENT"
	);
}

/** Ledger vuoto canonico. */
function emptyLedger(): IngestionLedger {
	return { requirements: [], decisions: [] };
}

/** Legge il ledger e lo valida (fallisce a vuoto su malformata/assente). */
export async function readIngestionLedger(cwd: string): Promise<IngestionLedger> {
	const { ledgerPath } = ingestionPaths(cwd);
	let raw: string;
	try {
		raw = await readFile(ledgerPath, "utf-8");
	} catch (err) {
		if (isEnoent(err)) return emptyLedger();
		throw err;
	}
	try {
		const parsed = JSON.parse(raw) as Partial<IngestionLedger>;
		return {
			requirements: Array.isArray(parsed.requirements)
				? (parsed.requirements.filter((x) => typeof x === "string") as string[])
				: [],
			decisions: Array.isArray(parsed.decisions)
				? (parsed.decisions.filter((x) => typeof x === "string") as string[])
				: [],
		};
	} catch {
		// Ledger malformato: si parte da zero (mai throw), un ri-run lo ricalcola.
		return emptyLedger();
	}
}

/** Serializzazione deterministica e ordinata del ledger. */
function renderIngestionLedger(ledger: IngestionLedger): string {
	return JSON.stringify(
		{
			requirements: [...ledger.requirements].sort(),
			decisions: [...ledger.decisions].sort(),
		},
		null,
		2,
	) + "\n";
}

/** Scrive il ledger atomicamente (write-then-rename, stessa shape S03). */
async function writeIngestionLedger(
	cwd: string,
	ledger: IngestionLedger,
	stderr: NodeJS.WritableStream,
): Promise<void> {
	const { ledgerPath } = ingestionPaths(cwd);
	await writeFileAtomicPending(
		ledgerPath,
		renderIngestionLedger(ledger),
	);
	log(
		stderr,
		`ingestion: ledger write ${ledgerPath} requirements=${ledger.requirements.length} decisions=${ledger.decisions.length}`,
	);
}

/** Rimuove il registro di idempotenza (ENOENT ignorato). Utile per i test. */
export async function clearIngestionLedger(
	cwd: string,
	stderr: NodeJS.WritableStream = process.stderr,
): Promise<{ removed: boolean }> {
	const { ledgerPath } = ingestionPaths(cwd);
	try {
		await fs.promises.unlink(ledgerPath);
		log(stderr, `ingestion: ledger cleared ${ledgerPath}`);
		return { removed: true };
	} catch (err) {
		if (isEnoent(err)) return { removed: false };
		throw err;
	}
}

/**
 * Legge e valida `pending-research.json`. Mai throw: file assente → null
 * (no-op, con log diagnostico); JSON invalido / version ≠ 1 / structured
 * assente → null con log diagnostico strutturato.
 */
export async function loadPendingResearchJson(
	cwd: string,
	stderr: NodeJS.WritableStream = process.stderr,
): Promise<PendingResearchOrNull> {
	const { sourceJsonPath } = ingestionPaths(cwd);
	let raw: string;
	try {
		raw = await readFile(sourceJsonPath, "utf-8");
	} catch (err) {
		if (isEnoent(err)) return null;
		throw err;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		log(stderr, `ingestion: parse error ${sourceJsonPath} — invalid JSON, nothing to ingest`);
		return null;
	}
	const p = parsed as { version?: unknown; structured?: unknown };
	if (
		typeof p !== "object" ||
		p === null ||
		p.version !== 1 ||
		typeof p.structured !== "object" ||
		p.structured === null
	) {
		log(
			stderr,
			`ingestion: invalid pending-research shape (expected {version:1, structured}) — nothing to ingest`,
		);
		return null;
	}
	return parsed as { version: 1; structured: ResearchDecisions };
}

/** Tipo di ritorno di loadPendingResearchJson. */
export type PendingResearchOrNull = { version: 1; structured: ResearchDecisions } | null;

/**
 * Adapter di default basato su file outbox: appende ogni intento come riga
 * JSON a `ingestion-outbox.jsonl` (append durevole, best-effort atomic). È
 * l'handoff a chi esegue le vere chiamate gsd_requirement_save /
 * gsd_decision_save: la riga serializza l'intent esatto, senza perdita.
 */
export function createFileOutboxAdapters(cwd: string): IngestionAdapters {
	const { outboxPath } = ingestionPaths(cwd);
	const append = async (line: object): Promise<void> => {
		await fs.promises.mkdir(path.dirname(outboxPath), { recursive: true });
		// append best-effort; la dir è garantita dal mkdir sopra.
		const record = JSON.stringify(line) + "\n";
		await fs.promises.appendFile(outboxPath, record, "utf-8");
	};
	return {
		async saveRequirement(intent) {
			await append({ kind: "requirement_save", intent });
		},
		async saveDecision(intent) {
			await append({ kind: "decision_save", intent });
		},
	};
}

/** Default options per ingestPendingResearch. */
export interface IngestOptions {
	/** Sink di log stderr (default setup: process.stderr). */
	stderr?: NodeJS.WritableStream;
	/** Adapter di salvataggio (default: createFileOutboxAdapters). */
	adapters?: IngestionAdapters;
}

/**
 * Esegue l'ingestion idempotente dei pending-requirements verso gli adapter.
 *
 * Step:
 *   1. legge pending-research.json (assente/malformato → no-op);
 *   2. costruisce il piano (requirement + decision, ordinati);
 *   3. legge il ledger di idempotenza (assente → vuoto);
 *   4. per ogni voce NON nel ledger chiama l'adapter; se l'adapter risolve
 *      → la chiave viene committata nel ledger (salvata); se l'adapter
 *      fallisce → chiave NON committata, voce segnalata in `errors`;
 *   5. scrive il ledger solo se cambiato (atomico);
 *   6. log stderr strutturato per ogni voce salvata.
 *
 * Mai throw (dove non specificato): errori I/O/best-effort loggati e raccolti
 * in `errors`, le altre voci continuano; l'unico throw possibile è un I/O
 * irrecuperabile del ledger (ENOENT non lo è).
 */
export async function ingestPendingResearch(
	cwd: string,
	options: IngestOptions = {},
): Promise<IngestionResult> {
	const stderr = options.stderr ?? process.stderr;
	const adapters = options.adapters ?? createFileOutboxAdapters(cwd);

	const pending = await loadPendingResearchJson(cwd, stderr);
	if (pending === null) {
		log(stderr, "ingestion: no pending-research file — nothing to ingest");
		return {
			requirementsSaved: 0,
			decisionsSaved: 0,
			requirementsSkipped: 0,
			decisionsSkipped: 0,
			errors: [],
			sourcePath: ingestionPaths(cwd).sourceJsonPath,
		};
	}

	const { requirements, decisions } = buildIngestionPlan(pending.structured);
	const ledger = await readIngestionLedger(cwd);

	const result: IngestionResult = {
		requirementsSaved: 0,
		decisionsSaved: 0,
		requirementsSkipped: 0,
		decisionsSkipped: 0,
		errors: [],
		sourcePath: ingestionPaths(cwd).sourceJsonPath,
	};

	let ledgerDirty = false;

	for (const req of requirements) {
		const key = buildRequirementKey(req);
		if (ledger.requirements.includes(key)) {
			result.requirementsSkipped++;
			continue;
		}
		try {
			await adapters.saveRequirement(req);
			ledger.requirements.push(key);
			ledgerDirty = true;
			result.requirementsSaved++;
			log(stderr, `ingestion: requirement saved ${req.id ?? key}`);
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			result.errors.push({ kind: "requirement", key, reason });
			log(
				stderr,
				`ingestion: requirement save failed ${key} — ${reason} (will be retried)`,
			);
		}
	}

	for (const dec of decisions) {
		const key = buildDecisionKey(dec);
		if (ledger.decisions.includes(key)) {
			result.decisionsSkipped++;
			continue;
		}
		try {
			await adapters.saveDecision(dec);
			ledger.decisions.push(key);
			ledgerDirty = true;
			result.decisionsSaved++;
			const label = dec.statement.length > 48
				? `${dec.statement.slice(0, 45)}…`
				: dec.statement;
			log(stderr, `ingestion: decision saved ${label}`);
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			result.errors.push({ kind: "decision", key, reason });
			log(
				stderr,
				`ingestion: decision save failed ${key} ${reason} (will be retried)`,
			);
		}
	}

	if (ledgerDirty) {
		await writeIngestionLedger(cwd, ledger, stderr);
	}

	return result;
}

/**
 * Ritorna la config di opt-in ingestion (parsata con il coordination file).
 * `enabled === true` → l'ingestion è attivo per questo progetto.
 */
export function isIngestionEnabled(
	config: DiscussionArenaCoordinationConfig,
): boolean {
	return config.ingestion?.enabled === true;
}

/**
 * Hook di wiring (M008/S04/T02): registra l'ingestion sull'evento
 * `milestone_end`, opt-in via `ingestion.enabled` nel coordination file. Il
 * hook è fire-and-forget: legge il coordination file al momento dell'evento
 * (così l'opt-in riflette la config corrente), e se ingestion non è attivo
 * o il pending non esiste → no-op con log strutturato. Eventuali errori
 * vengono loggati (mai throw).
 *
 * In index.ts deve essere registrato PRIMA di `attachPendingResearchCleanupHooks`:
 * sul `milestone_end` i listener girano in ordine di registrazione, quindi
 * l'ingestion legge i pending-research PRIMA che il cleanup li rimuova.
 */
export function attachIngestionHooks(
	api: ExtensionAPI,
	options: IngestOptions = {},
): boolean {
	const stderr = options.stderr ?? process.stderr;
	api.on("milestone_end", (event: {
		type: "milestone_end";
		cwd?: string;
		status?: "completed" | "cancelled" | "failed";
	}) => {
		const cwd = typeof event.cwd === "string" ? event.cwd : "";
		if (cwd === "") return;
		runIngestionAtEvent(cwd, options).catch((err: unknown) => {
			const reason = err instanceof Error ? err.message : String(err);
			log(stderr, `ingestion: milestone_end flow failed: ${reason}`);
		});
	});
	return true;
}

/** Esegue runIngestion solo se opt-in attivo e coordination presente. */
async function runIngestionAtEvent(
	cwd: string,
	options: IngestOptions,
): Promise<IngestionResult | null> {
	const stderr = options.stderr ?? process.stderr;
	const coordPath = path.join(
		cwd,
		DISCUSSION_ARENA_COORDINATION_DIR,
		DISCUSSION_ARENA_COORDINATION_FILENAME,
	);
	const coord = loadDiscussionArenaCoordination(coordPath);
	if (!isIngestionEnabled(coord.config)) {
		log(stderr, "ingestion: disabled in coordination file — skipped");
		return null;
	}
	return ingestPendingResearch(cwd, options);
}