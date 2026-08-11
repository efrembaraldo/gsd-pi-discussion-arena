/**
 * Test unitari per helpers.ts (M003/S01) — contratti del RESEARCH M003 §4.
 *
 * Copertura:
 *   - accumulateCost (§4.1): 4 formati di usage.cost (number, {total}, string,
 *     assente), clamp a >= 0, current non finito, tolleranza float (MEM067).
 *   - truncateOutput (§4.2): boundary, marker default/custom, RangeError per
 *     limit < marker.length scoped al ramo di troncamento, marker vuoto.
 *   - formatFailureMarker (§4.3): 6 kind con formato canonico §5.3,
 *     timestamp opzionale, sanitizzazione regex-safe, kind invalido -> Error,
 *     regex-matchabilità (NOTA: i due punti valgono solo per i marker con
 *     id — `OUTPUT TRUNCATED at <N> chars` non ha i due punti, vedi Known
 *     Issue #1 di T01; qui si usano regex per-formato corrette).
 *   - resolveParticipantLimits (§4.4): merge 3 livelli (defaults < frontmatter
 *     < toolParams), valori invalidi -> fallback con warning su stderr,
 *     clamps (costBudgetUsd min 0, outputLimitChars min 1).
 *   - shouldSkipParticipant (§4.5): Map con reason specifica, Set/array con
 *     reason "failed", id assente, morti null (branch difensivo).
 *   - appendEvent/readEvents (§4.6): round-trip, idempotenza, file
 *     inesistente, righe malformate saltate, append concorrenti, 10k righe,
 *     errori I/O non-ENOENT propagati.
 *
 * I test degli eventi usano os.tmpdir() con cleanup in afterEach (RESEARCH §4).
 */

import { afterEach, test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	accumulateCost,
	truncateOutput,
	formatFailureMarker,
	resolveParticipantLimits,
	shouldSkipParticipant,
	appendEvent,
	readEvents,
	helpers,
	DEFAULT_PARTICIPANT_LIMITS,
	type ArenaEvent,
	type ArenaState,
	type FailureKind,
} from "../helpers.js";

// ---------------------------------------------------------------------------
// Infra di test
// ---------------------------------------------------------------------------

/** Directory temporanee create dai test; rimosse in afterEach. */
const tmpDirs: string[] = [];

async function makeTmp(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tmpDirs.push(dir);
	return dir;
}

afterEach(async () => {
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		if (dir) await fs.rm(dir, { recursive: true, force: true });
	}
});

/** Legge tutti gli eventi di un JSONL in un array (per assert). */
async function collectEvents(filePath: string): Promise<ArenaEvent[]> {
	const out: ArenaEvent[] = [];
	for await (const ev of readEvents(filePath)) out.push(ev);
	return out;
}

/**
 * Silenzia process.stderr.write durante la chiamata: i warning di
 * resolveParticipantLimits su valori invalidi vanno su stderr (canale di
 * osservabilità del CLI) e non devono inquinare il reporter dei test.
 * I test in un file node:test girano in sequenza, quindi il restore in
 * finally è sicuro.
 */
function silenceStderr<T>(fn: () => T): T {
	const original = process.stderr.write;
	process.stderr.write = (() => true) as unknown as typeof process.stderr.write;
	try {
		return fn();
	} finally {
		process.stderr.write = original;
	}
}

/** Variante di assert con tolleranza float (IEEE 754, MEM067). */
function assertCostClose(actual: number, expected: number, eps = 1e-12): void {
	assert.ok(
		Math.abs(actual - expected) < eps,
		`expected ${actual} to be within ${eps} of ${expected}`,
	);
}

// ---------------------------------------------------------------------------
// accumulateCost (§4.1)
// ---------------------------------------------------------------------------

test("accumulateCost: {cost: 0.05} con current=0 -> 0.05", () => {
	assert.equal(accumulateCost({ cost: 0.05 }, 0), 0.05);
});

test("accumulateCost: {cost: {total: 0.05}} con current=0 -> 0.05 (fix §4.1)", () => {
	assert.equal(accumulateCost({ cost: { total: 0.05 } }, 0), 0.05);
});

test("accumulateCost: {cost: \"0.05\"} e {cost: {total: \"0.05\"}} (string)", () => {
	assert.equal(accumulateCost({ cost: "0.05" }, 0), 0.05);
	assert.equal(accumulateCost({ cost: { total: "0.05" } }, 0), 0.05);
});

test("accumulateCost: cost null/undefined/assente -> 0", () => {
	assert.equal(accumulateCost({ cost: null }, 0), 0);
	assert.equal(accumulateCost({ cost: undefined }, 0), 0);
	assert.equal(accumulateCost({}, 0), 0);
	assert.equal(accumulateCost({ cost: {} }, 0), 0);
	assert.equal(accumulateCost({ cost: { total: null } }, 0), 0);
});

test("accumulateCost: {cost: -0.05} e {cost: {total: -0.05}} -> clamp a 0", () => {
	assert.equal(accumulateCost({ cost: -0.05 }, 0), 0);
	assert.equal(accumulateCost({ cost: { total: -0.05 } }, 0), 0);
});

test("accumulateCost: string non numerica -> 0 (no NaN)", () => {
	assert.equal(accumulateCost({ cost: "abc" }, 0), 0);
	assert.equal(accumulateCost({ cost: { total: "abc" } }, 0), 0);
});

test("accumulateCost: accumulo con tolleranza float (0.1 + 0.05 ~ 0.15)", () => {
	assertCostClose(accumulateCost({ cost: 0.05 }, 0.1), 0.15);
});

test("accumulateCost: somma binary-exact (0.25 + 0.5 = 0.75)", () => {
	assert.equal(accumulateCost({ cost: 0.5 }, 0.25), 0.75);
});

test("accumulateCost: catena di accumuli mantiene il totale", () => {
	const after1 = accumulateCost({ cost: 0.05 }, 0);
	const after2 = accumulateCost({ cost: 0.05 }, after1);
	assert.equal(after2, 0.1, "x + x è esatto in binary float");
});

test("accumulateCost: current NaN/Infinity ritornati invariati", () => {
	assert.ok(Number.isNaN(accumulateCost({ cost: 1 }, NaN)), "NaN resta NaN");
	assert.equal(accumulateCost({ cost: 1 }, Infinity), Infinity);
});

test("accumulateCost: usage null/undefined/primitive -> 0 (nessun throw)", () => {
	assert.equal(accumulateCost(null, 0), 0);
	assert.equal(accumulateCost(undefined, 0), 0);
	assert.equal(accumulateCost("usage", 0), 0);
	assert.equal(accumulateCost(42, 0), 0);
});

// ---------------------------------------------------------------------------
// truncateOutput (§4.2)
// ---------------------------------------------------------------------------

test("truncateOutput: testo breve (<= limit) -> integro, truncated: false", () => {
	assert.deepEqual(truncateOutput("hi", 100), { text: "hi", truncated: false });
	assert.deepEqual(truncateOutput("", 100), { text: "", truncated: false });
});

test("truncateOutput: boundary text.length === limit -> non troncato", () => {
	assert.deepEqual(truncateOutput("abc", 3), { text: "abc", truncated: false });
});

test("truncateOutput: testo lungo, marker default in coda", () => {
	const text = "x".repeat(100);
	const result = truncateOutput(text, 50);
	assert.equal(result.truncated, true);
	assert.equal(result.text.length, 50, "output esattamente limit char");
	assert.ok(result.text.endsWith("[OUTPUT TRUNCATED at 50 chars]"));
	assert.ok(result.text.startsWith("x".repeat(20)), "20 char di testo + marker 30");
});

test("truncateOutput: testo lungo, marker custom", () => {
	const text = "x".repeat(100);
	const result = truncateOutput(text, 50, "[TRUNC]");
	assert.equal(result.truncated, true);
	assert.equal(result.text.length, 50);
	assert.ok(result.text.endsWith("[TRUNC]"));
	assert.ok(result.text.startsWith("x".repeat(43)));
});

test("truncateOutput: limit < marker.length -> RangeError (config invalida)", () => {
	assert.throws(
		() => truncateOutput("x".repeat(100), 10),
		RangeError,
		"marker default (30 char) più lungo del limit",
	);
	assert.throws(
		() => truncateOutput("x".repeat(100), 5, "[CUSTOM]"),
		RangeError,
		"marker custom più lungo del limit",
	);
});

test("truncateOutput: testo entro i limiti -> MAI RangeError anche con limit piccolo", () => {
	assert.deepEqual(truncateOutput("ab", 10), { text: "ab", truncated: false });
});

test("truncateOutput: marker vuoto -> fallback al default", () => {
	const result = truncateOutput("x".repeat(100), 50, "");
	assert.ok(result.truncated);
	assert.ok(result.text.endsWith("[OUTPUT TRUNCATED at 50 chars]"));
});

test("truncateOutput: testo multibyte contato in code unit UTF-16", () => {
	const text = "éèà".repeat(10); // 30 code unit
	const result = truncateOutput(text, 100);
	assert.equal(result.truncated, false);
	assert.equal(result.text.length, 30);
});

// ---------------------------------------------------------------------------
// formatFailureMarker (§4.3)
// ---------------------------------------------------------------------------

test("formatFailureMarker: failed con reason + timestamp ISO 8601", () => {
	assert.equal(
		formatFailureMarker("failed", "dev", "crash", "2026-01-01T00:00:00Z"),
		"[PARTICIPANT FAILED: dev crash 2026-01-01T00:00:00Z]",
	);
});

test("formatFailureMarker: failed senza timestamp / senza reason", () => {
	assert.equal(
		formatFailureMarker("failed", "dev", "crash"),
		"[PARTICIPANT FAILED: dev crash]",
	);
	assert.equal(formatFailureMarker("failed", "dev"), "[PARTICIPANT FAILED: dev]");
});

test("formatFailureMarker: skipped -> [PARTICIPANT SKIPPED: <id>] (reason opzionale)", () => {
	assert.equal(formatFailureMarker("skipped", "dev"), "[PARTICIPANT SKIPPED: dev]");
	assert.equal(
		formatFailureMarker("skipped", "dev", "no budget"),
		"[PARTICIPANT SKIPPED: dev no budget]",
	);
});

test("formatFailureMarker: timeout_round -> [TIMEOUT: <id> round_timeout <ts>]", () => {
	assert.equal(
		formatFailureMarker("timeout_round", "dev", undefined, "2026-01-01T00:00:00Z"),
		"[TIMEOUT: dev round_timeout 2026-01-01T00:00:00Z]",
	);
	assert.equal(
		formatFailureMarker("timeout_round", "dev"),
		"[TIMEOUT: dev round_timeout]",
	);
});

test("formatFailureMarker: timeout_event -> [TIMEOUT: <id> event_watchdog <ts>]", () => {
	assert.equal(
		formatFailureMarker("timeout_event", "dev", undefined, "2026-01-01T00:00:00Z"),
		"[TIMEOUT: dev event_watchdog 2026-01-01T00:00:00Z]",
	);
});

test("formatFailureMarker: budget_exhausted -> [BUDGET EXHAUSTED: <id> at round <N>]", () => {
	assert.equal(
		formatFailureMarker("budget_exhausted", "dev", "at round 2"),
		"[BUDGET EXHAUSTED: dev at round 2]",
	);
	assert.equal(
		formatFailureMarker("budget_exhausted", "dev", "at round 2", "2026-01-01T00:00:00Z"),
		"[BUDGET EXHAUSTED: dev at round 2 2026-01-01T00:00:00Z]",
	);
});

test("formatFailureMarker: output_truncated default -> [OUTPUT TRUNCATED at limit chars]", () => {
	assert.equal(
		formatFailureMarker("output_truncated", "dev"),
		"[OUTPUT TRUNCATED at limit chars]",
	);
});

test("formatFailureMarker: output_truncated con limit -> [OUTPUT TRUNCATED at <N> chars]", () => {
	assert.equal(
		formatFailureMarker("output_truncated", "dev", "16000"),
		"[OUTPUT TRUNCATED at 16000 chars]",
	);
	assert.equal(
		formatFailureMarker("output_truncated", "dev", "200 chars"),
		"[OUTPUT TRUNCATED at 200 chars]",
		"reason già terminante in 'chars' -> nessun doppio suffisso",
	);
});

test("formatFailureMarker: sanitizzazione regex-safe di id/reason (\\ [ ] \\r\\n\\t)", () => {
	assert.equal(
		formatFailureMarker("failed", "dev[1]", "crash\n", "ts"),
		"[PARTICIPANT FAILED: dev_1_ crash_ ts]",
	);
});

test("formatFailureMarker: id lunghi troncati a 64 char, marker <= ~200 char", () => {
	const marker = formatFailureMarker("failed", "x".repeat(100), "y".repeat(200));
	assert.ok(marker.includes("x".repeat(64)), "id troncato a 64");
	assert.ok(!marker.includes("x".repeat(65)), "id NON oltre 64");
	assert.ok(marker.length <= 200, `marker length ${marker.length} <= 200`);
});

test("formatFailureMarker: kind invalido -> Error esplicito (no fallback)", () => {
	assert.throws(
		() => formatFailureMarker("bogus" as FailureKind, "dev"),
		/kind sconosciuto/,
	);
});

test("formatFailureMarker: i 5 marker familiari sono regex-matchabili (gate T04)", () => {
	const markers = [
		formatFailureMarker("failed", "p1", "crash", "2026-01-01T00:00:00Z"),
		formatFailureMarker("skipped", "p1"),
		formatFailureMarker("timeout_round", "p1", undefined, "2026-01-01T00:00:00Z"),
		formatFailureMarker("budget_exhausted", "p1", "at round 2"),
		formatFailureMarker("output_truncated", "p1"),
	];
	const regexes = [
		/PARTICIPANT FAILED: p1/,
		/PARTICIPANT SKIPPED: p1/,
		/TIMEOUT: p1 round_timeout/,
		/BUDGET EXHAUSTED: p1 at round 2/,
		/OUTPUT TRUNCATED at/,
	];
	markers.forEach((m, i) => {
		assert.match(m, regexes[i], `marker ${i} non regex-matchabile: ${m}`);
	});
	// Prefissi: NOTA — `OUTPUT TRUNCATED at <N> chars` non ha i due punti
	// (Known Issue #1 di T01); regex per-formato corretta:
	const prefix = /^\[(PARTICIPANT FAILED|PARTICIPANT SKIPPED|TIMEOUT|BUDGET EXHAUSTED):|^\[OUTPUT TRUNCATED at/;
	markers.forEach((m) => assert.match(m, prefix));
});

// ---------------------------------------------------------------------------
// resolveParticipantLimits (§4.4)
// ---------------------------------------------------------------------------

test("resolveParticipantLimits: solo defaults -> ResolvedLimits = defaults", () => {
	assert.deepEqual(
		resolveParticipantLimits({}, {}, DEFAULT_PARTICIPANT_LIMITS),
		DEFAULT_PARTICIPANT_LIMITS,
	);
});

test("resolveParticipantLimits: frontmatter vince sul default per 1 campo", () => {
	const r = resolveParticipantLimits({}, { roundTimeoutMs: 120_000 }, DEFAULT_PARTICIPANT_LIMITS);
	assert.equal(r.roundTimeoutMs, 120_000);
	assert.equal(r.eventTimeoutMs, DEFAULT_PARTICIPANT_LIMITS.eventTimeoutMs);
});

test("resolveParticipantLimits: toolParams vince sul default per 1 campo", () => {
	const r = resolveParticipantLimits({ eventTimeoutMs: 90_000 }, {}, DEFAULT_PARTICIPANT_LIMITS);
	assert.equal(r.eventTimeoutMs, 90_000);
	assert.equal(r.roundTimeoutMs, DEFAULT_PARTICIPANT_LIMITS.roundTimeoutMs);
});

test("resolveParticipantLimits: tutti e 3 i livelli, toolParams vince sempre", () => {
	const r = resolveParticipantLimits(
		{ roundTimeoutMs: 1000 },
		{ roundTimeoutMs: 2000 },
		DEFAULT_PARTICIPANT_LIMITS,
	);
	assert.equal(r.roundTimeoutMs, 1000);
});

test("resolveParticipantLimits: merge parziale (solo roundTimeoutMs da toolParams)", () => {
	const r = resolveParticipantLimits({ roundTimeoutMs: 123 }, {}, DEFAULT_PARTICIPANT_LIMITS);
	assert.equal(r.roundTimeoutMs, 123);
	assert.equal(r.eventTimeoutMs, 60_000);
	assert.equal(r.outputLimitChars, 16_000);
	assert.equal(r.costBudgetUsd, 1.0);
	assert.equal(r.termination, "soft");
});

test("resolveParticipantLimits: frontmatter invalido (string) -> fallback al default, no throw", () => {
	const r = silenceStderr(() =>
		resolveParticipantLimits({}, { roundTimeoutMs: "abc" }, DEFAULT_PARTICIPANT_LIMITS),
	);
	assert.equal(r.roundTimeoutMs, DEFAULT_PARTICIPANT_LIMITS.roundTimeoutMs);
});

test("resolveParticipantLimits: stringhe numeriche dal parser frontmatter (\"0.01\") -> normalizzate a number, senza warning", () => {
	// Il parser frontmatter reale (@gsd/pi-coding-agent) restituisce gli
	// scalari numerici come stringa (participants.test.ts pinnа il passthrough
	// grezzo); il contratto S02 dichiara i campi limits come number. La
	// coercion in pickNumber (S06/T02, gap di integrazione S02->S06) rende il
	// budget per-partecipante da frontmatter effettivamente risolto.
	const r = resolveParticipantLimits(
		{},
		{ costBudgetUsd: "0.01", outputLimitChars: "100" },
		DEFAULT_PARTICIPANT_LIMITS,
	);
	assert.equal(r.costBudgetUsd, 0.01);
	assert.equal(r.outputLimitChars, 100);
	assert.equal(r.roundTimeoutMs, DEFAULT_PARTICIPANT_LIMITS.roundTimeoutMs);
});

test("resolveParticipantLimits: termination invalido -> fallback a \"soft\"", () => {
	const r = silenceStderr(() =>
		resolveParticipantLimits({ termination: "softish" }, {}, DEFAULT_PARTICIPANT_LIMITS),
	);
	assert.equal(r.termination, "soft");
});

test("resolveParticipantLimits: termination valida da frontmatter -> \"hard\"", () => {
	const r = resolveParticipantLimits({}, { termination: "hard" }, DEFAULT_PARTICIPANT_LIMITS);
	assert.equal(r.termination, "hard");
});

test("resolveParticipantLimits: tutti i 5 campi risolti, nessun undefined", () => {
	const r = resolveParticipantLimits(
		{
			roundTimeoutMs: 1,
			eventTimeoutMs: 2,
			outputLimitChars: 3,
			costBudgetUsd: 4,
			termination: "hard",
		},
		{},
		DEFAULT_PARTICIPANT_LIMITS,
	);
	assert.deepEqual(r, {
		roundTimeoutMs: 1,
		eventTimeoutMs: 2,
		outputLimitChars: 3,
		costBudgetUsd: 4,
		termination: "hard",
	});
});

test("resolveParticipantLimits: costBudgetUsd < 0 -> clamp a 0", () => {
	const r = silenceStderr(() =>
		resolveParticipantLimits({ costBudgetUsd: -5 }, {}, DEFAULT_PARTICIPANT_LIMITS),
	);
	assert.equal(r.costBudgetUsd, 0);
});

test("resolveParticipantLimits: outputLimitChars < 1 -> clamp a 1", () => {
	const r = silenceStderr(() =>
		resolveParticipantLimits({ outputLimitChars: 0 }, {}, DEFAULT_PARTICIPANT_LIMITS),
	);
	assert.equal(r.outputLimitChars, 1);
});

test("resolveParticipantLimits: roundTimeoutMs 0 (min 1, no clamp) -> fallback al default", () => {
	const r = silenceStderr(() =>
		resolveParticipantLimits({ roundTimeoutMs: 0 }, {}, DEFAULT_PARTICIPANT_LIMITS),
	);
	assert.equal(r.roundTimeoutMs, DEFAULT_PARTICIPANT_LIMITS.roundTimeoutMs);
});

test("resolveParticipantLimits: costBudgetUsd NaN -> fallback al default (1.0)", () => {
	const r = silenceStderr(() =>
		resolveParticipantLimits({ costBudgetUsd: NaN }, {}, DEFAULT_PARTICIPANT_LIMITS),
	);
	assert.equal(r.costBudgetUsd, DEFAULT_PARTICIPANT_LIMITS.costBudgetUsd);
});

test("resolveParticipantLimits: merge misto toolParams + frontmatter + defaults", () => {
	const r = resolveParticipantLimits(
		{ outputLimitChars: 5000 },
		{ costBudgetUsd: 0.5, termination: "hard" },
		DEFAULT_PARTICIPANT_LIMITS,
	);
	assert.deepEqual(r, {
		roundTimeoutMs: 300_000,
		eventTimeoutMs: 60_000,
		outputLimitChars: 5000,
		costBudgetUsd: 0.5,
		termination: "hard",
	});
});

// ---------------------------------------------------------------------------
// shouldSkipParticipant (§4.5)
// ---------------------------------------------------------------------------

test("shouldSkipParticipant: morti vuoto -> {skip: false}", () => {
	assert.deepEqual(shouldSkipParticipant({ morti: [] }, "dev"), { skip: false });
});

test("shouldSkipParticipant: id in array -> {skip: true, reason: \"failed\"}", () => {
	assert.deepEqual(shouldSkipParticipant({ morti: ["dev"] }, "dev"), {
		skip: true,
		reason: "failed",
	});
});

test("shouldSkipParticipant: id non in array -> {skip: false}", () => {
	assert.deepEqual(shouldSkipParticipant({ morti: ["dev", "qa"] }, "analyst"), {
		skip: false,
	});
});

test("shouldSkipParticipant: Map con reason specifica nel return", () => {
	const state: ArenaState = { morti: new Map([["dev", "budget_exhausted"]]) };
	assert.deepEqual(shouldSkipParticipant(state, "dev"), {
		skip: true,
		reason: "budget_exhausted",
	});
});

test("shouldSkipParticipant: Map senza id -> {skip: false}", () => {
	const state: ArenaState = { morti: new Map([["dev", "budget_exhausted"]]) };
	assert.deepEqual(shouldSkipParticipant(state, "qa"), { skip: false });
});

test("shouldSkipParticipant: Set -> reason \"failed\"", () => {
	const state: ArenaState = { morti: new Set(["dev"]) };
	assert.deepEqual(shouldSkipParticipant(state, "dev"), {
		skip: true,
		reason: "failed",
	});
	assert.deepEqual(shouldSkipParticipant(state, "qa"), { skip: false });
});

test("shouldSkipParticipant: morti null (branch difensivo) -> {skip: false}", () => {
	assert.deepEqual(
		shouldSkipParticipant({ morti: null } as unknown as ArenaState, "dev"),
		{ skip: false },
	);
});

// ---------------------------------------------------------------------------
// appendEvent / readEvents (§4.6)
// ---------------------------------------------------------------------------

test("appendEvent + readEvents: 5 eventi sequenziali, round-trip in ordine", async () => {
	const dir = await makeTmp("gsd-discussion-arena-helpers-");
	const filePath = path.join(dir, "events.jsonl");
	const events: ArenaEvent[] = [
		{ ts: "2026-01-01T00:00:00.000Z", type: "round_start", round: 1 },
		{ ts: "2026-01-01T00:00:01.000Z", type: "participant_start", participantId: "dev" },
		{ ts: "2026-01-01T00:00:02.000Z", type: "participant_done", participantId: "dev", cost: 0.05 },
		{ ts: "2026-01-01T00:00:03.000Z", type: "round_end", round: 1 },
		{ ts: "2026-01-01T00:00:04.000Z", type: "arena_done" },
	];
	for (const ev of events) await appendEvent(filePath, ev);
	assert.deepEqual(await collectEvents(filePath), events);
});

test("readEvents: read ripetute sono idempotenti (sempre 5 eventi)", async () => {
	const dir = await makeTmp("gsd-discussion-arena-helpers-idem-");
	const filePath = path.join(dir, "events.jsonl");
	for (let i = 0; i < 5; i++) {
		await appendEvent(filePath, { ts: `2026-01-01T00:00:0${i}.000Z`, type: "tick", i });
	}
	assert.equal((await collectEvents(filePath)).length, 5);
	assert.equal((await collectEvents(filePath)).length, 5, "seconda read identica");
});

test("readEvents: file inesistente -> iterable vuoto, no throw", async () => {
	const dir = await makeTmp("gsd-discussion-arena-helpers-enoent-");
	assert.deepEqual(await collectEvents(path.join(dir, "nope.jsonl")), []);
});

test("readEvents: file vuoto -> iterable vuoto", async () => {
	const dir = await makeTmp("gsd-discussion-arena-helpers-empty-");
	const filePath = path.join(dir, "events.jsonl");
	await fs.writeFile(filePath, "", "utf-8");
	assert.deepEqual(await collectEvents(filePath), []);
});

test("readEvents: riga malformata in mezzo -> skip silenzioso, le altre ritornate", async () => {
	const dir = await makeTmp("gsd-discussion-arena-helpers-badline-");
	const filePath = path.join(dir, "events.jsonl");
	await fs.writeFile(
		filePath,
		[
			JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", type: "a" }),
			"questa non è json",
			"",
			JSON.stringify({ ts: "2026-01-01T00:00:01.000Z", type: "b" }),
			JSON.stringify({ tipo: "senza ts/type" }),
		].join("\n") + "\n",
		"utf-8",
	);
	const events = await collectEvents(filePath);
	assert.equal(events.length, 2, "solo le 2 righe conformi");
	assert.equal(events[0].type, "a");
	assert.equal(events[1].type, "b");
});

test("appendEvent: 10 append concorrenti (Promise.all) -> 10 eventi, nessuna corruzione", async () => {
	const dir = await makeTmp("gsd-discussion-arena-helpers-conc-");
	const filePath = path.join(dir, "events.jsonl");
	await Promise.all(
		Array.from({ length: 10 }, (_, i) =>
			appendEvent(filePath, { ts: `2026-01-01T00:00:00.00${i}Z`, type: "tick", i }),
		),
	);
	const events = await collectEvents(filePath);
	assert.equal(events.length, 10);
	assert.deepEqual(
		events.map((e) => e.i).sort((a, b) => (a as number) - (b as number)),
		[0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
		"tutti i 10 eventi presenti, JSONL non corrotto",
	);
});

test("appendEvent + readEvents: campo sconosciuto preservato nel round-trip", async () => {
	const dir = await makeTmp("gsd-discussion-arena-helpers-extra-");
	const filePath = path.join(dir, "events.jsonl");
	const event: ArenaEvent = {
		ts: "2026-01-01T00:00:00.000Z",
		type: "custom",
		customField: { nested: [1, 2, 3] },
		flag: true,
	};
	await appendEvent(filePath, event);
	assert.deepEqual(await collectEvents(filePath), [event]);
});

test("readEvents: JSONL grande (10k righe) -> tutte lette, no OOM", async () => {
	const dir = await makeTmp("gsd-discussion-arena-helpers-big-");
	const filePath = path.join(dir, "events.jsonl");
	const lines: string[] = [];
	for (let i = 0; i < 10_000; i++) {
		lines.push(JSON.stringify({ ts: `2026-01-01T00:00:00.${String(i).padStart(4, "0")}Z`, type: "tick", i }));
	}
	await fs.writeFile(filePath, lines.join("\n") + "\n", "utf-8");
	const events = await collectEvents(filePath);
	assert.equal(events.length, 10_000);
	assert.equal(events[0].i, 0);
	assert.equal(events[9999].i, 9999);
});

test("readEvents: 100 append sequenziali -> 100 eventi in ordine", async () => {
	const dir = await makeTmp("gsd-discussion-arena-helpers-loop-");
	const filePath = path.join(dir, "events.jsonl");
	for (let i = 0; i < 100; i++) {
		await appendEvent(filePath, { ts: `2026-01-01T00:00:00.${String(i).padStart(4, "0")}Z`, type: "tick", i });
	}
	const events = await collectEvents(filePath);
	assert.equal(events.length, 100);
	assert.deepEqual(
		events.map((e) => e.i),
		Array.from({ length: 100 }, (_, i) => i),
		"ordine di append preservato",
	);
});

test("readEvents: errore I/O non-ENOENT (path = directory) propagato", async () => {
	const dir = await makeTmp("gsd-discussion-arena-helpers-iodir-");
	await assert.rejects(
		async () => {
			for await (const _ of readEvents(dir)) void _;
		},
		(err) => (err as NodeJS.ErrnoException).code !== "ENOENT",
		"EISDIR (o simile) propagato, non inghiottito",
	);
});

// ---------------------------------------------------------------------------
// Export raggruppato
// ---------------------------------------------------------------------------

test("export default `helpers` espone tutte le 7 funzioni", () => {
	const fns = [
		"accumulateCost",
		"truncateOutput",
		"formatFailureMarker",
		"resolveParticipantLimits",
		"shouldSkipParticipant",
		"appendEvent",
		"readEvents",
	] as const;
	for (const name of fns) {
		assert.equal(typeof helpers[name], "function", `helpers.${name} è una funzione`);
		assert.equal(helpers[name], { accumulateCost, truncateOutput, formatFailureMarker, resolveParticipantLimits, shouldSkipParticipant, appendEvent, readEvents }[name], `helpers.${name} è lo stesso riferimento del named export`);
	}
});
