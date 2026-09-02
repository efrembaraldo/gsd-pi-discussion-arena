/**
 * Test della capability additive `replay: Type.Optional(Type.String())` sul
 * tool `discussion_arena`, introdotta in M018/S03 (T01 export `isValidReplayId`
 * + `events` su `replayDiscussionArena`, T02 export `extractReplayMetrics`,
 * T03 4 guard-rail di runtime nel corto-circuito di `buildDiscussionArenaExecute`).
 *
 * 4 scenari canonici (must-have R057 + D144):
 *
 *   1. replay valido (loop-level + factory-level): genera l'event log via
 *      `runDiscussionArena(..., eventLog: true)`, poi chiama la factory con
 *      `params.replay = out.discussionArenaId`. Asserzioni su `details.replay`
 *      uniforme (`id`, `source`, `restoredRounds`, `restoredCost`,
 *      `restoredOutcome`) e sul marker arricchito inline. Spy sul
 *      `runDiscussionArena` della factory per confermare "nessun subprocess
 *      rieseguito" sul path replay (il `runDiscussionArena` reale è stato
 *      chiamato solo per generare l'event log, non dalla factory).
 *   2. replay con formato invalido (factory-level, R057): `params.replay = "abc"`.
 *      Short-circuit PRIMA dell'I/O. Asserzioni su `invalid replay id format`,
 *      `details.replay: { id: "abc", source, restoredRounds: 0, restoredCost: 0,
 *      restoredOutcome: "unknown" }` e spy su `runDiscussionArena` che conferma
 *      la NON invocazione (ID invalido scartato prima del try-call).
 *   3. replay con event log assente (factory-level, D144): ID hex32 valido
 *      (`crypto.randomBytes(16).toString("hex")`), file non presente. Ramo 2
 *      condiviso con scenario 4. `onUpdate` invocato 1 volta con marker
 *      "## Discussion Arena — replay (partial)". Text ritornato
 *      "event log too short: 0 events for <id>".
 *   4. replay con event log short 1 evento (factory-level, D144): scrivi
 *      manualmente `.gsd/discussion-arena/events/<id>.jsonl` con 1 riga
 *      `{"ts":"...","type":"discussion_arena_start"}`. Text ritornato
 *      "event log too short: 1 events for <id>". `onUpdate` invocato 1 volta.
 *
 * Boilerplate riusato (NO cross-import per isolare failure):
 *   - writeParticipant / makeFixture / track / afterEach / okTurn /
 *     createDispatchingApi / createTmpDir — pattern
 *     `tests/streaming.test.ts:64-180`.
 *
 * Self-sufficiency: registra gli hook ESM (`.js` -> `.ts` + stub
 * `@gsd/pi-coding-agent`) anche quando il file gira sotto `node --test`
 * senza `--import ./tests/ts-esm-loader.mjs` (es. invochi diretti).
 */

// Self-sufficiency: registra gli hook ESM (pattern streaming.test.ts:43).
import "./ts-esm-loader.mjs";
import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";

import {
	runDiscussionArena,
	buildDiscussionArenaExecute,
	type RunDiscussionArenaFn,
	type RunTurnFn,
} from "../index.js";
import {
	discussionArenaEventLogPath,
	replayDiscussionArena,
	isValidReplayId,
	extractReplayMetrics,
} from "../replay.js";
import type { DiscussionArenaEvent } from "../helpers.js";
import type { ParticipantTurnResult } from "../run-participant.js";
import { GSD_AGENT_DIR_ENV } from "./fixtures/pi-coding-agent-stub.js";

// ─── Fixture helpers (pattern tests/streaming.test.ts:64-180) ───────────────

/** Scrive un partecipante .md minimale (name/role/description) in `dir`. */
function writeParticipant(
	dir: string,
	filename: string,
	opts: { name: string; role: string; description?: string },
): void {
	const rows = [
		`name: ${opts.name}`,
		`role: ${opts.role}`,
		`description: ${opts.description ?? opts.name}`,
	];
	fs.writeFileSync(
		path.join(dir, filename),
		`---\n${rows.join("\n")}\n---\n\nSystem prompt di ${opts.name}.\n`,
		"utf-8",
	);
}

interface Fixture {
	root: string;
	userDir: string;
	cwd: string;
}

function makeFixture(): Fixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-replay-"));
	const userDir = path.join(root, "agent", "discussion-arena", "participants");
	fs.mkdirSync(userDir, { recursive: true });
	return { root, userDir, cwd: root };
}

const activeFixtures: string[] = [];
function track(root: string): void {
	activeFixtures.push(root);
}
afterEach(() => {
	for (const root of activeFixtures.splice(0)) {
		try {
			fs.rmSync(root, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	}
});

/** Silenzia process.stderr.write durante `fn` (log dei limiti risolti). */
async function captureStderr<T>(fn: () => Promise<T>): Promise<T> {
	const original = process.stderr.write.bind(process.stderr);
	process.stderr.write = (() => true) as unknown as typeof process.stderr.write;
	try {
		return await fn();
	} finally {
		process.stderr.write = original;
	}
}

/** Turno di successo deterministico. `cost > 0` per popolare `totalCost` sugli
 *  eventi emessi dal loop — necessario per `restoredCost > 0` nello scenario 1. */
function okTurn(name: string, role: string): ParticipantTurnResult {
	return {
		participant: name,
		role,
		exitCode: 0,
		text: `${name} risponde`,
		stderr: "",
		usage: { input: 1, output: 1, cost: 0.001, turns: 1 },
		durationMs: 100,
	};
}

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

async function createTmpDir(): Promise<string> {
	return await fsPromises.mkdtemp(path.join(os.tmpdir(), "gsd-replay-factory-"));
}

/** Stub di `runDiscussionArena` che fallisce il test se invocato.
 *  Usato negli scenari 1 e 2 per confermare "nessun subprocess rieseguito"
 *  sul path replay (il corto-circuito R057/D144 short-circuita prima
 *  della chiamata al runner). */
function spyRunDiscussionArena(label: string): {
	stub: RunDiscussionArenaFn;
	wasCalled: () => boolean;
} {
	let called = false;
	const stub: RunDiscussionArenaFn = (async () => {
		called = true;
		throw new Error(
			`runDiscussionArena MUST NOT be called on the replay path (${label})`,
		);
	}) as RunDiscussionArenaFn;
	return { stub, wasCalled: () => called };
}

// ─── Scenario 1: replay valido (loop-level + factory-level) ────────────────

test("replay valido: event log generato via runDiscussionArena(eventLog: true), factory restituisce transcript identico + details.replay uniforme (R057+D144 happy path)", async () => {
	const f = makeFixture();
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");

	writeParticipant(f.userDir, "alice.md", { name: "alice", role: "Analyst" });
	writeParticipant(f.userDir, "bob.md", { name: "bob", role: "Builder" });
	writeParticipant(f.userDir, "carol.md", { name: "carol", role: "Critic" });

	const runTurn: RunTurnFn = async (participant) => okTurn(participant.name, participant.role);

	// Loop-level: genera l'event log JSONL su disco via runDiscussionArena con
	// eventLog=true. Il 12° argomento della firma attiva la scrittura
	// persistente (M003/S07) e popola `discussionArenaId` nel return.
	const out = await captureStderr(() =>
		runDiscussionArena(
			"topic replay valido",
			["alice", "bob", "carol"],
			1, // rounds
			f.cwd,
			undefined, // signal
			() => {}, // onProgress
			undefined,
			undefined,
			undefined,
			undefined,
			runTurn,
			true, // eventLog = 12° argomento
		),
	);

	// Sanity: out.discussionArenaId presente e valido (randomUUID con dashes,
	// accettato dalla regex permissiva R057).
	assert.ok(
		typeof out.discussionArenaId === "string" && out.discussionArenaId.length > 0,
		`out.discussionArenaId presente: ${out.discussionArenaId}`,
	);
	assert.ok(
		isValidReplayId(out.discussionArenaId),
		`discussionArenaId valido per la regex permissiva R057: ${out.discussionArenaId}`,
	);

	// Sanity: l'event log esiste effettivamente su disco (loop-level ha
	// persistito il file). Failure qui = bug del runner, non del replay.
	const logPath = discussionArenaEventLogPath(f.cwd, out.discussionArenaId);
	assert.ok(fs.existsSync(logPath), `event log esiste su disco: ${logPath}`);

	// Factory-level: la factory NON deve chiamare il suo `runDiscussionArena`
	// perché il replay short-circuita prima della chiamata al runner
	// (R057+D144 happy path → nessun subprocess rieseguito). Spy sullo stub
	// passato via options, fail-hard se invocato.
	const { api } = createDispatchingApi();
	const { stub: spyStub, wasCalled } = spyRunDiscussionArena("scenario 1 replay valido");

	const execute = buildDiscussionArenaExecute(api as never, {
		runDiscussionArena: spyStub,
	});
	const ctx = { cwd: f.cwd } as never;
	const result = await execute(
		"call-replay-1",
		{
			topic: "topic replay valido",
			participants: ["alice", "bob", "carol"],
			rounds: 1,
			replay: out.discussionArenaId,
		} as Parameters<typeof execute>[1],
		undefined, // signal
		undefined, // onUpdate (non invocato sul happy path: nessun partial)
		ctx,
	);

	// Spy NON chiamato dalla factory (R057+D144: replay completo, no subprocess).
	assert.equal(
		wasCalled(),
		false,
		"runDiscussionArena della factory NON invocato sul path replay (nessun subprocess rieseguito)",
	);

	// Asserzioni su details.replay strutturato (4 campi uniformi, T03).
	const details = result.details as Record<string, unknown>;
	const replayDetails = details.replay as Record<string, unknown>;
	assert.ok(replayDetails, "details.replay presente");
	assert.equal(replayDetails.id, out.discussionArenaId, "details.replay.id === out.discussionArenaId");
	assert.equal(
		replayDetails.source,
		logPath,
		`details.replay.source === <computed path>. atteso=${logPath}, ottenuto=${replayDetails.source}`,
	);
	assert.ok(
		typeof replayDetails.restoredRounds === "number" && replayDetails.restoredRounds >= 1,
		`restoredRounds >= 1 (round completato). ottenuto=${replayDetails.restoredRounds}`,
	);
	assert.ok(
		typeof replayDetails.restoredCost === "number" && replayDetails.restoredCost > 0,
		`restoredCost > 0 (okTurn ha cost 0.001 × 3 participants). ottenuto=${replayDetails.restoredCost}`,
	);
	assert.equal(
		replayDetails.restoredOutcome,
		"complete",
		`restoredOutcome === "complete" (tutti i turni okTurn). ottenuto=${replayDetails.restoredOutcome}`,
	);

	// pendingResearchWritten: false sul path replay (mai scritto pending-research
	// perché il replay non riesegue la run).
	assert.equal(
		details.pendingResearchWritten,
		false,
		"pendingResearchWritten === false sul path replay (nessuna write-side)",
	);

	// Marker arricchito (R057+D144: "replay da event log" + "Eventi riprodotti:").
	const text = (result.content[0] as { type: "text"; text: string }).text;
	assert.ok(
		text.includes("## Discussion Arena — replay"),
		`text contiene "## Discussion Arena — replay". text=${JSON.stringify(text.slice(0, 200))}`,
	);
	assert.ok(
		text.includes("Eventi riprodotti:"),
		`text contiene "Eventi riprodotti:". text=${JSON.stringify(text.slice(0, 200))}`,
	);
	assert.ok(
		text.includes("replay da event log"),
		`text contiene "replay da event log" (marker arricchito). text=${JSON.stringify(text.slice(0, 200))}`,
	);
	assert.ok(
		text.includes(out.discussionArenaId),
		`text contiene l'ID. text=${JSON.stringify(text.slice(0, 200))}`,
	);
	assert.ok(
		text.includes(logPath),
		`text contiene il path source. text=${JSON.stringify(text.slice(0, 200))}`,
	);

	delete process.env[GSD_AGENT_DIR_ENV];
});

// ─── Scenario 2: replay con formato invalido (R057 factory-level) ───────────

test("replay con formato invalido: ID short-circuita prima dell'I/O, errore 'invalid replay id format' + details.replay uniforme (R057)", async () => {
	const cwd = await createTmpDir();
	try {
		const { api } = createDispatchingApi();
		const { stub: spyStub, wasCalled } = spyRunDiscussionArena("scenario 2 formato invalido");

		const execute = buildDiscussionArenaExecute(api as never, {
			runDiscussionArena: spyStub,
		});
		const ctx = { cwd } as never;
		const result = await execute(
			"call-replay-2",
			{
				topic: "topic invalid",
				participants: ["alice"],
				rounds: 1,
				replay: "abc", // formato invalido per R057 (32 hex o UUID v4 dashed)
			} as Parameters<typeof execute>[1],
			undefined,
			undefined,
			ctx,
		);

		// Spy NON chiamato (R057 short-circuit prima di I/O → niente runner).
		assert.equal(
			wasCalled(),
			false,
			"runDiscussionArena NON invocato: ID invalido scartato prima del try-call",
		);

		// Asserzioni su details.replay strutturato uniforme (anche su Ramo 1).
		const details = result.details as Record<string, unknown>;
		const replayDetails = details.replay as Record<string, unknown>;
		assert.ok(replayDetails, "details.replay presente anche sul Ramo 1 (R057)");
		assert.equal(replayDetails.id, "abc", "details.replay.id === 'abc' (l'ID invalido viene echoato)");
		const expectedSource = discussionArenaEventLogPath(cwd, "abc");
		assert.equal(
			replayDetails.source,
			expectedSource,
			`details.replay.source === <computed path> (anche su ID invalido, per debug). atteso=${expectedSource}`,
		);
		assert.equal(replayDetails.restoredRounds, 0, "details.replay.restoredRounds === 0");
		assert.equal(replayDetails.restoredCost, 0, "details.replay.restoredCost === 0");
		assert.equal(
			replayDetails.restoredOutcome,
			"unknown",
			`details.replay.restoredOutcome === "unknown". ottenuto=${replayDetails.restoredOutcome}`,
		);
		assert.equal(
			details.pendingResearchWritten,
			false,
			"pendingResearchWritten === false sul Ramo 1 (nessuna write-side)",
		);

		// Text: messaggio canonico R057.
		const text = (result.content[0] as { type: "text"; text: string }).text;
		assert.ok(
			text.includes("invalid replay id format: abc"),
			`text contiene "invalid replay id format: abc". text=${JSON.stringify(text)}`,
		);
	} finally {
		await fsPromises.rm(cwd, { recursive: true, force: true });
	}
});

// ─── Scenario 3: replay con event log assente (D144 Ramo 2) ─────────────────

test("replay con event log assente: ID hex32 valido ma file non presente, onUpdate '(partial)' + text 'event log too short: 0 events' (D144)", async () => {
	const cwd = await createTmpDir();
	try {
		const { api } = createDispatchingApi();
		// Spy stub: NON deve essere chiamato (D144 Ramo 2: replay null → no runner).
		const { stub: spyStub, wasCalled } = spyRunDiscussionArena("scenario 3 log assente");

		const execute = buildDiscussionArenaExecute(api as never, {
			runDiscussionArena: spyStub,
		});

		// ID hex32 valido via crypto.randomBytes (32 char, formato R057), ma
		// file NON presente (cwd vuoto, nessun event log scritto).
		const validHexId = crypto.randomBytes(16).toString("hex");
		assert.equal(validHexId.length, 32, `ID hex32 valido: ${validHexId}`);
		assert.ok(
			isValidReplayId(validHexId),
			`ID hex32 passa la regex R057: ${validHexId}`,
		);

		// Spy su onUpdate: cattura le invocazioni della callback 4° argomento.
		const onUpdateCalls: Array<{ content: Array<{ type: string; text: string }> }> = [];
		const onUpdate = (update: unknown) => {
			onUpdateCalls.push(
				update as { content: Array<{ type: string; text: string }> },
			);
		};

		const ctx = { cwd } as never;
		const result = await execute(
			"call-replay-3",
			{
				topic: "topic log assente",
				participants: ["alice"],
				rounds: 1,
				replay: validHexId,
			} as Parameters<typeof execute>[1],
			undefined,
			onUpdate,
			ctx,
		);

		// Spy NON chiamato (Ramo 2: replay null → mai arriva al runner).
		assert.equal(
			wasCalled(),
			false,
			"runDiscussionArena NON invocato sul Ramo 2 (replay null prima del try-call)",
		);

		// onUpdate invocato ESATTAMENTE 1 volta con marker "(partial)".
		assert.equal(
			onUpdateCalls.length,
			1,
			`onUpdate invocato 1 volta (D144 Ramo 2). onUpdateCalls.length=${onUpdateCalls.length}`,
		);
		const firstUpdateText = onUpdateCalls[0]?.content[0]?.text ?? "";
		assert.ok(
			firstUpdateText.includes("## Discussion Arena — replay (partial)"),
			`onUpdate text contiene "## Discussion Arena — replay (partial)". text=${JSON.stringify(firstUpdateText)}`,
		);

		// Text ritornato: "event log too short: 0 events for <id>".
		const text = (result.content[0] as { type: "text"; text: string }).text;
		assert.ok(
			text.includes(`event log too short: 0 events for ${validHexId}`),
			`text contiene "event log too short: 0 events for <id>". text=${JSON.stringify(text)}`,
		);

		// details.replay uniforme anche su Ramo 2 (zero parziale).
		const details = result.details as Record<string, unknown>;
		const replayDetails = details.replay as Record<string, unknown>;
		assert.ok(replayDetails, "details.replay presente anche sul Ramo 2 (D144)");
		assert.equal(replayDetails.id, validHexId, "details.replay.id === <hex32>");
		assert.equal(
			replayDetails.source,
			discussionArenaEventLogPath(cwd, validHexId),
			"details.replay.source === <computed path>",
		);
		assert.equal(replayDetails.restoredRounds, 0, "details.replay.restoredRounds === 0");
		assert.equal(replayDetails.restoredCost, 0, "details.replay.restoredCost === 0");
		assert.equal(
			replayDetails.restoredOutcome,
			"unknown",
			"details.replay.restoredOutcome === \"unknown\" (log assente)",
		);
		assert.equal(
			details.pendingResearchWritten,
			false,
			"pendingResearchWritten === false sul Ramo 2",
		);
	} finally {
		await fsPromises.rm(cwd, { recursive: true, force: true });
	}
});

// ─── Scenario 4: replay con event log short 1 evento (D144 Ramo 2) ──────────

test("replay con event log short 1 evento: file scritto manualmente, onUpdate '(partial)' + text 'event log too short: 1 events' (D144)", async () => {
	const cwd = await createTmpDir();
	try {
		const { api } = createDispatchingApi();
		const { stub: spyStub, wasCalled } = spyRunDiscussionArena("scenario 4 log short");

		const execute = buildDiscussionArenaExecute(api as never, {
			runDiscussionArena: spyStub,
		});

		// ID hex32 valido + file JSONL con 1 solo evento (discussion_arena_start).
		// eventCount=1 < soglia D144=3 → Ramo 2 (partial).
		const shortId = crypto.randomBytes(16).toString("hex");
		const logPath = discussionArenaEventLogPath(cwd, shortId);
		fs.mkdirSync(path.dirname(logPath), { recursive: true });
		const singleEvent: DiscussionArenaEvent = {
			ts: "2026-08-16T09:00:00.000Z",
			type: "discussion_arena_start",
			topic: "short log",
			participants: ["alice"],
			rounds: 1,
		};
		fs.writeFileSync(logPath, JSON.stringify(singleEvent) + "\n", "utf-8");
		assert.ok(fs.existsSync(logPath), `event log scritto: ${logPath}`);

		// Sanity: replayDiscussionArena legge il file e ritorna eventCount=1.
		const replayResult = await replayDiscussionArena(shortId, cwd);
		assert.ok(replayResult, "replayDiscussionArena ritorna non-null (file presente)");
		assert.equal(
			replayResult?.eventCount,
			1,
			`replayDiscussionArena.eventCount === 1 (1 evento). ottenuto=${replayResult?.eventCount}`,
		);

		// Spy su onUpdate.
		const onUpdateCalls: Array<{ content: Array<{ type: string; text: string }> }> = [];
		const onUpdate = (update: unknown) => {
			onUpdateCalls.push(
				update as { content: Array<{ type: string; text: string }> },
			);
		};

		const ctx = { cwd } as never;
		const result = await execute(
			"call-replay-4",
			{
				topic: "topic log short",
				participants: ["alice"],
				rounds: 1,
				replay: shortId,
			} as Parameters<typeof execute>[1],
			undefined,
			onUpdate,
			ctx,
		);

		// Spy NON chiamato (Ramo 2: eventCount<3 → no runner).
		assert.equal(
			wasCalled(),
			false,
			"runDiscussionArena NON invocato sul Ramo 2 (eventCount<3 prima del try-call)",
		);

		// onUpdate invocato ESATTAMENTE 1 volta con marker "(partial)".
		assert.equal(
			onUpdateCalls.length,
			1,
			`onUpdate invocato 1 volta (D144 Ramo 2). onUpdateCalls.length=${onUpdateCalls.length}`,
		);
		const firstUpdateText = onUpdateCalls[0]?.content[0]?.text ?? "";
		assert.ok(
			firstUpdateText.includes("## Discussion Arena — replay (partial)"),
			`onUpdate text contiene "## Discussion Arena — replay (partial)". text=${JSON.stringify(firstUpdateText)}`,
		);

		// Text ritornato: "event log too short: 1 events for <id>".
		const text = (result.content[0] as { type: "text"; text: string }).text;
		assert.ok(
			text.includes(`event log too short: 1 events for ${shortId}`),
			`text contiene "event log too short: 1 events for <id>". text=${JSON.stringify(text)}`,
		);

		// details.replay uniforme anche su Ramo 2 (eventCount<3).
		const details = result.details as Record<string, unknown>;
		const replayDetails = details.replay as Record<string, unknown>;
		assert.ok(replayDetails, "details.replay presente anche su eventCount<3 (D144)");
		assert.equal(replayDetails.id, shortId, "details.replay.id === <hex32>");
		assert.equal(
			replayDetails.source,
			logPath,
			`details.replay.source === <computed path>. atteso=${logPath}`,
		);
		assert.equal(replayDetails.restoredRounds, 0, "details.replay.restoredRounds === 0");
		assert.equal(replayDetails.restoredCost, 0, "details.replay.restoredCost === 0");
		assert.equal(
			replayDetails.restoredOutcome,
			"unknown",
			"details.replay.restoredOutcome === \"unknown\" (log troppo corto per essere completo)",
		);
	} finally {
		await fsPromises.rm(cwd, { recursive: true, force: true });
	}
});

// ─── Anti-regressione cross-suite: export pubblici di replay.ts (T01+T02) ───
// Se in futuro qualcuno rinominasse o rimuovesse gli export di replay.ts
// consumati dal corto-circuito S03, questi compile-time check fallirebbero
// in TypeScript senza dover eseguire i test runtime.

test("compile-time: replay.ts esporta isValidReplayId, extractReplayMetrics, discussionArenaEventLogPath, replayDiscussionArena", () => {
	assert.equal(typeof isValidReplayId, "function", "isValidReplayId esportato come funzione");
	assert.equal(
		typeof extractReplayMetrics,
		"function",
		"extractReplayMetrics esportato come funzione pura",
	);
	assert.equal(
		typeof discussionArenaEventLogPath,
		"function",
		"discussionArenaEventLogPath esportato come funzione",
	);
	assert.equal(
		typeof replayDiscussionArena,
		"function",
		"replayDiscussionArena esportato come funzione async",
	);

	// Sanity runtime sul validator (R057): 4 acceptance cases + 2 reject cases.
	assert.equal(
		isValidReplayId("f47ac10b58cc4372a5670e02b2c3d479"),
		true,
		"32 hex lowercase → true",
	);
	assert.equal(
		isValidReplayId("F47AC10B58CC4372A5670E02B2C3D479"),
		true,
		"32 hex uppercase → true (case-insensitive)",
	);
	assert.equal(
		isValidReplayId("f47ac10b-58cc-4372-a567-0e02b2c3d479"),
		true,
		"UUID v4 con dashes → true",
	);
	assert.equal(
		isValidReplayId(crypto.randomBytes(16).toString("hex")),
		true,
		"crypto.randomBytes(16).toString('hex') → true (formato di produzione)",
	);
	assert.equal(isValidReplayId("abc"), false, '"abc" → false (troppo corto)');
	assert.equal(isValidReplayId(""), false, '"" → false (length === 0)');

	// Sanity runtime su extractReplayMetrics: eventi minimi → metriche zero.
	const emptyMetrics = extractReplayMetrics([]);
	assert.deepEqual(
		emptyMetrics,
		{ restoredRounds: 0, restoredCost: 0, restoredOutcome: "unknown" },
		"extractReplayMetrics([]) → {0, 0, 'unknown'}",
	);

	// Sanity runtime con evento done completo: outcome=complete.
	const completeMetrics = extractReplayMetrics([
		{ ts: "2026-01-01T00:00:00.000Z", type: "discussion_arena_start" },
		{ ts: "2026-01-01T00:00:01.000Z", type: "round_end", round: 1 },
		{
			ts: "2026-01-01T00:00:02.000Z",
			type: "discussion_arena_done",
			outcome: "complete",
			totalCost: 0.003,
		},
	]);
	assert.equal(completeMetrics.restoredRounds, 1, "restoredRounds da round_end");
	assert.equal(completeMetrics.restoredCost, 0.003, "restoredCost da discussion_arena_done.totalCost");
	assert.equal(completeMetrics.restoredOutcome, "complete", "restoredOutcome da done.outcome");
});
