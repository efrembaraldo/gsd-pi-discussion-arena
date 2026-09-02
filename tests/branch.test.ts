/**
 * Test unitari per la capability additive `branch` (M018/S04, T02).
 * Sezione 1: helper puri in branch.ts — nessuna fixture subprocess
 * (writeParticipant/makeFixture/track/afterEach non servono: i due helper
 * sono funzioni pure che operano solo su stringhe e oggetti letterali).
 *
 * 8 test unit, 4 per `extractTranscriptPrefix` + 4 per `validateBranchRequest`:
 *
 *   1. extractTranscriptPrefix: afterRound=0 su transcript con 3 round → "" (vuoto)
 *   2. extractTranscriptPrefix: afterRound=2 su transcript con 3 round → primi 2 round
 *   3. extractTranscriptPrefix: afterRound=3 su transcript con 3 round → intero transcript
 *   4. extractTranscriptPrefix: afterRound=4 su transcript con 3 round → RangeError
 *   5. validateBranchRequest: request valido + parentExists=true + newTopicExists=false → { valid: true }
 *   6. validateBranchRequest: afterRound=5 su parentRounds=2 → { valid: false, error contiene "afterRound out of range" }
 *   7. validateBranchRequest: newTopic="" → { valid: false, error contiene "newTopic must be non-empty" }
 *   8. validateBranchRequest: parentExists=false → { valid: false, error contiene "parent session not found" }
 *
 * Self-sufficiency: registra gli hook ESM (`.js` -> `.ts` + stub
 * `@gsd/pi-coding-agent`) anche quando il file gira sotto `node --test`
 * senza `--import ./tests/ts-esm-loader.mjs` (es. invochi diretti).
 * Pattern replay.test.ts:43.
 */

// Self-sufficiency: registra gli hook ESM (pattern replay.test.ts:43).
import "./ts-esm-loader.mjs";
import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";

import {
	runDiscussionArena,
	buildDiscussionArenaExecute,
	type RunDiscussionArenaFn,
	type RunTurnFn,
} from "../index.js";
import {
	getSessionFilePath,
	loadSession,
	saveSession,
} from "../discussion-arena-session.js";
import type { ParticipantTurnResult } from "../run-participant.js";
import { GSD_AGENT_DIR_ENV } from "./fixtures/pi-coding-agent-stub.js";

import {
	extractTranscriptPrefix,
	validateBranchRequest,
	type BranchRequest,
} from "../branch.js";

// ─── Fixture per transcript (3 round, stile canonico senza header) ─────────

const TRANSCRIPT_3_ROUNDS =
	"### Round 1 — analyst\nr1 testo\n\n" +
	"### Round 2 — architect\nr2 testo\n\n" +
	"### Round 3 — critic\nr3 testo";

// ─── Sezione 1a: extractTranscriptPrefix (4 test) ──────────────────────────

test("extractTranscriptPrefix: afterRound=0 su transcript con 3 round → stringa vuota (no round incluso)", () => {
	const result = extractTranscriptPrefix(TRANSCRIPT_3_ROUNDS, 0);
	assert.equal(result, "", "afterRound=0 → stringa vuota (nessun round incluso)");
});

test("extractTranscriptPrefix: afterRound=2 su transcript con 3 round → primi 2 round inclusi nel prefisso", () => {
	const result = extractTranscriptPrefix(TRANSCRIPT_3_ROUNDS, 2);
	assert.equal(
		result,
		"### Round 1 — analyst\nr1 testo\n\n" +
			"### Round 2 — architect\nr2 testo",
		"prefisso contiene ESATTAMENTE i primi 2 round, separati da \\n\\n",
	);
	assert.ok(
		result.includes("### Round 1"),
		"prefisso contiene Round 1",
	);
	assert.ok(
		result.includes("### Round 2"),
		"prefisso contiene Round 2",
	);
	assert.ok(
		!result.includes("### Round 3"),
		"prefisso NON contiene Round 3 (escluso)",
	);
});

test("extractTranscriptPrefix: afterRound=3 su transcript con 3 round → intero transcript come prefisso", () => {
	const result = extractTranscriptPrefix(TRANSCRIPT_3_ROUNDS, 3);
	assert.equal(
		result,
		TRANSCRIPT_3_ROUNDS,
		"afterRound=3 (tutti i round) → prefisso identico al transcript originale (round-trip esatto sul join)",
	);
});

test("extractTranscriptPrefix: afterRound=4 su transcript con 3 round → lancia RangeError con messaggio chiaro", () => {
	assert.throws(
		() => extractTranscriptPrefix(TRANSCRIPT_3_ROUNDS, 4),
		(err: unknown) => {
			assert.ok(err instanceof RangeError, "errore è RangeError");
			const message = (err as RangeError).message;
			assert.ok(
				message.includes("afterRound=4"),
				`messaggio include 'afterRound=4'. message=${message}`,
			);
			assert.ok(
				message.includes("3"),
				`messaggio include il numero di round effettivi (3). message=${message}`,
			);
			return true;
		},
		"afterRound oltre la fine del parent deve lanciare RangeError",
	);
});

// ─── Sezione 1b: validateBranchRequest (4 test) ────────────────────────────

test("validateBranchRequest: request valido + parentExists=true + newTopicExists=false → { valid: true }", () => {
	const req: BranchRequest = {
		fromSessionId: "cwdHash-parent",
		fromTopicSlug: "parent-slug",
		afterRound: 2,
		newTopic: "new topic",
	};
	const result = validateBranchRequest(req, 3, true, false);
	assert.deepEqual(result, { valid: true }, "happy path → { valid: true }");
});

test("validateBranchRequest: afterRound=5 su parentRounds=2 → { valid: false, error contiene 'afterRound out of range' }", () => {
	const req: BranchRequest = {
		fromSessionId: "parent-id",
		fromTopicSlug: "parent-slug",
		afterRound: 5,
		newTopic: "new topic",
	};
	const result = validateBranchRequest(req, 2, true, false);
	assert.equal(result.valid, false, "afterRound oltre parentRounds → invalid");
	if (result.valid === false) {
		assert.ok(
			result.error.includes("afterRound out of range"),
			`error contiene 'afterRound out of range'. error=${result.error}`,
		);
	}
});

test("validateBranchRequest: newTopic='' → { valid: false, error contiene 'newTopic must be non-empty' }", () => {
	const req: BranchRequest = {
		fromSessionId: "parent-id",
		fromTopicSlug: "parent-slug",
		afterRound: 1,
		newTopic: "",
	};
	const result = validateBranchRequest(req, 3, true, false);
	assert.equal(result.valid, false, "newTopic vuoto → invalid");
	if (result.valid === false) {
		assert.ok(
			result.error.includes("newTopic must be non-empty"),
			`error contiene 'newTopic must be non-empty'. error=${result.error}`,
		);
	}
});

test("validateBranchRequest: parentExists=false → { valid: false, error contiene 'parent session not found' }", () => {
	const req: BranchRequest = {
		fromSessionId: "parent-id",
		fromTopicSlug: "missing-parent-slug",
		afterRound: 1,
		newTopic: "new topic",
	};
	const result = validateBranchRequest(req, 3, false, false);
	assert.equal(result.valid, false, "parent inesistente → invalid");
	if (result.valid === false) {
		assert.ok(
			result.error.includes("parent session not found"),
			`error contiene 'parent session not found'. error=${result.error}`,
		);
		assert.ok(
			result.error.includes("missing-parent-slug"),
			`error include il topic-slug del parent mancante per debug. error=${result.error}`,
		);
	}
});

// ════════════════════════════════════════════════════════════════════════════
// SEZIONE 2 — Integrazione factory (4 scenari T03, M018/S04)
// ════════════════════════════════════════════════════════════════════════════
//
// Verifica che il corto-circuito `branch` in `buildDiscussionArenaExecute`:
//   1. Valida D058 in tutte le sue forme (parent mancante, afterRound out of
//      range, newTopic pre-esistente, happy path) PRIMA di qualsiasi mutazione
//      (fail-fast, zero mutazioni, spy runDA NON invocato).
//   2. Sul happy path passi al `runDA` un `continuation` = { transcript
//      prefissato dal parent, roundOffset = afterRound } (zero modifica al
//      loop `runDiscussionArena`, riuso del parametro esistente).
//   3. Salvi la sessione figlia in `newSessionPath` CON i 3 campi parent
//      (parentSessionId, parentTopicSlug, branchedFromRound) valorizzati.
//   4. Lasci la sessione antenata INVARIATA (mtime invariato, niente
//      sovrascrittura di file esistenti).
//
// 4 scenari (anti-regressione D058):
//   S1: happy path — branch valido, spy runDA invocato 1 volta con
//       continuation corretto, nuovi campi parent valorizzati, mtime parent
//       invariato, transcript figlia inizia con i round prefissati.
//   S2: parent mancante — errore "parent session not found", spy runDA NON
//       invocato, nessun file creato per newTopic.
//   S3: afterRound > rounds — errore "afterRound out of range", spy runDA NON
//       invocato, mtime parent invariato.
//   S4: newTopic pre-esistente — errore "newTopic already exists", spy runDA
//       NON invocato, mtime file pre-esistente invariato (protezione
//       no-overwrite, transcript originale preservato).
//
// Self-sufficiency: riusa lo stesso pattern di `tests/replay.test.ts` per il
// boilerplate (writeParticipant/makeFixture/track/afterEach/okTurn/
// createDispatchingApi/createTmpDir). Spy su `runDiscussionArena` con
// fail-hard (rami errore) o capturing (happy path) per asserire il
// comportamento end-to-end senza spawn di subprocess reali.

// ─── Boilerplate: writeParticipant, makeFixture, track, afterEach ──────────

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
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-branch-"));
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

/** Genera una sessione parent via `runDiscussionArena` + `saveSession`.
 *  `runDiscussionArena` da solo NON scrive il file di sessione (la scrittura
 *  è demandata al factory `buildDiscussionArenaExecute`); questo helper
 *  colma il gap per i test integrazione che hanno bisogno di un file di
 *  sessione antenata su disco (scenario 1 happy path + scenari 3 e 4 errore). */
async function generateParentSession(
	cwd: string,
	topic: string,
	rounds: number,
	participants: string[],
	runTurn: RunTurnFn,
): Promise<string> {
	const out = await captureStderr(() =>
		runDiscussionArena(
			topic,
			participants,
			rounds,
			cwd,
			undefined, // signal
			() => {}, // onProgress
			undefined, // onRoundComplete
			undefined, // continuation (parent fresh)
			undefined, // modelOverride
			undefined, // toolLimits
			runTurn, // runTurn
			false, // eventLog
		),
	);
	const sessionPath = getSessionFilePath(cwd, topic);
	await saveSession(sessionPath, {
		topic,
		participants: out.participantsUsed,
		startedAt: new Date().toISOString(),
		lastUpdatedAt: new Date().toISOString(),
		rounds,
		transcript: out.transcript,
	});
	return sessionPath;
}

/** Turno di successo deterministico per la generazione della sessione parent
 *  via `runDiscussionArena(... , runTurn = okTurn)`. */
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
	return await fsPromises.mkdtemp(path.join(os.tmpdir(), "gsd-branch-factory-"));
}

/** Spy fail-hard su `runDiscussionArena`: lancia se invocato. Usato sui rami
 *  errore D058 (parent mancante, afterRound out of range, newTopic pre-
 *  esistente) per asserire ZERO subprocess rieseguito (fail-fast). */
function spyRunDiscussionArena(label: string): {
	stub: RunDiscussionArenaFn;
	wasCalled: () => boolean;
} {
	let called = false;
	const stub: RunDiscussionArenaFn = (async () => {
		called = true;
		throw new Error(
			`runDiscussionArena MUST NOT be called on the branch error path (${label})`,
		);
	}) as RunDiscussionArenaFn;
	return { stub, wasCalled: () => called };
}

/** Spy capturing su `runDiscussionArena`: cattura args (in particolare
 *  continuation all'8° argomento) e ritorna un result fake. Usato sul happy
 *  path per asserire che la factory chiami il runner CON il continuation
 *  corretto, senza spawn reale (test isolation). */
function spyRunDiscussionArenaCapture(): {
	stub: RunDiscussionArenaFn;
	wasCalled: () => boolean;
	getCalls: () => Array<Parameters<RunDiscussionArenaFn>>;
	getLastContinuation: () =>
		| { transcript: string; roundOffset: number }
		| undefined;
} {
	const calls: Array<Parameters<RunDiscussionArenaFn>> = [];
	const stub: RunDiscussionArenaFn = (async (
		...args: Parameters<RunDiscussionArenaFn>
	) => {
		calls.push(args);
		const continuation = args[7];
		const roundOffset = continuation?.roundOffset ?? 0;
		// Echo del continuation come base del transcript + un round finto figlio.
		// Garantisce che `transcript.startsWith(parentTranscriptPrefix)` sulla
		// figlia, requisito per l'asserzione "transcript inizia con i round
		// prefissati del parent".
		return {
			transcript:
				(continuation?.transcript ?? "") +
				`\n\n### Round ${roundOffset + 1} — alice\nrisposta figlia 1`,
			participantsUsed: ["alice", "bob", "carol"],
			totalCost: 0.003,
			outcome: "complete" as const,
		};
	}) as RunDiscussionArenaFn;
	return {
		stub,
		wasCalled: () => calls.length > 0,
		getCalls: () => calls,
		getLastContinuation: () => {
			const last = calls[calls.length - 1];
			return last?.[7];
		},
	};
}

// ─── Scenario 1: branch happy path (D058 happy path) ───────────────────────

test("branch valido: genera parent via runDiscussionArena, factory crea sessione figlia con campi parent + prefix transcript, mtime parent invariato, spy runDA invocato 1 volta con continuation corretto", async () => {
	const f = makeFixture();
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");

	writeParticipant(f.userDir, "alice.md", { name: "alice", role: "Analyst" });
	writeParticipant(f.userDir, "bob.md", { name: "bob", role: "Builder" });
	writeParticipant(f.userDir, "carol.md", { name: "carol", role: "Critic" });

	const runTurn: RunTurnFn = async (participant) =>
		okTurn(participant.name, participant.role);

	// 1) Genera sessione parent con 3 round via `runDiscussionArena` + `saveSession`.
	//    `runDiscussionArena` da solo NON scrive il file di sessione (la scrittura
	//    è nel factory); `generateParentSession` colma il gap per il test.
	const parentFilePath = await generateParentSession(
		f.cwd,
		"topic-parent",
		3, // rounds (per avere abbastanza round per afterRound=2)
		["alice", "bob", "carol"],
		runTurn,
	);
	assert.ok(
		fs.existsSync(parentFilePath),
		`session parent scritta su disco: ${parentFilePath}`,
	);

	const parentLoaded = await loadSession(parentFilePath);
	assert.ok(parentLoaded, "parent session loaded");
	assert.equal(parentLoaded?.rounds, 3, "parent ha 3 round");

	// 2) Cattura mtime parent + sleep 1100ms (per garantire granularità mtime).
	const mtimeParentBefore = (await fsPromises.stat(parentFilePath)).mtimeMs;
	await new Promise((resolve) => setTimeout(resolve, 1100));

	// 3) Spy capturing sul factory runDA (test isolation: NO spawn reale).
	const { api } = createDispatchingApi();
	const {
		stub: spyStub,
		wasCalled,
		getCalls,
		getLastContinuation,
	} = spyRunDiscussionArenaCapture();

	const execute = buildDiscussionArenaExecute(api as never, {
		runDiscussionArena: spyStub,
	});
	const ctx = { cwd: f.cwd } as never;

	const result = await execute(
		"call-branch-1",
		{
			topic: "topic-child",
			participants: ["alice", "bob", "carol"],
			rounds: 1,
			branch: {
				fromSessionId: "topic-parent",
				fromTopicSlug: "topic-parent",
				afterRound: 2,
				newTopic: "topic-child",
			},
		} as Parameters<typeof execute>[1],
		undefined, // signal
		undefined, // onUpdate
		ctx,
	);

	// Asserzione 1: spy runDA invocato 1 volta con continuation popolato.
	assert.equal(wasCalled(), true, "runDA invocato dalla factory (happy path)");
	assert.equal(
		getCalls().length,
		1,
		`runDA invocato ESATTAMENTE 1 volta. calls=${getCalls().length}`,
	);
	const continuation = getLastContinuation();
	assert.ok(continuation, "continuation passato a runDA");
	assert.equal(
		continuation?.roundOffset,
		2,
		`continuation.roundOffset === afterRound === 2. ottenuto=${continuation?.roundOffset}`,
	);
	assert.ok(
		continuation?.transcript.includes("### Round 1"),
		`continuation.transcript contiene Round 1 del parent. transcript=${JSON.stringify(continuation?.transcript.slice(0, 200))}`,
	);
	assert.ok(
		continuation?.transcript.includes("### Round 2"),
		`continuation.transcript contiene Round 2 del parent. transcript=${JSON.stringify(continuation?.transcript.slice(0, 200))}`,
	);
	assert.ok(
		!continuation?.transcript.includes("### Round 3"),
		`continuation.transcript NON contiene Round 3 (escluso da afterRound=2). transcript=${JSON.stringify(continuation?.transcript.slice(0, 200))}`,
	);

	// Asserzione 2: details.branch strutturato (campi canonici).
	const details = result.details as Record<string, unknown>;
	const branchDetails = details.branch as Record<string, unknown>;
	assert.ok(branchDetails, "details.branch presente");
	assert.equal(branchDetails.fromSessionId, "topic-parent");
	assert.equal(branchDetails.fromTopicSlug, "topic-parent");
	assert.equal(branchDetails.afterRound, 2);
	assert.equal(branchDetails.parentTranscriptRoundsKept, 2);

	// Asserzione 3: file nuovo esiste con i 3 campi parent valorizzati.
	const childFilePath = getSessionFilePath(f.cwd, "topic-child");
	assert.ok(
		fs.existsSync(childFilePath),
		`session figlia scritta: ${childFilePath}`,
	);
	const childLoaded = await loadSession(childFilePath);
	assert.ok(childLoaded, "child session loaded");
	assert.equal(
		childLoaded?.parentSessionId,
		"topic-parent",
		"parentSessionId valorizzato sulla figlia",
	);
	assert.equal(
		childLoaded?.parentTopicSlug,
		"topic-parent",
		"parentTopicSlug valorizzato sulla figlia",
	);
	assert.equal(
		childLoaded?.branchedFromRound,
		2,
		"branchedFromRound valorizzato sulla figlia",
	);

	// Asserzione 4: transcript inizia con i round 1+2 del parent.
	assert.ok(
		childLoaded?.transcript.includes("### Round 1"),
		"transcript figlia contiene Round 1 del parent",
	);
	assert.ok(
		childLoaded?.transcript.includes("### Round 2"),
		"transcript figlia contiene Round 2 del parent",
	);

	// Asserzione 5: mtime parent INVARIATO (nessuna mutazione sul file antenato).
	const mtimeParentAfter = (await fsPromises.stat(parentFilePath)).mtimeMs;
	assert.equal(
		mtimeParentAfter,
		mtimeParentBefore,
		`mtime parent INVARIATO. before=${mtimeParentBefore}, after=${mtimeParentAfter}`,
	);

	// pendingResearchWritten false sul branch happy path (no pending-research write).
	assert.equal(
		details.pendingResearchWritten,
		false,
		"pendingResearchWritten === false sul branch happy path",
	);

	// Text: marker "branch" identifica il path.
	const text = (result.content[0] as { type: "text"; text: string }).text;
	assert.ok(
		text.includes("Discussion Arena — branch"),
		`text contiene "Discussion Arena — branch". text=${JSON.stringify(text.slice(0, 200))}`,
	);

	delete process.env[GSD_AGENT_DIR_ENV];
});

// ─── Scenario 2: branch con parent mancante (D058 Ramo 1) ──────────────────

test("branch con parent mancante: errore 'parent session not found' + spy runDA NON invocato", async () => {
	const cwd = await createTmpDir();
	try {
		const { api } = createDispatchingApi();
		const { stub: spyStub, wasCalled } =
			spyRunDiscussionArena("scenario 2 parent mancante");

		const execute = buildDiscussionArenaExecute(api as never, {
			runDiscussionArena: spyStub,
		});
		const ctx = { cwd } as never;

		const result = await execute(
			"call-branch-2",
			{
				topic: "topic-child",
				participants: ["alice"],
				rounds: 1,
				branch: {
					fromSessionId: "ghost",
					fromTopicSlug: "ghost-topic",
					afterRound: 1,
					newTopic: "child",
				},
			} as Parameters<typeof execute>[1],
			undefined, // signal
			undefined, // onUpdate
			ctx,
		);

		// Spy NON chiamato (D058 Ramo 1: parent mancante → fail-fast PRIMA di runDA).
		assert.equal(
			wasCalled(),
			false,
			"runDiscussionArena NON invocato: parent mancante → fail-fast",
		);

		// Text: messaggio canonico D058.
		const text = (result.content[0] as { type: "text"; text: string }).text;
		assert.ok(
			text.includes("branch error"),
			`text contiene "branch error". text=${JSON.stringify(text)}`,
		);
		assert.ok(
			text.includes("parent session not found"),
			`text contiene "parent session not found". text=${JSON.stringify(text)}`,
		);
		assert.ok(
			text.includes("ghost-topic"),
			`text include il topic-slug del parent mancante per debug. text=${JSON.stringify(text)}`,
		);

		// details.branch strutturato (anche su ramo errore, uniform observability).
		const details = result.details as Record<string, unknown>;
		const branchDetails = details.branch as Record<string, unknown>;
		assert.ok(branchDetails, "details.branch presente anche su ramo errore");
		assert.equal(branchDetails.fromSessionId, "ghost");
		assert.equal(branchDetails.fromTopicSlug, "ghost-topic");
		assert.equal(branchDetails.afterRound, 1);
		assert.ok(
			(branchDetails.error as string).includes("parent session not found"),
			`error contiene 'parent session not found'. error=${branchDetails.error}`,
		);
		assert.equal(
			details.pendingResearchWritten,
			false,
			"pendingResearchWritten === false sul ramo errore",
		);

		// Nessun file creato (no mutazione lato filesystem).
		const childFilePath = getSessionFilePath(cwd, "child");
		assert.equal(
			fs.existsSync(childFilePath),
			false,
			"Nessun file creato per il newTopic sul ramo errore",
		);
	} finally {
		await fsPromises.rm(cwd, { recursive: true, force: true });
	}
});

// ─── Scenario 3: branch con afterRound > parent rounds (D058 Ramo 2) ────────

test("branch con afterRound > parent rounds: errore 'afterRound out of range' + spy runDA NON invocato + mtime parent invariato", async () => {
	const f = makeFixture();
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");
	writeParticipant(f.userDir, "alice.md", { name: "alice", role: "Analyst" });
	writeParticipant(f.userDir, "bob.md", { name: "bob", role: "Builder" });
	writeParticipant(f.userDir, "carol.md", { name: "carol", role: "Critic" });

	const runTurn: RunTurnFn = async (participant) =>
		okTurn(participant.name, participant.role);

	// Crea sessione parent con SOLO 2 rounds (per testare afterRound=5 > 2).
	const parentFilePath = await generateParentSession(
		f.cwd,
		"topic-parent-small",
		2, // rounds=2
		["alice", "bob", "carol"],
		runTurn,
	);
	assert.ok(
		fs.existsSync(parentFilePath),
		`parent session scritta: ${parentFilePath}`,
	);

	const mtimeParentBefore = (await fsPromises.stat(parentFilePath)).mtimeMs;
	await new Promise((resolve) => setTimeout(resolve, 1100));

	const { api } = createDispatchingApi();
	const { stub: spyStub, wasCalled } = spyRunDiscussionArena(
		"scenario 3 afterRound out of range",
	);
	const execute = buildDiscussionArenaExecute(api as never, {
		runDiscussionArena: spyStub,
	});
	const ctx = { cwd: f.cwd } as never;

	const result = await execute(
		"call-branch-3",
		{
			topic: "topic-child-too-far",
			participants: ["alice", "bob", "carol"],
			rounds: 1,
			branch: {
				fromSessionId: "topic-parent-small",
				fromTopicSlug: "topic-parent-small",
				afterRound: 5, // > parent rounds (2)
				newTopic: "topic-child-too-far",
			},
		} as Parameters<typeof execute>[1],
		undefined,
		undefined,
		ctx,
	);

	assert.equal(
		wasCalled(),
		false,
		"runDiscussionArena NON invocato: afterRound > rounds → fail-fast",
	);

	const text = (result.content[0] as { type: "text"; text: string }).text;
	assert.ok(
		text.includes("afterRound out of range"),
		`text contiene "afterRound out of range". text=${JSON.stringify(text)}`,
	);
	assert.ok(
		text.includes("5"),
		`text include afterRound=5. text=${JSON.stringify(text)}`,
	);
	assert.ok(
		text.includes("2"),
		`text include parentRounds=2. text=${JSON.stringify(text)}`,
	);

	// mtime parent INVARIATO (no mutazione).
	const mtimeParentAfter = (await fsPromises.stat(parentFilePath)).mtimeMs;
	assert.equal(
		mtimeParentAfter,
		mtimeParentBefore,
		`mtime parent INVARIATO. before=${mtimeParentBefore}, after=${mtimeParentAfter}`,
	);

	delete process.env[GSD_AGENT_DIR_ENV];
});

// ─── Scenario 4: branch con newTopic pre-esistente (D058 Ramo 3) ───────────

test("branch con newTopic pre-esistente: errore 'newTopic already exists' + spy runDA NON invocato + mtime file pre-esistente invariato (no overwrite)", async () => {
	const f = makeFixture();
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");
	writeParticipant(f.userDir, "alice.md", { name: "alice", role: "Analyst" });
	writeParticipant(f.userDir, "bob.md", { name: "bob", role: "Builder" });
	writeParticipant(f.userDir, "carol.md", { name: "carol", role: "Critic" });

	const runTurn: RunTurnFn = async (participant) =>
		okTurn(participant.name, participant.role);

	// Crea parent con 3 round (real run + save su disco).
	await generateParentSession(
		f.cwd,
		"topic-parent-preexist",
		3, // rounds
		["alice", "bob", "carol"],
		runTurn,
	);

	// Crea file fittizio pre-esistente per newTopic (protezione no-overwrite D058).
	const childFilePath = getSessionFilePath(f.cwd, "topic-child-preexist");
	const preExistingTranscript = "transcript fittizio pre-esistente";
	await saveSession(childFilePath, {
		topic: "topic-child-preexist",
		participants: ["alice"],
		startedAt: new Date().toISOString(),
		lastUpdatedAt: new Date().toISOString(),
		rounds: 0,
		transcript: preExistingTranscript,
	});
	assert.ok(
		fs.existsSync(childFilePath),
		`file pre-esistente creato: ${childFilePath}`,
	);

	const mtimeChildBefore = (await fsPromises.stat(childFilePath)).mtimeMs;
	await new Promise((resolve) => setTimeout(resolve, 1100));

	const { api } = createDispatchingApi();
	const { stub: spyStub, wasCalled } = spyRunDiscussionArena(
		"scenario 4 newTopic pre-esistente",
	);
	const execute = buildDiscussionArenaExecute(api as never, {
		runDiscussionArena: spyStub,
	});
	const ctx = { cwd: f.cwd } as never;

	const result = await execute(
		"call-branch-4",
		{
			topic: "topic-child-preexist",
			participants: ["alice", "bob", "carol"],
			rounds: 1,
			branch: {
				fromSessionId: "topic-parent-preexist",
				fromTopicSlug: "topic-parent-preexist",
				afterRound: 2,
				newTopic: "topic-child-preexist",
			},
		} as Parameters<typeof execute>[1],
		undefined,
		undefined,
		ctx,
	);

	assert.equal(
		wasCalled(),
		false,
		"runDiscussionArena NON invocato: newTopic pre-esistente → fail-fast",
	);

	const text = (result.content[0] as { type: "text"; text: string }).text;
	assert.ok(
		text.includes("newTopic already exists"),
		`text contiene "newTopic already exists". text=${JSON.stringify(text)}`,
	);
	assert.ok(
		text.includes("topic-child-preexist"),
		`text include il newTopic. text=${JSON.stringify(text)}`,
	);

	// mtime file pre-esistente INVARIATO (no overwrite — protezione D058).
	const mtimeChildAfter = (await fsPromises.stat(childFilePath)).mtimeMs;
	assert.equal(
		mtimeChildAfter,
		mtimeChildBefore,
		`mtime file pre-esistente INVARIATO. before=${mtimeChildBefore}, after=${mtimeChildAfter}`,
	);

	// File pre-esistente NON sovrascritto (transcript resta quello originale).
	const existingLoaded = await loadSession(childFilePath);
	assert.equal(
		existingLoaded?.transcript,
		preExistingTranscript,
		"transcript del file pre-esistente NON sovrascritto",
	);

	delete process.env[GSD_AGENT_DIR_ENV];
});
