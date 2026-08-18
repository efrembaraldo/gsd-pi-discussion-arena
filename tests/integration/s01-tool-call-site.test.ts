/**
 * tests/integration/s01-tool-call-site.test.ts — M011/S01/T03.
 *
 * Test di integrazione del call-site cablato:
 *
 *   1. unità catturata all'inizio dell'invocazione (`research-decision`) →
 *      scrittura ATOMICA dei due artefatti `pending-research.json` + `.md`
 *      DENTRO `withPendingResearchLock`, `details.pendingResearchWritten: true`.
 *   2. unità NON `research-decision` (`planning`, `executing`, ...) →
 *      nessuna scrittura, `details.pendingResearchWritten: false`.
 *   3. unità sconosciuta (mai visto da `unit_start`, getter fail-safe T01) →
 *      nessuna scrittura, `details.pendingResearchWritten: false`.
 *   4. extractor fallback (transcript senza sezioni canoniche) →
 *      nessuna scrittura, `details.pendingResearchWritten: false`,
 *      NON propaga errore al tool.
 *   5. replay path (`params.replay`) → nessuna scrittura,
 *      `details.pendingResearchWritten: false` (idem evento log).
 *   6. write failure dentro la sezione critica (lock timeout / I/O error) →
 *      NON propaga errore al tool, `details.pendingResearchWritten: false`,
 *      log stderr strutturato `[discussion-arena] pending-research: write failed ...`.
 *
 * Pattern riusato dai test siblings `tests/integration/{research-ingestion,
 * pending-research-roundtrip}.test.ts`: stub di `ExtensionAPI` con dispatcher
 * (forwarding 1-a-N come fa il framework), workspace `os.tmpdir()` (mai path
 * di progetto), fixture transcript REALE (`03-integrazione-research-adr046.md`)
 * per il path research-decision, polling `waitFor`.
 *
 * Il test usa `buildDiscussionArenaExecute(api, { runDiscussionArena: stub })`
 * (factory introdotta in T03 in index.ts): il callback di produzione è cablato
 * in `activate()` come `execute: buildDiscussionArenaExecute(api)`. Iniettare
 * `runDiscussionArena` consente di stubbare la loop senza spawnare un subprocess
 * `gsd` reale (gli spawn `gsd` di orchestrazione non sono adatti a un test rapido).
 */

// Self-sufficiency: registra gli hook ESM (`.js` -> `.ts` + stub
// `@gsd/pi-coding-agent`) anche quando il file gira sotto `node --test` senza
// il flag `--import ./tests/ts-esm-loader.mjs` (es. `node --test` diretto).
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
import {
	RESEARCH_INSTRUCTION_MARKER,
	PLANNING_INSTRUCTION_MARKER,
} from "../../src/markers.js";
import {
	pendingResearchPaths,
	pendingResearchLockPath,
} from "../../src/discussion-arena-pending-research.js";
import type { ResolveTriggerOutput } from "../../trigger-resolver.js";

const FORCED: ResolveTriggerOutput = {
	decision: "forced",
	source: "env",
	warnings: [],
	parseErrors: [],
	tier: "A",
	capabilities: new Set(),
	groupEligibility: null,
};

/** Fixture transcript REALE con tutte e tre le sezioni → extractor non-fallback. */
const FIXTURES_DIR = path.resolve(
	fileURLToPath(import.meta.url),
	"..",
	"..",
	"fixtures",
	"scribe-transcripts",
);
const VALID_TRANSCRIPT = readFileSync(
	path.join(FIXTURES_DIR, "03-integrazione-research-adr046.md"),
	"utf-8",
);
/** Transcript di fallback: nessuna sezione canonica → extractor fallback. */
const FALLBACK_TRANSCRIPT =
	"Discussione libera senza struttura markdown riconoscibile.\nNiente ipotesi, decisioni o requisiti espliciti.\n";

// ---------------------------------------------------------------------------
// Stub API con dispatcher 1-a-N (forwarding come fa il framework reale).
// Allineato a `tests/unit/hooks-unit-aware-getter.test.ts`: api come plain
// object + cast `as never` per evitare di dipendere dal pacchetto
// vendored `@gsd/pi-coding-agent` (lo stub è iniettato dal loader ESM dei test).
// ---------------------------------------------------------------------------

interface DispatchingApi {
	api: Record<string, unknown>;
	emit: (event: string, payload: Record<string, unknown>) => void;
}

function createDispatchingApi(): DispatchingApi {
	const handlers = new Map<string, ((p: Record<string, unknown>) => unknown)[]>();
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
// Helper stderr: raccoglie le righe log strutturate per le asserzioni.
// ---------------------------------------------------------------------------

function collectStderr(): {
	stream: NodeJS.WritableStream;
	lines: () => string[];
} {
	const lines: string[] = [];
	const stream = {
		write(chunk: unknown) {
			lines.push(String(chunk).replace(/\n$/, ""));
			return true;
		},
	} as NodeJS.WritableStream;
	return { stream, lines: () => lines };
}

// ---------------------------------------------------------------------------
// Workspace tmpdir + presenza file.
// ---------------------------------------------------------------------------

async function createTmpDir(): Promise<string> {
	return await fs.mkdtemp(path.join(os.tmpdir(), "s01-tool-call-site-"));
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

// ---------------------------------------------------------------------------
// Helper locale: pre-popola un lock file con stato raw (identico a quello in
// `tests/unit/pending-research-lock.test.ts` ma mantenuto qui per evitare
// cross-import tra test files). Usato dal test 6 per simulare un blocker.
// ---------------------------------------------------------------------------

async function seedLockFile(
	lockPath: string,
	state: { pid: number; createdAtMs: number },
): Promise<void> {
	const dir = path.dirname(lockPath);
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(lockPath, JSON.stringify(state), "utf-8");
}

// ---------------------------------------------------------------------------
// Stub di `runDiscussionArena` con transcript deciso dal test.
// ---------------------------------------------------------------------------

const VALID_RUN_RESULT = {
	transcript: VALID_TRANSCRIPT,
	participantsUsed: ["scribe", "reviewer"],
	totalCost: 0,
	outcome: "complete" as const,
};

const FALLBACK_RUN_RESULT = {
	transcript: FALLBACK_TRANSCRIPT,
	participantsUsed: ["scribe"],
	totalCost: 0,
	outcome: "complete" as const,
};

function stubRunDiscussionArena(
	result: typeof VALID_RUN_RESULT,
): RunDiscussionArenaFn {
	return (async () => result) as RunDiscussionArenaFn;
}

// ---------------------------------------------------------------------------
// Test 1: research-decision unit → scrittura pending-research + flag true.
// ---------------------------------------------------------------------------

test("T03-1: research-decision unit → entrambi i file pending scritti, pendingResearchWritten=true, log strutturato del lock", async () => {
	const cwd = await createTmpDir();
	try {
		const { api, emit } = createDispatchingApi();
		const { stream, lines } = collectStderr();

		// Aggancia gli hook unit-aware con `research-decision` come fase attiva
		// (marker canonico della fase, riusato da index.ts via
		// `attachResearchDecisionHooks`). Il getState hook aggiorna il singleton
		// per-api osservato da `getCurrentUnitType(api)` (T01).
		attachUnitAwareHooks(api as never, { cwd } as never, {
			activeUnitTypes: new Set(["research-decision"]),
			instructionMarker: RESEARCH_INSTRUCTION_MARKER,
			instructionText: "research",
			resolveTrigger: FORCED,
			stderr: stream,
		});
		emit("unit_start", { type: "unit_start", unitType: "research-decision" });

		const execute = buildDiscussionArenaExecute(api as never, {
			runDiscussionArena: stubRunDiscussionArena(VALID_RUN_RESULT),
			stderr: stream,
		});
		const ctx = { cwd } as never;
		const result = await execute(
			"call-1",
			{
				topic: "validazione",
				participants: ["scribe"],
				rounds: 1,
			} as Parameters<typeof execute>[1],
			undefined,
			undefined,
			ctx,
		);
		const details = result.details as { pendingResearchWritten: boolean };
		assert.equal(
			details.pendingResearchWritten,
			true,
			"research-decision + extractor riuscito → scrittura osservata",
		);

		// Entrambi i file pending devono essere apparsi su disco (write-then-rename atomic).
		const { jsonPath, markdownPath } = pendingResearchPaths(cwd);
		await waitFor(
			async () => (await exists(jsonPath)) && (await exists(markdownPath)),
		);
		assert.equal(await exists(jsonPath), true);
		assert.equal(await exists(markdownPath), true);

		// JSON valido con `version: 1` + struttura estratta (3 ipotesi,
		// 2 decisioni, 3 requisiti nel fixture 03).
		const rawJson = await fs.readFile(jsonPath, "utf-8");
		const parsed = JSON.parse(rawJson);
		assert.equal(parsed.version, 1);
		assert.ok(Array.isArray(parsed.structured?.hypotheses));
		assert.ok(parsed.structured.hypotheses.length >= 1);

		// Lock canonico: `lock acquired` + `lock released` devono essere presenti.
		const logText = lines().join("\n");
		assert.match(
			logText,
			/\[discussion-arena\] pending-research: lock acquired .* pid=\d+/,
			"log lock acquired con prefisso canonico",
		);
		assert.match(
			logText,
			/\[discussion-arena\] pending-research: lock released .* pid=\d+/,
			"log lock released con prefisso canonico",
		);
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Test 2: planning unit → nessuna scrittura, flag false.
// ---------------------------------------------------------------------------

test("T03-2: planning unit → nessuna scrittura pending, pendingResearchWritten=false", async () => {
	const cwd = await createTmpDir();
	try {
		const { api, emit } = createDispatchingApi();
		const { stream } = collectStderr();

		// Attach come PLANNING (marker canonico) ma l'extract+write non parte
		// perché la condizione `capturedUnitType === "research-decision"` è false.
		attachUnitAwareHooks(api as never, { cwd } as never, {
			activeUnitTypes: new Set(["planning"]),
			instructionMarker: PLANNING_INSTRUCTION_MARKER,
			instructionText: "planning",
			resolveTrigger: FORCED,
			stderr: stream,
		});
		emit("unit_start", { type: "unit_start", unitType: "planning" });

		const execute = buildDiscussionArenaExecute(api as never, {
			runDiscussionArena: stubRunDiscussionArena(VALID_RUN_RESULT),
			stderr: stream,
		});
		const ctx = { cwd } as never;
		const result = await execute(
			"call-2",
			{
				topic: "planning",
				participants: ["scribe"],
				rounds: 1,
			} as Parameters<typeof execute>[1],
			undefined,
			undefined,
			ctx,
		);
		const details = result.details as { pendingResearchWritten: boolean };
		assert.equal(details.pendingResearchWritten, false);

		const { jsonPath, markdownPath } = pendingResearchPaths(cwd);
		assert.equal(await exists(jsonPath), false, "JSON non scritto per planning");
		assert.equal(await exists(markdownPath), false, "MD non scritto per planning");
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Test 3: unknown unit (no unit_start mai emesso) → fail-safe, niente scrittura.
// ---------------------------------------------------------------------------

test("T03-3: nessun unit_start emesso (getter fail-safe 'unknown') → nessuna scrittura, pendingResearchWritten=false", async () => {
	const cwd = await createTmpDir();
	try {
		const { api } = createDispatchingApi();
		const { stream } = collectStderr();

		// Attach ma MAI emit `unit_start`: lo stateRef resta al sentinella
		// `"unknown"` di default. Il getter fail-safe di T01 ritorna "unknown"
		// → la condizione `=== "research-decision"` è false.
		attachUnitAwareHooks(api as never, { cwd } as never, {
			activeUnitTypes: new Set(["research-decision"]),
			instructionMarker: RESEARCH_INSTRUCTION_MARKER,
			instructionText: "research",
			resolveTrigger: FORCED,
			stderr: stream,
		});

		const execute = buildDiscussionArenaExecute(api as never, {
			runDiscussionArena: stubRunDiscussionArena(VALID_RUN_RESULT),
			stderr: stream,
		});
		const ctx = { cwd } as never;
		const result = await execute(
			"call-3",
			{
				topic: "no-unit-start",
				participants: ["scribe"],
				rounds: 1,
			} as Parameters<typeof execute>[1],
			undefined,
			undefined,
			ctx,
		);
		const details = result.details as { pendingResearchWritten: boolean };
		assert.equal(details.pendingResearchWritten, false);

		const { jsonPath, markdownPath } = pendingResearchPaths(cwd);
		assert.equal(await exists(jsonPath), false);
		assert.equal(await exists(markdownPath), false);
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Test 4: extractor fallback → transcript senza sezioni canoniche.
// ---------------------------------------------------------------------------

test("T03-4: extractor fallback (transcript senza sezioni) → nessuna scrittura, flag false, log extractor: fallback model-call-needed", async () => {
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
			runDiscussionArena: stubRunDiscussionArena(FALLBACK_RUN_RESULT),
			stderr: stream,
		});
		const ctx = { cwd } as never;
		const result = await execute(
			"call-4",
			{
				topic: "fallback",
				participants: ["scribe"],
				rounds: 1,
			} as Parameters<typeof execute>[1],
			undefined,
			undefined,
			ctx,
		);
		const details = result.details as { pendingResearchWritten: boolean };
		assert.equal(
			details.pendingResearchWritten,
			false,
			"extractor fallback → niente write",
		);

		const { jsonPath, markdownPath } = pendingResearchPaths(cwd);
		assert.equal(await exists(jsonPath), false);
		assert.equal(await exists(markdownPath), false);

		// Log strutturato di fallback (prefisso canonico D053).
		const logText = lines().join("\n");
		assert.match(
			logText,
			/\[discussion-arena\] extractor: fallback model-call-needed/,
			"log di fallback dell'extractor presente",
		);
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Test 5: replay path → nessuna scrittura, flag false.
// ---------------------------------------------------------------------------

test("T03-5: replay path (params.replay) → nessuna scrittura, pendingResearchWritten=false (event log già persistito)", async () => {
	const cwd = await createTmpDir();
	try {
		const { api, emit } = createDispatchingApi();
		const { stream } = collectStderr();

		attachUnitAwareHooks(api as never, { cwd } as never, {
			activeUnitTypes: new Set(["research-decision"]),
			instructionMarker: RESEARCH_INSTRUCTION_MARKER,
			instructionText: "research",
			resolveTrigger: FORCED,
			stderr: stream,
		});
		emit("unit_start", { type: "unit_start", unitType: "research-decision" });

		// Prepariamo un event log finto (con una sola riga JSONL parsabile)
		// perché `replayDiscussionArena` cerca il file e parsa gli eventi.
		const eventsDir = path.join(cwd, ".gsd", "discussion-arena", "events");
		await fs.mkdir(eventsDir, { recursive: true });
		const eventLogPath = path.join(eventsDir, "fake-discussionArenaId.jsonl");
		await fs.writeFile(
			eventLogPath,
			JSON.stringify({
				ts: new Date().toISOString(),
				type: "discussion_arena_start",
				discussionArenaId: "fake-discussionArenaId",
			}) + "\n",
			"utf-8",
		);

		const execute = buildDiscussionArenaExecute(api as never, {
			runDiscussionArena: stubRunDiscussionArena(VALID_RUN_RESULT),
			stderr: stream,
		});
		const ctx = { cwd } as never;
		const result = await execute(
			"call-5",
			{
				topic: "replay",
				participants: ["scribe"],
				rounds: 1,
				replay: "fake-discussionArenaId",
			} as Parameters<typeof execute>[1],
			undefined,
			undefined,
			ctx,
		);
		const details = result.details as {
			pendingResearchWritten: boolean;
			replay?: boolean;
		};
		assert.equal(details.replay, true, "replay path attivato");
		assert.equal(
			details.pendingResearchWritten,
			false,
			"replay → nessuna scrittura pending-research",
		);

		const { jsonPath, markdownPath } = pendingResearchPaths(cwd);
		assert.equal(await exists(jsonPath), false);
		assert.equal(await exists(markdownPath), false);
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Test 6: write failure dentro la sezione critica (lock timeout) → NON propaga.
// ---------------------------------------------------------------------------

test("T03-6: lock timeout nella sezione critica → non propaga errore, pendingResearchWritten=false, log 'write failed (non-fatal)'", async () => {
	const cwd = await createTmpDir();
	try {
		const { api, emit } = createDispatchingApi();
		const { stream, lines } = collectStderr();

		// Pre-popola un lock valido NON stale (age 0) — il writePendingResearch
		// attenderà fino al timeout default (5000ms). Bypassiamo l'attesa
		// sovrascrivendo il lock dopo un breve delay con un lock "stale" che
		// sarà recuperato dal nostro writer. Più semplice: usiamo uno
		// `staleAfterMs=0` per il seed, così il lock è considerato subito
		// stale e il nostro writer lo recupera senza aspettare 5s. Il test
		// copre comunque la NON-propagazione dell'errore.
		const lockPath = pendingResearchLockPath(cwd);
		// Seed lock valido (stato JSON ben formato) ma con createdAtMs nel
		// passato: con `staleAfterMs=0` il lock viene considerato stale.
		// Il factory usa i default del lock (staleAfterMs=30000), quindi
		// il lock NON verrà considerato stale dall'acquire di default.
		// Workaround: blocchiamo l'attesa accettando il timeout default (5s).
		await seedLockFile(lockPath, { pid: 99999, createdAtMs: Date.now() });

		attachUnitAwareHooks(api as never, { cwd } as never, {
			activeUnitTypes: new Set(["research-decision"]),
			instructionMarker: RESEARCH_INSTRUCTION_MARKER,
			instructionText: "research",
			resolveTrigger: FORCED,
			stderr: stream,
		});
		emit("unit_start", { type: "unit_start", unitType: "research-decision" });

		const execute = buildDiscussionArenaExecute(api as never, {
			runDiscussionArena: stubRunDiscussionArena(VALID_RUN_RESULT),
			stderr: stream,
		});

		const ctx = { cwd } as never;
		const before = Date.now();
		const result = await execute(
			"call-6",
			{
				topic: "lock-timeout",
				participants: ["scribe"],
				rounds: 1,
			} as Parameters<typeof execute>[1],
			undefined,
			undefined,
			ctx,
		);
		const elapsed = Date.now() - before;
		// Tolleranza: il lock timeout default è 5000ms. Accettiamo fino a 6s.
		assert.ok(
			elapsed < 6500,
			`attesa < 6.5s (era ${elapsed}ms) — bounded dal lock timeout`,
		);

		const details = result.details as { pendingResearchWritten: boolean };
		assert.equal(
			details.pendingResearchWritten,
			false,
			"lock timeout → write non avvenuto, flag false",
		);

		// Nessun file pending scritto.
		const { jsonPath, markdownPath } = pendingResearchPaths(cwd);
		assert.equal(await exists(jsonPath), false);
		assert.equal(await exists(markdownPath), false);

		// Log strutturato "write failed (non-fatal)" presente, NON un throw
		// propagato come errore del tool (la risposta del tool è OK,
		// `details.pendingResearchWritten === false`).
		const logText = lines().join("\n");
		assert.match(
			logText,
			/\[discussion-arena\] pending-research: write failed \(non-fatal\)/,
			"log di write failure non-fatale",
		);

		// Cleanup del lock blocker che abbiamo seminato.
		await fs.rm(lockPath, { force: true });
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Test 7: runDiscussionArena che lancia → tool ritorna details di errore,
// MA con pendingResearchWritten=false (run non riuscita, niente da scrivere).
// ---------------------------------------------------------------------------

test("T03-7: runDiscussionArena che throws → details di errore con pendingResearchWritten=false (nessuna scrittura tentata)", async () => {
	const cwd = await createTmpDir();
	try {
		const { api, emit } = createDispatchingApi();
		const { stream } = collectStderr();

		attachUnitAwareHooks(api as never, { cwd } as never, {
			activeUnitTypes: new Set(["research-decision"]),
			instructionMarker: RESEARCH_INSTRUCTION_MARKER,
			instructionText: "research",
			resolveTrigger: FORCED,
			stderr: stream,
		});
		emit("unit_start", { type: "unit_start", unitType: "research-decision" });

		const throwingRunDA: RunDiscussionArenaFn = (async () => {
			throw new Error("subprocess failed");
		}) as RunDiscussionArenaFn;

		const execute = buildDiscussionArenaExecute(api as never, {
			runDiscussionArena: throwingRunDA,
			stderr: stream,
		});
		const ctx = { cwd } as never;
		const result = await execute(
			"call-7",
			{
				topic: "throw",
				participants: ["scribe"],
				rounds: 1,
			} as Parameters<typeof execute>[1],
			undefined,
			undefined,
			ctx,
		);
		const details = result.details as {
			pendingResearchWritten: boolean;
			totalCost: number;
		};
		assert.equal(details.pendingResearchWritten, false);
		assert.equal(details.totalCost, 0);

		// Nessun file pending scritto (la run è fallita prima della scrittura).
		const { jsonPath, markdownPath } = pendingResearchPaths(cwd);
		assert.equal(await exists(jsonPath), false);
		assert.equal(await exists(markdownPath), false);
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});
