/**
 * tests/integration/s01-race-condition.test.ts — M011/S01/T03.
 *
 * Verifica le proprietà cross-process del lock `pending-research.lock` e
 * l'ordinamento del lifecycle hook ingestion → cleanup dentro la stessa
 * sezione critica (slice contract):
 *
 *   RC-1: due `execute(...)` concorrenti serializzati dal lock.
 *     - 2× `lock acquired` + 2× `lock released` nello stderr log;
 *     - ordine strict: acquire[0] < release[0] < acquire[1] < release[1]
 *       (chi prima entra nel `withPendingResearchLock` esce prima di far
 *       entrare l'altro — proprietà cross-process del O_EXCL atomic);
 *     - PRIMO execute: `pendingResearchWritten = true` (prima scrittura);
 *     - SECONDO execute: `pendingResearchWritten = false` (write idempotente
 *       sullo stesso payload, `writePendingResearch` ritorna `changed: false`
 *       — proprietà T02, NON un fallimento);
 *     - i due file pending sono scritti atomicamente dal primo execute e
 *       restano invariati (write idempotente del secondo).
 *
 *   RC-2: `milestone_end` con ingestion attiva → ingestion PRIMA del
 *         cleanup nello stesso lock.
 *     - pre-popolamento di `pending-research.json` + `.md` con struttura
 *       valida (fixture reale);
 *     - coordination file con `ingestion.enabled: true`;
 *     - emissione `milestone_end` → il lifecycle hook unico
 *       (`attachPendingResearchLifecycleHooks`) entra nel lock, esegue
 *       ingestion, poi cleanup, poi rilascia il lock;
 *     - assert: `ingestion-outbox.jsonl` popolato (ingestion OK) E file
 *       pending rimossi (cleanup OK) E ordine log
 *       `lifecycle ingest done` PRIMA di `lifecycle cleanup done`.
 *
 *   RC-3: `milestone_end` con ingestion disattivata → solo cleanup.
 *     - coordination file assente o senza `ingestion.enabled: true`;
 *     - assert: file pending rimossi, outbox NON esiste, log
 *       `lifecycle ingest disabled` PRIMA di `lifecycle cleanup done`.
 *
 *   RC-4: pending-research assenti + ingestion attiva → no-op.
 *     - coordination file con `ingestion.enabled: true`, nessun pending;
 *     - assert: nessun outbox, log ordinato
 *       `ingest done requirements=0 decisions=0` PRIMA di
 *       `cleanup done paths=0`, nessun errore propagato.
 *
 * Self-sufficiency: registra gli hook ESM come il sibling
 * `s01-tool-call-site.test.ts` — il file può girare sotto `node --test`
 * diretto o con `--import ./tests/ts-esm-loader.mjs`.
 */

import "../ts-esm-loader.mjs";
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
	buildDiscussionArenaExecute,
	type RunDiscussionArenaFn,
} from "../../index.js";
import { attachUnitAwareHooks } from "../../src/hooks-unit-aware.js";
import { RESEARCH_INSTRUCTION_MARKER } from "../../src/markers.js";
import {
	pendingResearchPaths,
	pendingResearchLockPath,
	writePendingResearch,
} from "../../src/discussion-arena-pending-research.js";
import {
	attachPendingResearchLifecycleHooks,
	ingestionPaths,
} from "../../src/discussion-arena-ingestion.js";
import { extractResearchDecisions } from "../../src/discussion-arena-research-extractor.js";
import type { ResolveTriggerOutput } from "../../trigger-resolver.js";
import {
	loadDiscussionArenaCoordination,
	DISCUSSION_ARENA_COORDINATION_DIR,
	DISCUSSION_ARENA_COORDINATION_FILENAME,
} from "../../src/discussion-arena-coordination.js";

// ---------------------------------------------------------------------------
// Costanti / fixture condivise.
// ---------------------------------------------------------------------------

const FORCED: ResolveTriggerOutput = {
	decision: "forced",
	source: "env",
	warnings: [],
	parseErrors: [],
	tier: "A",
	capabilities: new Set(),
	groupEligibility: null,
};

/** Transcript reale (3 ipotesi, 2 decisioni, 3 requisiti). */
const FIXTURES_DIR = path.resolve(
	fileURLToPath(import.meta.url),
	"..",
	"..",
	"fixtures",
	"scribe-transcripts",
);
const FIXTURE_TRANSCRIPT = readFileSync(
	path.join(FIXTURES_DIR, "03-integrazione-research-adr046.md"),
	"utf-8",
);

const VALID_RUN_RESULT = {
	transcript: FIXTURE_TRANSCRIPT,
	participantsUsed: ["scribe", "reviewer"],
	totalCost: 0,
	outcome: "complete" as const,
};

function stubRunDiscussionArena(): RunDiscussionArenaFn {
	return (async () => VALID_RUN_RESULT) as RunDiscussionArenaFn;
}

// ---------------------------------------------------------------------------
// Helper workspace / file system / wait.
// ---------------------------------------------------------------------------

async function createTmpDir(): Promise<string> {
	return await fs.mkdtemp(path.join(os.tmpdir(), "s01-race-condition-"));
}

async function exists(p: string): Promise<boolean> {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}

async function waitFor(
	cond: () => Promise<boolean> | boolean,
	timeoutMs = 3000,
): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (await cond()) return;
		await new Promise((r) => setTimeout(r, 10));
	}
	throw new Error(`waitFor: condizione mai vera entro ${timeoutMs}ms`);
}

/** Raccoglie le righe log stderr in un array (per le asserzioni di ordinamento). */
function collectStderr(): {
	stream: NodeJS.WritableStream;
	lines: () => string[];
} {
	const lines: string[] = [];
	const stream = {
		write(chunk: unknown): boolean {
			lines.push(String(chunk).replace(/\n$/, ""));
			return true;
		},
	} as NodeJS.WritableStream;
	return { stream, lines: () => lines };
}

/** Stub API con dispatcher 1-a-N (forwarding come fa il framework reale). */
function createDispatchingApi(): {
	api: Record<string, unknown>;
	emit: (event: string, payload: Record<string, unknown>) => void;
} {
	const handlers = new Map<
		string,
		((p: Record<string, unknown>) => unknown)[]
	>();
	const api = {
		on(event: string, handler: (p: Record<string, unknown>) => unknown) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return {};
		},
	};
	function emit(event: string, payload: Record<string, unknown>): void {
		for (const h of handlers.get(event) ?? []) {
			h(payload);
		}
	}
	return { api, emit };
}

// ---------------------------------------------------------------------------
// Helper coordination file: abilita/disabilita ingestion.
// ---------------------------------------------------------------------------

async function writeCoordinationWithIngestion(
	cwd: string,
	enabled: boolean,
): Promise<string> {
	const dir = path.join(cwd, DISCUSSION_ARENA_COORDINATION_DIR);
	await fs.mkdir(dir, { recursive: true });
	const p = path.join(dir, DISCUSSION_ARENA_COORDINATION_FILENAME);
	const content = [
		"---",
		"rounds_default: 2",
		`ingestion:`,
		`  enabled: ${enabled}`,
		"---",
	].join("\n");
	await fs.writeFile(p, content, "utf-8");
	return p;
}

/**
 * Pre-popola `pending-research.json` + `.md` con struttura valida (fixture
 * reale → extractor non-fallback → struttura tipizzata). Ritorna la
 * struttura estratta per eventuali asserzioni downstream.
 */
async function prePopulatePendingResearch(
	cwd: string,
	stderr: NodeJS.WritableStream,
): Promise<{ structured: ReturnType<typeof extractResearchDecisions> }> {
	const extraction = extractResearchDecisions(FIXTURE_TRANSCRIPT, stderr);
	assert.ok(
		!("fallback" in extraction),
		"fixture deve estrarre senza fallback",
	);
	const structured = extraction;
	await writePendingResearch(
		cwd,
		structured as Parameters<typeof writePendingResearch>[1],
		FIXTURE_TRANSCRIPT,
		stderr,
	);
	return { structured };
}

// ---------------------------------------------------------------------------
// Helper asserzioni log: posizioni di un pattern e ordinamento strict.
// ---------------------------------------------------------------------------

function firstIndex(haystack: string, needle: string): number {
	const i = haystack.indexOf(needle);
	if (i === -1) {
		throw new Error(
			`pattern atteso non trovato in stderr: ${needle}\n----- log -----\n${haystack}`,
		);
	}
	return i;
}

/** Trova TUTTI gli indici del pattern nel log. */
function allIndices(haystack: string, needle: string): number[] {
	const out: number[] = [];
	let i = haystack.indexOf(needle);
	while (i !== -1) {
		out.push(i);
		i = haystack.indexOf(needle, i + 1);
	}
	return out;
}

// ===========================================================================
// RC-1: due execute concorrenti serializzati dal lock.
// ===========================================================================

test("RC-1: due execute(...) concorrenti serializzati dal lock (acquire[0] < release[0] < acquire[1] < release[1])", async () => {
	const cwd = await createTmpDir();
	try {
		const { api, emit } = createDispatchingApi();
		const { stream, lines } = collectStderr();

		attachUnitAwareHooks(api as never, { cwd } as never, {
			activeUnitTypes: new Set(["research-decision"]),
			instructionMarker: RESEARCH_INSTRUCTION_MARKER,
			instructionText: "research",
			resolveTrigger: FORCED,
			stderr: stream,
		});
		emit("unit_start", { type: "unit_start", unitType: "research-decision" });

		const execute = buildDiscussionArenaExecute(api as never, {
			runDiscussionArena: stubRunDiscussionArena(),
			stderr: stream,
		});
		const ctx = { cwd } as never;

		// Lancio concorrente: stesso processo, O_EXCL garantisce 1 winner + 1 waiter.
		const [r1, r2] = await Promise.all([
			execute(
				"call-A",
				{
					topic: "A",
					participants: ["scribe"],
					rounds: 1,
				} as Parameters<typeof execute>[1],
				undefined,
				undefined,
				ctx,
			),
			execute(
				"call-B",
				{
					topic: "B",
					participants: ["scribe"],
					rounds: 1,
				} as Parameters<typeof execute>[1],
				undefined,
				undefined,
				ctx,
			),
		]);

		// Idempotenza del write (T02 contract): stessa struttura + stesso
		// transcript → `writePendingResearch` ritorna `changed: false` sul
		// secondo call. Quindi:
		//   - il PRIMO execute è il primo a scrivere → `pendingResearchWritten: true`;
		//   - il SECONDO execute vede contenuto identico → write SKIPPED
		//     (`changed: false`) → `pendingResearchWritten: false`.
		// La proprietà cross-process che conta è la SERIALIZZAZIONE via
		// lock (i 2× acquire + 2× release in ordine strict, asseriti sotto):
		// il secondo execute NON vede uno stato intermedio (il primo deve
		// aver rilasciato il lock prima che il secondo scriva).
		assert.equal(
			(r1.details as { pendingResearchWritten: boolean }).pendingResearchWritten,
			true,
			"primo execute: prima scrittura → changed=true",
		);
		assert.equal(
			(r2.details as { pendingResearchWritten: boolean }).pendingResearchWritten,
			false,
			"secondo execute: idempotente sullo stesso payload → changed=false (write SKIPPED)",
		);

		// File pending presenti (idempotenza: la seconda scrittura non muta).
		const { jsonPath, markdownPath } = pendingResearchPaths(cwd);
		assert.equal(await exists(jsonPath), true, "json scritto");
		assert.equal(await exists(markdownPath), true, "md scritto");

		// Lock non più presente (rilasciato dopo la sezione critica).
		const lockPath = pendingResearchLockPath(cwd);
		assert.equal(await exists(lockPath), false, "lock rilasciato");

		// 2× acquire + 2× release, in ordine strict.
		const logText = lines().join("\n");
		const acquired = allIndices(
			logText,
			"[discussion-arena] pending-research: lock acquired",
		);
		const released = allIndices(
			logText,
			"[discussion-arena] pending-research: lock released",
		);
		assert.equal(acquired.length, 2, "esattamente 2 lock acquired");
		assert.equal(released.length, 2, "esattamente 2 lock released");

		// Serializzazione: chi entra prima esce prima di far entrare l'altro.
		// Aggiungiamo `pid=` matched alla `lock acquired` come ulteriore prova
		// che entrambi sono del processo corrente (NON un altro processo).
		assert.match(
			logText.slice(acquired[0], acquired[0] + 200),
			/lock acquired .* pid=\d+/,
			"primo lock acquired ha pid= nel prefisso canonico",
		);
		assert.match(
			logText.slice(acquired[1], acquired[1] + 200),
			/lock acquired .* pid=\d+/,
			"secondo lock acquired ha pid= nel prefisso canonico",
		);
		assert.ok(
			acquired[0] < released[0],
			`acquired[0]=${acquired[0]} < released[0]=${released[0]}`,
		);
		assert.ok(
			released[0] < acquired[1],
			`released[0]=${released[0]} < acquired[1]=${acquired[1]} (serializzazione)`,
		);
		assert.ok(
			acquired[1] < released[1],
			`acquired[1]=${acquired[1]} < released[1]=${released[1]}`,
		);
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

// ===========================================================================
// RC-2: milestone_end con ingestion attiva → ingestion PRIMA del cleanup.
// ===========================================================================

test("RC-2: milestone_end (ingestion attiva) → ingestion PRIMA del cleanup nello stesso lock", async () => {
	const cwd = await createTmpDir();
	try {
		// Coordination con ingestion.enabled: true.
		const coordPath = await writeCoordinationWithIngestion(cwd, true);
		const coord = loadDiscussionArenaCoordination(coordPath);
		assert.equal(coord.config.ingestion?.enabled, true, "ingestion opt-in");

		// Pre-popoliamo i file pending con struttura valida.
		const { stream: preStderr } = collectStderr();
		await prePopulatePendingResearch(cwd, preStderr);

		const { jsonPath, markdownPath } = pendingResearchPaths(cwd);
		const { outboxPath } = ingestionPaths(cwd);
		assert.equal(await exists(jsonPath), true, "pending json pre-popolato");
		assert.equal(await exists(markdownPath), true, "pending md pre-popolato");

		// Attach del lifecycle hook con sink stderr strutturato.
		const { api, emit } = createDispatchingApi();
		const { stream, lines } = collectStderr();

		assert.equal(
			attachPendingResearchLifecycleHooks(api as never, { stderr: stream }),
			true,
			"lifecycle hook registrato",
		);

		// Emissione milestone_end (fire-and-forget → polling per il completamento).
		emit("milestone_end", {
			type: "milestone_end",
			cwd,
			status: "completed",
		});

		// Signal di completamento: outbox popolato + file pending rimossi.
		// Il fixture produce 3 requirement + 2 decision.
		await waitFor(
			async () =>
				(await exists(outboxPath)) &&
				!(await exists(jsonPath)) &&
				!(await exists(markdownPath)),
			5000,
		);

		// Outbox popolato con 3 requirement + 2 decision (5 righe totali).
		const outboxRaw = await fs.readFile(outboxPath, "utf-8");
		const outboxLines = outboxRaw
			.split("\n")
			.filter((l) => l.length > 0)
			.map((l) => JSON.parse(l));
		const reqCount = outboxLines.filter(
			(l) => l.kind === "requirement_save",
		).length;
		const decCount = outboxLines.filter(
			(l) => l.kind === "decision_save",
		).length;
		assert.equal(reqCount, 3, "3 requirement nell'outbox");
		assert.equal(decCount, 2, "2 decision nell'outbox");

		// File pending rimossi (cleanup DOPO ingestion).
		assert.equal(
			await exists(jsonPath),
			false,
			"pending-research.json rimosso dal cleanup",
		);
		assert.equal(
			await exists(markdownPath),
			false,
			"pending-research.md rimosso dal cleanup",
		);

		// Lock rilasciato.
		const lockPath = pendingResearchLockPath(cwd);
		assert.equal(
			await exists(lockPath),
			false,
			"lock rilasciato al termine del lifecycle",
		);

		// Ordinamento strict: lifecycle start → lock acquired → ingest enabled →
		// ingest done → cleanup done → lock released.
		const logText = lines().join("\n");
		const startIdx = firstIndex(logText, "pending-research: lifecycle start");
		const acquiredIdx = firstIndex(
			logText,
			"pending-research: lock acquired",
		);
		const ingestEnabledIdx = firstIndex(
			logText,
			"pending-research: lifecycle ingest enabled",
		);
		const ingestDoneIdx = firstIndex(
			logText,
			"pending-research: lifecycle ingest done",
		);
		const cleanupDoneIdx = firstIndex(
			logText,
			"pending-research: lifecycle cleanup done",
		);
		const releasedIdx = firstIndex(
			logText,
			"pending-research: lock released",
		);

		// Slice contract: ingestion PRIMA del cleanup (entrambi dentro il lock).
		assert.ok(
			ingestDoneIdx < cleanupDoneIdx,
			`ingest done (${ingestDoneIdx}) PRIMA di cleanup done (${cleanupDoneIdx})`,
		);
		assert.ok(
			acquiredIdx < ingestDoneIdx,
			"lock acquired PRIMA di ingest done (l'ingest è dentro la sezione critica)",
		);
		assert.ok(
			cleanupDoneIdx < releasedIdx,
			"cleanup done PRIMA di lock released (il cleanup è dentro la sezione critica)",
		);
		assert.ok(startIdx < acquiredIdx, "lifecycle start PRIMA del lock acquired");
		assert.ok(
			ingestEnabledIdx < ingestDoneIdx,
			"ingest enabled PRIMA di ingest done",
		);
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

// ===========================================================================
// RC-3: milestone_end con ingestion disattivata → solo cleanup.
// ===========================================================================

test("RC-3: milestone_end (ingestion disattivata) → solo cleanup, nessuna scrittura outbox", async () => {
	const cwd = await createTmpDir();
	try {
		// Coordination esplicito con ingestion.enabled: false (RC-3 vuole
		// l'opt-in deterministico, non "assenza del file").
		await writeCoordinationWithIngestion(cwd, false);

		// Pre-popolamento dei file pending.
		const { stream: preStderr } = collectStderr();
		await prePopulatePendingResearch(cwd, preStderr);

		const { jsonPath, markdownPath } = pendingResearchPaths(cwd);
		const { outboxPath } = ingestionPaths(cwd);

		const { api, emit } = createDispatchingApi();
		const { stream, lines } = collectStderr();

		assert.equal(
			attachPendingResearchLifecycleHooks(api as never, { stderr: stream }),
			true,
		);

		emit("milestone_end", {
			type: "milestone_end",
			cwd,
			status: "completed",
		});

		// Signal di completamento: file pending rimossi (cleanup OK) +
		// log "ingest disabled" (opt-in rispettato).
		await waitFor(
			async () =>
				!(await exists(jsonPath)) && !(await exists(markdownPath)),
			5000,
		);

		// Outbox NON scritto: ingestion non è stata chiamata.
		assert.equal(
			await exists(outboxPath),
			false,
			"outbox inesistente (ingestion disattivata)",
		);

		// File pending rimossi.
		assert.equal(await exists(jsonPath), false, "json rimosso");
		assert.equal(await exists(markdownPath), false, "md rimosso");

		// Lock rilasciato.
		const lockPath = pendingResearchLockPath(cwd);
		assert.equal(await exists(lockPath), false, "lock rilasciato");

		// Log ordinato: lifecycle start → lock acquired → ingest disabled →
		// cleanup done → lock released.
		const logText = lines().join("\n");
		const startIdx = firstIndex(logText, "pending-research: lifecycle start");
		const acquiredIdx = firstIndex(
			logText,
			"pending-research: lock acquired",
		);
		const ingestDisabledIdx = firstIndex(
			logText,
			"pending-research: lifecycle ingest disabled",
		);
		const cleanupDoneIdx = firstIndex(
			logText,
			"pending-research: lifecycle cleanup done",
		);
		const releasedIdx = firstIndex(
			logText,
			"pending-research: lock released",
		);

		assert.ok(
			acquiredIdx < ingestDisabledIdx,
			"lock acquired PRIMA di ingest disabled",
		);
		assert.ok(
			ingestDisabledIdx < cleanupDoneIdx,
			"ingest disabled PRIMA di cleanup done (stesso lock)",
		);
		assert.ok(
			cleanupDoneIdx < releasedIdx,
			"cleanup done PRIMA di lock released",
		);
		assert.ok(startIdx < acquiredIdx, "lifecycle start PRIMA di lock acquired");

		// Non deve apparire `lifecycle ingest done` né `lifecycle ingest enabled`
		// (coerente con ingestion disattivata).
		assert.equal(
			logText.includes("pending-research: lifecycle ingest enabled"),
			false,
			"ingestion.enabled NON deve loggare 'ingest enabled'",
		);
		assert.equal(
			logText.includes("pending-research: lifecycle ingest done"),
			false,
			"ingestion.enabled NON deve loggare 'ingest done'",
		);
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

// ===========================================================================
// RC-4: pending-research assenti + ingestion attiva → no-op.
// ===========================================================================

test("RC-4: pending-research assenti + ingestion attiva → no-op (no outbox, cleanup paths=0, ingest 0/0)", async () => {
	const cwd = await createTmpDir();
	try {
		// Coordination con ingestion.enabled: true.
		await writeCoordinationWithIngestion(cwd, true);

		// NESSUN pre-popolamento dei file pending.
		const { jsonPath, markdownPath } = pendingResearchPaths(cwd);
		const { outboxPath } = ingestionPaths(cwd);
		assert.equal(
			await exists(jsonPath),
			false,
			"nessun pending pre-popolato (sanity check)",
		);
		assert.equal(await exists(markdownPath), false, "nessun pending md (sanity)");
		assert.equal(
			await exists(outboxPath),
			false,
			"nessun outbox pre-esistente (sanity)",
		);

		const { api, emit } = createDispatchingApi();
		const { stream, lines } = collectStderr();

		assert.equal(
			attachPendingResearchLifecycleHooks(api as never, { stderr: stream }),
			true,
		);

		emit("milestone_end", {
			type: "milestone_end",
			cwd,
			status: "completed",
		});

		// Signal di completamento: log "lifecycle cleanup done paths=0".
		await waitFor(
			async () =>
				lines().some((l) => /lifecycle cleanup done paths=0/.test(l)),
			5000,
		);

		// Outbox NON scritto: niente da ingerire.
		assert.equal(
			await exists(outboxPath),
			false,
			"outbox non scritto (no pending → no ingestion)",
		);

		// File pending NON creati (cleanup non aveva nulla da rimuovere).
		assert.equal(await exists(jsonPath), false);
		assert.equal(await exists(markdownPath), false);

		// Lock rilasciato.
		const lockPath = pendingResearchLockPath(cwd);
		assert.equal(
			await exists(lockPath),
			false,
			"lock rilasciato anche su no-op",
		);

		// Log ordinato: lifecycle start → lock acquired → ingest enabled →
		// ingest done requirements=0 decisions=0 → cleanup done paths=0 →
		// lock released.
		const logText = lines().join("\n");
		assert.match(
			logText,
			/pending-research: lifecycle ingest enabled/,
			"log 'ingest enabled' presente (opt-in attivo)",
		);
		assert.match(
			logText,
			/pending-research: lifecycle ingest done requirements=0 decisions=0/,
			"log 'ingest done requirements=0 decisions=0' presente (no-op)",
		);
		assert.match(
			logText,
			/pending-research: lifecycle cleanup done paths=0/,
			"log 'cleanup done paths=0' presente (no-op)",
		);

		// Ordinamento strict (no pending → comunque dentro il lock).
		const startIdx = firstIndex(logText, "pending-research: lifecycle start");
		const acquiredIdx = firstIndex(
			logText,
			"pending-research: lock acquired",
		);
		const ingestDoneIdx = firstIndex(
			logText,
			"pending-research: lifecycle ingest done requirements=0 decisions=0",
		);
		const cleanupDoneIdx = firstIndex(
			logText,
			"pending-research: lifecycle cleanup done paths=0",
		);
		const releasedIdx = firstIndex(
			logText,
			"pending-research: lock released",
		);

		assert.ok(startIdx < acquiredIdx, "lifecycle start < lock acquired");
		assert.ok(
			acquiredIdx < ingestDoneIdx,
			"lock acquired < ingest done (no-op ingest dentro il lock)",
		);
		assert.ok(
			ingestDoneIdx < cleanupDoneIdx,
			"ingest done PRIMA di cleanup done (atomic ordering anche su no-op)",
		);
		assert.ok(cleanupDoneIdx < releasedIdx, "cleanup done < lock released");

		// Nessun errore propagato: lo stream stderr contiene SOLO log con
		// prefisso canonico `pending-research:` (più l'eventuale stderr del
		// recorder adapters, che in questo test non è invocato).
		const errorLines = lines().filter((l) =>
			/uncaught|failed:|timeout pid=/i.test(l),
		);
		assert.equal(
			errorLines.length,
			0,
			`nessun errore/timeout/uncaught propagato: ${JSON.stringify(errorLines)}`,
		);
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});