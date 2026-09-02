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
import { test } from "node:test";
import * as assert from "node:assert/strict";

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