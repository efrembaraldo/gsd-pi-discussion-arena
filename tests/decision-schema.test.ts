/**
 * Test unitari per la capability additiva G5 (M018/S05, T01) — helper puri
 * per la decision schema extraction. Sezioni 1-3 del task plan T01: 12 unit
 * test fail-fast su qualsiasi regressione di parsing JSON o regex
 * round-header. Sezione 4 (5 integrazione scenario) sarà aggiunta in T03
 * con spy injection su `buildDiscussionArenaExecute`.
 *
 *   Sezione 1 — parseDecisionPayload (5 test)
 *     1. JSON valido `{"choice":"approve"}` → parsed popolato, parseError null.
 *     2. JSON troncato `{"choice":"appr` → parsed null + parseError non-vuoto.
 *     3. JSON con virgolette sbagliate `{choice: approve}` → parsed null + parseError.
 *     4. JSON con commenti `// comment\n{"choice":"approve"}` → parsed null + parseError.
 *     5. Stringa vuota `""` → parsed null + parseError "empty payload".
 *
 *   Sezione 2 — extractDecisionBlocks (4 test)
 *     1. Transcript con 3 blocchi in 3 turni → 3 elementi con
 *        participantId/round corretti (uno per round).
 *     2. Transcript con testo libero prima/dopo un blocco → 1 blocco
 *        ritornato (tolleranza al free text).
 *     3. Transcript senza blocchi decision → array vuoto.
 *     4. Transcript con blocco malformed (JSON troncato dentro fence) →
 *        1 elemento con parsed null + parseError non-vuoto.
 *
 *   Sezione 3 — synthesizeFinalDecision (3 test)
 *     1. Scribe finale emette ```final-decision con consensus_level=0.85
 *        → parsed popolato + rawText consistente.
 *     2. Transcript senza scribe (no role Scribe) → null.
 *     3. Transcript con scribe che emette blocco malformed →
 *        { rawText, parsed: null, parseError !== null } con parseError
 *        non-vuoto.
 *
 * Self-sufficiency: registra gli hook ESM (`.js` -> `.ts` + stub
 * `@gsd/pi-coding-agent`) anche quando il file gira sotto `node --test`
 * senza `--import ./tests/ts-esm-loader.mjs` (es. invochi diretti).
 * Pattern replay.test.ts:43 / branch.test.ts:32.
 */

// Self-sufficiency: registra gli hook ESM (pattern replay.test.ts:43).
import "./ts-esm-loader.mjs";
import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";

import {
	buildDiscussionArenaExecute,
	type RunDiscussionArenaFn,
} from "../index.js";
import { GSD_AGENT_DIR_ENV } from "./fixtures/pi-coding-agent-stub.js";
import {
	parseDecisionPayload,
	extractDecisionBlocks,
	type ParsedDecisionBlock,
} from "../decision.js";
import {
	synthesizeFinalDecision,
	type FinalDecisionBlock,
} from "../scribe-synthesis.js";

// ════════════════════════════════════════════════════════════════════════════
// SEZIONE 1 — parseDecisionPayload (5 test)
// ════════════════════════════════════════════════════════════════════════════

test("parseDecisionPayload: JSON valido `{\"choice\":\"approve\"}` → parsed popolato, parseError null", () => {
	const result = parseDecisionPayload('{"choice":"approve"}');
	assert.equal(result.parseError, null, "parseError null su JSON valido");
	assert.deepEqual(
		result.parsed,
		{ choice: "approve" },
		"parsed popolato con l'oggetto parsed",
	);
});

test("parseDecisionPayload: JSON troncato `{\"choice\":\"appr` → parsed null + parseError non-vuoto", () => {
	const result = parseDecisionPayload('{"choice":"appr');
	assert.equal(result.parsed, null, "parsed null su JSON troncato");
	assert.ok(
		result.parseError !== null && result.parseError.length > 0,
		`parseError non-vuoto. parseError=${result.parseError}`,
	);
});

test("parseDecisionPayload: JSON con virgolette sbagliate `{choice: approve}` → parsed null + parseError non-vuoto", () => {
	const result = parseDecisionPayload("{choice: approve}");
	assert.equal(result.parsed, null, "parsed null su JSON malformato");
	assert.ok(
		result.parseError !== null && result.parseError.length > 0,
		`parseError non-vuoto. parseError=${result.parseError}`,
	);
});

test("parseDecisionPayload: JSON con commenti `// comment\\n{\"choice\":\"approve\"}` → parsed null + parseError non-vuoto", () => {
	const result = parseDecisionPayload('// comment\n{"choice":"approve"}');
	assert.equal(
		result.parsed,
		null,
		"parsed null su JSON con commenti // (JSON.parse strict, no comments)",
	);
	assert.ok(
		result.parseError !== null && result.parseError.length > 0,
		`parseError non-vuoto. parseError=${result.parseError}`,
	);
});

test("parseDecisionPayload: stringa vuota `''` → parsed null + parseError 'empty payload'", () => {
	const result = parseDecisionPayload("");
	assert.equal(result.parsed, null, "parsed null su stringa vuota");
	assert.equal(
		result.parseError,
		"empty payload",
		"parseError canonico 'empty payload' per stringa vuota",
	);
});

// ════════════════════════════════════════════════════════════════════════════
// SEZIONE 2 — extractDecisionBlocks (4 test)
// ════════════════════════════════════════════════════════════════════════════

test("extractDecisionBlocks: transcript con 3 blocchi decision in 3 turni diversi → 3 elementi con participantId/round corretti", () => {
	const transcript =
		"### Round 1 — alice (Analyst)\n" +
		"Testo libero prima del blocco.\n\n" +
		"```decision\n{\"choice\":\"approve\"}\n```\n\n" +
		"### Round 2 — bob (Builder)\n" +
		"```decision\n{\"choice\":\"reject\",\"reason\":\"coverage gap\"}\n```\n\n" +
		"### Round 3 — carol (Critic)\n" +
		"```decision\n{\"choice\":\"approve\",\"confidence\":0.7}\n```";

	const blocks: ParsedDecisionBlock[] = extractDecisionBlocks(transcript);
	assert.equal(blocks.length, 3, "3 blocchi estratti");

	assert.equal(blocks[0]?.round, 1, "blocco[0].round === 1");
	assert.equal(blocks[0]?.participantId, "alice", "blocco[0].participantId === 'alice'");
	assert.equal(blocks[0]?.parseError, null, "blocco[0] parseError null");
	assert.deepEqual(
		blocks[0]?.parsed,
		{ choice: "approve" },
		"blocco[0].parsed popolato",
	);

	assert.equal(blocks[1]?.round, 2, "blocco[1].round === 2");
	assert.equal(blocks[1]?.participantId, "bob", "blocco[1].participantId === 'bob'");
	assert.deepEqual(
		blocks[1]?.parsed,
		{ choice: "reject", reason: "coverage gap" },
		"blocco[1].parsed popolato",
	);

	assert.equal(blocks[2]?.round, 3, "blocco[2].round === 3");
	assert.equal(blocks[2]?.participantId, "carol", "blocco[2].participantId === 'carol'");
	assert.deepEqual(
		blocks[2]?.parsed,
		{ choice: "approve", confidence: 0.7 },
		"blocco[2].parsed popolato",
	);
});

test("extractDecisionBlocks: transcript con testo libero prima/dopo un blocco → tolleranza (1 blocco ritornato con round+participant corretti)", () => {
	const transcript =
		"### Round 4 — dave (Reviewer)\n" +
		"Testo libero PRIMA del blocco decision.\n\n" +
		"```decision\n{\"choice\":\"approve\"}\n```\n\n" +
		"Testo libero DOPO il blocco decision.\n";

	const blocks: ParsedDecisionBlock[] = extractDecisionBlocks(transcript);
	assert.equal(
		blocks.length,
		1,
		"esattamente 1 blocco estratto (testo libero ignorato)",
	);
	const block = blocks[0];
	assert.ok(block, "blocco definito");
	assert.equal(block?.round, 4, "round=4");
	assert.equal(block?.participantId, "dave", "participantId='dave'");
	assert.equal(block?.parseError, null, "parseError null");
	assert.deepEqual(
		block?.parsed,
		{ choice: "approve" },
		"parsed popolato correttamente nonostante il testo libero circostante",
	);
});

test("extractDecisionBlocks: transcript senza blocchi decision → array vuoto", () => {
	const transcript =
		"### Round 1 — alice (Analyst)\n" +
		"Risposta normale senza blocco decision.\n\n" +
		"### Round 2 — bob (Builder)\n" +
		"Anche qui nessun blocco fenced decision.";

	const blocks: ParsedDecisionBlock[] = extractDecisionBlocks(transcript);
	assert.equal(blocks.length, 0, "array vuoto per transcript senza blocchi");
});

test("extractDecisionBlocks: transcript con blocco malformed (JSON troncato dentro fence) → 1 elemento con parsed null + parseError non-vuoto", () => {
	const transcript =
		"### Round 1 — alice (Analyst)\n" +
		"```decision\n{\"choice\":\"appr\n```";

	const blocks: ParsedDecisionBlock[] = extractDecisionBlocks(transcript);
	assert.equal(blocks.length, 1, "esattamente 1 blocco (anche se malformed)");
	const block = blocks[0];
	assert.ok(block, "blocco definito");
	assert.equal(block?.round, 1, "round=1");
	assert.equal(block?.participantId, "alice", "participantId='alice'");
	assert.equal(block?.parsed, null, "parsed null su JSON troncato dentro fence");
	assert.ok(
		block?.parseError !== null && block.parseError.length > 0,
		`parseError non-vuoto (a differenza di array vuoto). parseError=${block?.parseError}`,
	);
});

// ════════════════════════════════════════════════════════════════════════════
// SEZIONE 3 — synthesizeFinalDecision (3 test)
// ════════════════════════════════════════════════════════════════════════════

test("synthesizeFinalDecision: scribe finale emette ```final-decision con consensus_level=0.85 → parsed popolato + rawText consistente", () => {
	const transcript =
		"### Round 1 — alice (Analyst)\n" +
		"Risposta del primo turno.\n\n" +
		"### Round 2 — bob (Builder)\n" +
		"Risposta del secondo turno.\n\n" +
		"### Round 3 — eve (Scribe)\n" +
		"## Sintesi\n\n" +
		"```final-decision\n" +
		"{\"consensus_level\":0.85,\"summary\":\"approvato con riserva\"}\n" +
		"```\n";

	const finalDecision: FinalDecisionBlock | null =
		synthesizeFinalDecision(transcript);
	assert.ok(finalDecision !== null, "finalDecision NON null");
	assert.equal(finalDecision?.parseError, null, "parseError null su JSON valido");
	const parsed = finalDecision?.parsed as {
		consensus_level: number;
		summary: string;
	} | null;
	assert.ok(parsed, "parsed definito");
	assert.equal(
		parsed?.consensus_level,
		0.85,
		"parsed.consensus_level === 0.85",
	);
	assert.equal(
		parsed?.summary,
		"approvato con riserva",
		"parsed.summary consistente",
	);
	assert.ok(
		finalDecision?.rawText.includes("consensus_level"),
		`rawText include il payload JSON originale. rawText=${finalDecision?.rawText}`,
	);
});

test("synthesizeFinalDecision: transcript senza scribe (no role Scribe) → null", () => {
	const transcript =
		"### Round 1 — alice (Analyst)\n" +
		"Risposta senza blocco final-decision.\n\n" +
		"### Round 2 — bob (Builder)\n" +
		"Anche qui nessun blocco.\n\n" +
		"### Round 3 — carol (Critic)\n" +
		"```final-decision\n" +
		"{\"consensus_level\":0.5}\n" +
		"```";

	const finalDecision: FinalDecisionBlock | null =
		synthesizeFinalDecision(transcript);
	assert.equal(
		finalDecision,
		null,
		"finalDecision null: nessun participant con role Scribe nel transcript",
	);
});

test("synthesizeFinalDecision: transcript con scribe che emette blocco malformed → { rawText, parsed: null, parseError !== null } con parseError non-vuoto", () => {
	const transcript =
		"### Round 1 — alice (Analyst)\n" +
		"Risposta del primo turno.\n\n" +
		"### Round 2 — eve (Scribe)\n" +
		"## Sintesi (parziale)\n\n" +
		"```final-decision\n" +
		"{\"consensus_level\":0.7,\"summary\":\"bla\n" +
		"```\n";

	const finalDecision: FinalDecisionBlock | null =
		synthesizeFinalDecision(transcript);
	assert.ok(
		finalDecision !== null,
		"finalDecision NON null anche su malformed (l'utente vuole sapere che esiste rotto)",
	);
	assert.equal(
		finalDecision?.parsed,
		null,
		"parsed null su JSON malformato dentro fence final-decision",
	);
	assert.ok(
		finalDecision && finalDecision.parseError !== null && finalDecision.parseError.length > 0,
		`parseError non-vuoto (NON null blocco). parseError=${finalDecision?.parseError}`,
	);
	assert.ok(
		finalDecision && finalDecision.rawText.length > 0,
		`rawText popolato (anche su malformed) per consentire debug. rawText=${JSON.stringify(finalDecision?.rawText)}`,
	);
});

// ════════════════════════════════════════════════════════════════════════════
// SEZIONE 4 — Integrazione factory (6 test, M018/S05 T03)
// ════════════════════════════════════════════════════════════════════════════
//
// 5 acceptance scenarios del ROADMAP capabilities additiva G5 esercitati via
// `buildDiscussionArenaExecute` con spy injection: il factory riceve un
// override `runDiscussionArena` che ritorna un transcript mockato (zero
// subprocess reali) e `applyDecisionSchemaEnrichment` (cablaggio T02) popola
// `details.decisions[]` + `details.finalDecision` + `details.persistDecisionWritten`
// sul main run path.
//
//   S4.1 — decisionSchema:{type:"approve-reject"} + transcript 3 blocchi ben
//         formati → details.decisions.length===3, [0].parsed.choice==="approve",
//         round/participantId corretti.
//   S4.2 — transcript con 1 blocco malformed → details.decisions[0].parsed===null
//         + parseError non-vuoto.
//   S4.3 — transcript senza blocchi decision → details.decisions.length===0 +
//         details.finalDecision===undefined.
//   S4.4 — Scribe emette ```final-decision consensus_level=0.85 →
//         details.finalDecision.parsed.consensus_level===0.85 + parseError null.
//   S4.5 — persistDecision:true → details.persistDecisionWritten===false + stderr
//         contiene il warning canonico (captureStderrText).
//   S4.6 — anti-regressione R064: run SENZA decisionSchema → details.decisions
//         undefined + details.finalDecision undefined + persistDecisionWritten
//         undefined (zero nuovi campi sul details).
//
// Pattern test isolation riusato da `tests/branch.test.ts` (makeFixture/
// track/afterEach/writeParticipant/createDispatchingApi + spy su
// `runDiscussionArena`). captureStderrText cattura l'output stderr del factory
// (che usa `options.stderr ?? process.stderr`) per asserire il warning persist.

// ─── Fixture transcript per la Sezione 4 ────────────────────────────────────

/** 3 blocchi `decision` ben formati in 3 turni (S4.1 / S4.5). */
const TRANSCRIPT_3_DECISIONS =
	"### Round 1 — alice (Analyst)\n" +
	"```decision\n{\"choice\":\"approve\"}\n```\n\n" +
	"### Round 2 — bob (Builder)\n" +
	"```decision\n{\"choice\":\"reject\",\"reason\":\"coverage gap\"}\n```\n\n" +
	"### Round 3 — carol (Critic)\n" +
	"```decision\n{\"choice\":\"approve\",\"confidence\":0.7}\n```\n";

/** 1 blocco `decision` malformato (JSON troncato dentro fence) — S4.2. */
const TRANSCRIPT_1_MALFORMED =
	"### Round 1 — alice (Analyst)\n" +
	"```decision\n{\"choice\":\"appr\n```\n";

/** Nessun blocco `decision`: solo round normali — S4.3. */
const TRANSCRIPT_NO_BLOCKS =
	"### Round 1 — alice (Analyst)\n" +
	"Risposta normale senza blocco decision.\n\n" +
	"### Round 2 — bob (Builder)\n" +
	"Anche qui nessun blocco fenced decision.\n";

/** Un turno partecipante + un Scribe che emette ```final-decision — S4.4. */
const TRANSCRIPT_SCRIBE_FINAL =
	"### Round 1 — alice (Analyst)\n" +
	"```decision\n{\"choice\":\"approve\"}\n```\n\n" +
	"### Round 2 — eve (Scribe)\n" +
	"## Sintesi\n\n" +
	"```final-decision\n" +
	"{\"consensus_level\":0.85,\"summary\":\"approved\"}\n" +
	"```\n";

// ─── Boilerplate (riuso pattern branch.test.ts) ────────────────────────────

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
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-decision-"));
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

/** Cattura il testo scritto su process.stderr.write durante `fn` (silenzia e
 *  ritorna `written`) — il factory usa `options.stderr ?? process.stderr`, e
 *  poiché `stderr` è un riferimento all'oggetto process.stderr, la reassign di
 *  `.write` intercetta il warning persistDecision (S4.5). */
async function captureStderrText<T>(
	fn: () => Promise<T>,
): Promise<{ result: T; written: string }> {
	const original = process.stderr.write.bind(process.stderr);
	let written = "";
	process.stderr.write = ((chunk: unknown, ..._rest: unknown[]) => {
		written += String(chunk);
		return true;
	}) as unknown as typeof process.stderr.write;
	try {
		const result = await fn();
		return { result, written };
	} finally {
		process.stderr.write = original;
	}
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

/** Facciata per allestire la fixture partecipanti + env GSD_AGENT_DIR. */
function setupDecisionsFixture(): Fixture {
	const f = makeFixture();
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");
	writeParticipant(f.userDir, "alice.md", { name: "alice", role: "Analyst" });
	writeParticipant(f.userDir, "bob.md", { name: "bob", role: "Builder" });
	writeParticipant(f.userDir, "carol.md", { name: "carol", role: "Critic" });
	return f;
}

/** Spy capturing su `runDiscussionArena`: ritorna un transcript mockato fisso
 *  (zero subprocess reale). Il factory main path consuma transcript +
 *  participantsUsed/totalCost/outcome dal result del runner. */
function spyRunDiscussionArenaTranscript(transcript: string): {
	stub: RunDiscussionArenaFn;
	wasCalled: () => boolean;
} {
	let called = false;
	const stub: RunDiscussionArenaFn = (async () => {
		called = true;
		return {
			transcript,
			participantsUsed: ["alice", "bob", "carol"],
			totalCost: 0.003,
			outcome: "complete" as const,
		};
	}) as RunDiscussionArenaFn;
	return { stub, wasCalled: () => called };
}

// ─── S4.1: happy path 3 blocchi ben formati ──────────────────────────────

test("(S4.1) run con decisionSchema approve-reject + transcript 3 blocchi → details.decisions.length===3, [0].parsed.choice==='approve', round/participantId corretti", async () => {
	const f = setupDecisionsFixture();
	const { stub, wasCalled } = spyRunDiscussionArenaTranscript(TRANSCRIPT_3_DECISIONS);

	const execute = buildDiscussionArenaExecute(
		createDispatchingApi().api as never,
		{ runDiscussionArena: stub },
	);
	const ctx = { cwd: f.cwd } as never;

	const { result } = await captureStderrText(() =>
		execute(
			"call-dec-4-1",
			{
				topic: "topic-decisions",
				participants: ["alice", "bob", "carol"],
				rounds: 1,
				decisionSchema: { type: "approve-reject" },
			} as Parameters<typeof execute>[1],
			undefined,
			undefined,
			ctx,
		),
	);

	assert.equal(wasCalled(), true, "runDA invocato dal factory (main path)");

	const details = result.details as Record<string, unknown>;
	const decisions = details.decisions as Array<{
		participantId: string;
		round: number;
		parsed: unknown;
		parseError: string | null;
	}>;
	assert.ok(Array.isArray(decisions), "details.decisions è un array");
	assert.equal(decisions.length, 3, "details.decisions.length === 3");

	const d0 = decisions[0];
	assert.ok(d0, "decisions[0] presente");
	assert.ok(d0 && d0.parsed && typeof d0.parsed === "object");
	const parsed0 = d0?.parsed as { choice: string };
	assert.equal(parsed0.choice, "approve", "decisions[0].parsed.choice === 'approve'");
	assert.equal(d0?.round, 1, "decisions[0].round === 1");
	assert.equal(d0?.participantId, "alice", "decisions[0].participantId === 'alice'");
	assert.equal(d0?.parseError, null, "decisions[0].parseError null");

	assert.equal(decisions[1]?.round, 2, "decisions[1].round === 2");
	assert.equal(decisions[1]?.participantId, "bob", "decisions[1].participantId === 'bob'");
	assert.equal(decisions[2]?.round, 3, "decisions[2].round === 3");
	assert.equal(decisions[2]?.participantId, "carol", "decisions[2].participantId === 'carol'");

	delete process.env[GSD_AGENT_DIR_ENV];
});

// ─── S4.2: 1 blocco malformed ─────────────────────────────────────────

test("(S4.2) run con 1 blocco decision malformed → details.decisions[0].parsed===null + parseError non-vuoto", async () => {
	const f = setupDecisionsFixture();
	const { stub } = spyRunDiscussionArenaTranscript(TRANSCRIPT_1_MALFORMED);

	const execute = buildDiscussionArenaExecute(
		createDispatchingApi().api as never,
		{ runDiscussionArena: stub },
	);
	const ctx = { cwd: f.cwd } as never;

	const { result } = await captureStderrText(() =>
		execute(
			"call-dec-4-2",
			{
				topic: "topic-decisions-malformed",
				participants: ["alice", "bob", "carol"],
				rounds: 1,
				decisionSchema: { type: "approve-reject" },
			} as Parameters<typeof execute>[1],
			undefined,
			undefined,
			ctx,
		),
	);

	const details = result.details as Record<string, unknown>;
	const decisions = details.decisions as Array<{
		parsed: unknown;
		parseError: string | null;
	}>;
	assert.ok(Array.isArray(decisions), "details.decisions è un array");
	assert.equal(decisions.length, 1, "1 blocco malformed estratto");
	assert.equal(decisions[0]?.parsed, null, "decisions[0].parsed === null");
	assert.ok(
		decisions[0]?.parseError && decisions[0].parseError.length > 0,
		`decisions[0].parseError non-vuoto. parseError=${decisions[0]?.parseError}`,
	);

	delete process.env[GSD_AGENT_DIR_ENV];
});

// ─── S4.3: nessun blocco decision ─────────────────────────────────────

test("(S4.3) run con transcript senza blocchi decision → details.decisions.length===0 + details.finalDecision===undefined", async () => {
	const f = setupDecisionsFixture();
	const { stub } = spyRunDiscussionArenaTranscript(TRANSCRIPT_NO_BLOCKS);

	const execute = buildDiscussionArenaExecute(
		createDispatchingApi().api as never,
		{ runDiscussionArena: stub },
	);
	const ctx = { cwd: f.cwd } as never;

	const { result } = await captureStderrText(() =>
		execute(
			"call-dec-4-3",
			{
				topic: "topic-decisions-noblocks",
				participants: ["alice", "bob", "carol"],
				rounds: 1,
				decisionSchema: { type: "approve-reject" },
			} as Parameters<typeof execute>[1],
			undefined,
			undefined,
			ctx,
		),
	);

	const details = result.details as Record<string, unknown>;
	const decisions = details.decisions as unknown[];
	assert.ok(Array.isArray(decisions), "details.decisions è un array (vuoto)");
	assert.equal(decisions.length, 0, "details.decisions.length === 0 (no decision block found)");
	assert.equal(
		details.finalDecision,
		undefined,
		"details.finalDecision === undefined (nessun Scribe con blocco finale)",
	);

	delete process.env[GSD_AGENT_DIR_ENV];
});

// ─── S4.4: Scribe emette ```final-decision ────────────────────────────

test("(S4.4) scribe synthesis con consensus_level=0.85 → details.finalDecision.parsed.consensus_level===0.85 + parseError null", async () => {
	const f = setupDecisionsFixture();
	const { stub } = spyRunDiscussionArenaTranscript(TRANSCRIPT_SCRIBE_FINAL);

	const execute = buildDiscussionArenaExecute(
		createDispatchingApi().api as never,
		{ runDiscussionArena: stub },
	);
	const ctx = { cwd: f.cwd } as never;

	const { result } = await captureStderrText(() =>
		execute(
			"call-dec-4-4",
			{
				topic: "topic-decisions-scribe",
				participants: ["alice", "bob", "carol"],
				rounds: 1,
				decisionSchema: { type: "approve-reject" },
			} as Parameters<typeof execute>[1],
			undefined,
			undefined,
			ctx,
		),
	);

	const details = result.details as Record<string, unknown>;
	assert.ok(details.finalDecision, "details.finalDecision NON undefined");
	const finalDecision = details.finalDecision as {
		parsed: { consensus_level: number } | null;
		parseError: string | null;
	};
	assert.ok(
		finalDecision.parsed && typeof finalDecision.parsed === "object",
		"details.finalDecision.parsed popolato",
	);
	assert.equal(
		finalDecision.parsed?.consensus_level,
		0.85,
		"details.finalDecision.parsed.consensus_level === 0.85",
	);
	assert.equal(
		finalDecision.parseError,
		null,
		"details.finalDecision.parseError === null (JSON scribe valido)",
	);

	delete process.env[GSD_AGENT_DIR_ENV];
});

// ─── S4.5: persistDecision:true → warning stderr + flag false ─────────

test("(S4.5) run con persistDecision:true → details.persistDecisionWritten===false + stderr contiene warning canonico (captureStderrText)", async () => {
	const f = setupDecisionsFixture();
	const { stub } = spyRunDiscussionArenaTranscript(TRANSCRIPT_3_DECISIONS);

	const execute = buildDiscussionArenaExecute(
		createDispatchingApi().api as never,
		{ runDiscussionArena: stub },
	);
	const ctx = { cwd: f.cwd } as never;

	const { result, written } = await captureStderrText(() =>
		execute(
			"call-dec-4-5",
			{
				topic: "topic-decisions-persist",
				participants: ["alice", "bob", "carol"],
				rounds: 1,
				decisionSchema: { type: "approve-reject" },
				persistDecision: true,
			} as Parameters<typeof execute>[1],
			undefined,
			undefined,
			ctx,
		),
	);

	const details = result.details as Record<string, unknown>;
	assert.equal(
		details.persistDecisionWritten,
		false,
		"details.persistDecisionWritten === false (stub best-effort, MCP writer assente)",
	);
	assert.ok(
		written.includes(
			"[discussion-arena] warning: persistDecision requested but MCP writer not implemented",
		),
		`stderr contiene il warning canonico persistDecision. written=${JSON.stringify(written)}`,
	);

	delete process.env[GSD_AGENT_DIR_ENV];
});

// ─── S4.6: anti-regressione R064 — senza decisionSchema zero campi ────

test("(S4.6) anti-regressione R064: run SENZA decisionSchema → details.decisions undefined + details.finalDecision undefined + persistDecisionWritten undefined", async () => {
	const f = setupDecisionsFixture();
	// Anche un transcript con blocchi scribe: senza decisionSchema l'enrichment
	// NON deve girare → zero nuovi campi (R064 backward-compat).
	const { stub } = spyRunDiscussionArenaTranscript(TRANSCRIPT_SCRIBE_FINAL);

	const execute = buildDiscussionArenaExecute(
		createDispatchingApi().api as never,
		{ runDiscussionArena: stub },
	);
	const ctx = { cwd: f.cwd } as never;

	const { result } = await captureStderrText(() =>
		execute(
			"call-dec-4-6",
			{
				topic: "topic-decisions-no-schema",
				participants: ["alice", "bob", "carol"],
				rounds: 1,
				// NOTA: nessun `decisionSchema` (default R064).
			} as Parameters<typeof execute>[1],
			undefined,
			undefined,
			ctx,
		),
	);

	const details = result.details as Record<string, unknown>;
	assert.equal(
		details.decisions,
		undefined,
		"details.decisions === undefined (R064: nessun campo nuovo senza decisionSchema)",
	);
	assert.equal(
		details.finalDecision,
		undefined,
		"details.finalDecision === undefined (R064)",
	);
	assert.equal(
		details.persistDecisionWritten,
		undefined,
		"details.persistDecisionWritten === undefined (R064)",
	);

	delete process.env[GSD_AGENT_DIR_ENV];
});