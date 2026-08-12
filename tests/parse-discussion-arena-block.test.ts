/**
 * Unit tests for src/parse-discussion-arena-block.ts (M004/S01/T01)
 *
 * Contratto del parser condiviso del blocco `discussion_arena:`:
 *   - input: le righe del corpo DOPO il marcatore di root `discussion_arena:`
 *     (root esclusa, top-level sibling esclusi);
 *   - indentation shape: sub-chiavi 2 spazi, milestone ID 4 spazi, chiavi di
 *     milestone 6 spazi;
 *   - strict:false (default, retrocompatibile): le chiavi sconosciute e le
 *     indentazioni malformate vengono saltate silenziosamente, esattamente
 *     come facevano i due parser duplicati pre-refactor;
 *   - strict:true: le chiavi sconosciute lanciano `DiscussionArenaParseError`
 *     con il nome della chiave offending e il livello di indentazione
 *     (punto d'ingresso che S02 usera per i file di override);
 *   - divergenza MID_RE risolta sulla forma permissiva: gli ID di milestone
 *     possono contenere `_` e `.` (il parser di trigger-resolver li
 *     ignorava, quello di preferences-writer li accettava).
 */

import "./ts-esm-loader.mjs";
import * as assert from "node:assert/strict";
import { test } from "node:test";

const {
	parseDiscussionArenaBlock,
	DiscussionArenaParseError,
	DISCUSSION_ARENA_MODES,
} = await import("../src/parse-discussion-arena-block.js");

test("corpo vuoto: ritorna un blocco vuoto (anche in strict:true)", () => {
	assert.deepEqual(parseDiscussionArenaBlock([]), {});
	assert.deepEqual(parseDiscussionArenaBlock([], { strict: true }), {});
});

test("nesting a 3 livelli ben formato: enabled, mode e milestones con due milestone", () => {
	const body = [
		"  enabled: true",
		"  mode: per-milestone",
		"  milestones:",
		"    M001:",
		"      enabled: true",
		"    M002:",
		"      enabled: false",
	];
	assert.deepEqual(parseDiscussionArenaBlock(body), {
		enabled: true,
		mode: "per-milestone",
		milestones: {
			M001: { enabled: true },
			M002: { enabled: false },
		},
	});
	// strict:true su un body ben formato non lancia.
	assert.deepEqual(parseDiscussionArenaBlock(body, { strict: true }), {
		enabled: true,
		mode: "per-milestone",
		milestones: {
			M001: { enabled: true },
			M002: { enabled: false },
		},
	});
});

test("chiave sconosciuta a livello 2 con strict:false: saltata e la sezione milestones si chiude", () => {
	const body = [
		"  milestones:",
		"    M001:",
		"      enabled: true",
		"  custom_key: value",
		"    M002:",
		"      enabled: true",
	];
	// Una chiave sconosciuta allo stesso livello di `milestones:` ne chiude la
	// sezione (semantica YAML dei sibling): M002 a indent 4 non e piu un ID.
	assert.deepEqual(parseDiscussionArenaBlock(body), {
		milestones: { M001: { enabled: true } },
	});
});

test("chiave sconosciuta a livello 2 con strict:false: non corrompe le chiavi note", () => {
	const body = ["  enabled: true", "  unknown: x", "  mode: availability-only"];
	assert.deepEqual(parseDiscussionArenaBlock(body), {
		enabled: true,
		mode: "availability-only",
	});
});

test("chiave sconosciuta con strict:true: lancia DiscussionArenaParseError con key e indent", () => {
	assert.throws(
		() => parseDiscussionArenaBlock(["  unknown_key: x"], { strict: true }),
		(err) => {
			if (!(err instanceof DiscussionArenaParseError)) return false;
			assert.strictEqual(err.name, "DiscussionArenaParseError");
			assert.strictEqual(err.key, "unknown_key");
			assert.strictEqual(err.indent, 2);
			assert.match(err.message, /unknown key "unknown_key"/);
			assert.match(err.message, /indent 2/);
			return true;
		},
	);
});

test("chiave sconosciuta dentro milestones con strict:true: indent 4", () => {
	const body = [
		"  milestones:",
		"    M001:",
		"      enabled: true",
		"    not_a_valid_mid!: x",
	];
	assert.throws(
		() => parseDiscussionArenaBlock(body, { strict: true }),
		(err) => {
			if (!(err instanceof DiscussionArenaParseError)) return false;
			assert.strictEqual(err.key, "not_a_valid_mid!");
			assert.strictEqual(err.indent, 4);
			return true;
		},
	);
});

test("chiave sconosciuta sotto un milestone con strict:true: indent 6", () => {
	const body = ["  milestones:", "    M001:", "      enabled: true", "      bogus: 1"];
	assert.throws(
		() => parseDiscussionArenaBlock(body, { strict: true }),
		(err) => {
			if (!(err instanceof DiscussionArenaParseError)) return false;
			assert.strictEqual(err.key, "bogus");
			assert.strictEqual(err.indent, 6);
			return true;
		},
	);
});

test("milestone ID con _ e . (forma permissiva MID_RE, divergenza risolta)", () => {
	const body = [
		"  milestones:",
		"    M_002:",
		"      enabled: true",
		"    M.003:",
		"      enabled: false",
	];
	assert.deepEqual(parseDiscussionArenaBlock(body), {
		milestones: {
			M_002: { enabled: true },
			"M.003": { enabled: false },
		},
	});
});

test("indentazione malformata con strict:false: nessun crash, parse best-effort", () => {
	const body = [
		"      deep: true", // indent 6 senza milestone corrente
		"  milestones:",
		"      M001:", // indent 6 dove servirebbe 4: non un ID
		"  enabled: true",
		"        troppo_profondo: 1", // indent 8
	];
	assert.deepEqual(parseDiscussionArenaBlock(body), {
		enabled: true,
	});
});

test("commenti e righe vuote ignorate", () => {
	const body = [
		"",
		"  # commento di blocco",
		"  enabled: true",
		"  # altro commento tra le chiavi",
		"  milestones:",
		"    M001:",
		"      enabled: true",
		"",
	];
	assert.deepEqual(parseDiscussionArenaBlock(body), {
		enabled: true,
		milestones: { M001: { enabled: true } },
	});
});

test("mode non valido ignorato (contratto invariato); DISCUSSION_ARENA_MODES esportate", () => {
	assert.deepEqual(parseDiscussionArenaBlock(["  mode: nonsense", "  enabled: true"]), {
		enabled: true,
	});
	assert.deepEqual(
		DISCUSSION_ARENA_MODES,
		["per-milestone", "always-on", "availability-only"],
	);
});

test("enabled: false globale e per-milestone", () => {
	assert.deepEqual(parseDiscussionArenaBlock(["  enabled: false"]), {
		enabled: false,
	});
	const body = ["  milestones:", "    M001:", "      enabled: false"];
	assert.deepEqual(parseDiscussionArenaBlock(body), {
		milestones: { M001: { enabled: false } },
	});
});

test("riga root leakata a indent 0: ignorata in strict:false, errore in strict:true", () => {
	const body = ["discussion_arena:", "  enabled: true"];
	assert.deepEqual(parseDiscussionArenaBlock(body), { enabled: true });
	assert.throws(
		() => parseDiscussionArenaBlock(body, { strict: true }),
		(err) => {
			if (!(err instanceof DiscussionArenaParseError)) return false;
			assert.strictEqual(err.key, "discussion_arena");
			assert.strictEqual(err.indent, 0);
			return true;
		},
	);
});
