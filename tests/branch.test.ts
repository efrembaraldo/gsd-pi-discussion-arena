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
import { test } from "node:test";
import * as assert from "node:assert/strict";
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
