/**
 * Test di metrics.ts (M003/S08) — registry Prometheus-style inline + log
 * emitter NDJSON.
 *
 * Sezioni:
 *   1. Unit — counter `discussion_arena_crashes_total` (incremento, cumulo, labeling)
 *   2. Unit — histogram `discussion_arena_round_duration_seconds` (count/sum/buckets
 *      cumulativi Prometheus, bucket +Inf, snapshot difensiva)
 *   3. Unit — multi-label counter `discussion_arena_timeouts_total`
 *   4. Unit — log emitter NDJSON (shape riga, timestamp ISO, singola riga)
 *   5. Unit — `resetMetrics()` (isolamento stato tra test)
 *   6. Integration — guardrail → metrics: `runDiscussionArena` con `runTurn`
 *      mockato (pattern S03/S04/S05/S06, D022/D020): bob crasha, carol fa
 *      timeout_event, alice completa — `getMetrics()` riflette counters +
 *      histogram dopo la run.
 *   7. Integration — structured log: le stesse guardrail producono righe
 *      NDJSON parsabili su stderr con `event` ∈ {guard.crash, guard.timeout,
 *      guard.skipped, guard.budget_exhausted, guard.output_truncated}.
 *
 * Isolamento: `resetMetrics()` in `beforeEach` (registry singleton in-process
 * — pattern standard prom-client). Fixture partecipanti su tmpdir (pattern
 * discussion-arena-loop.test.ts, nessun mock del filesystem), `runTurn` mockato senza
 * subprocess `gsd` reale (D022/D020).
 */

import { test, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	getMetrics,
	resetMetrics,
	emitStructuredLog,
	recordDiscussionArenaCrash,
	recordDiscussionArenaTimeout,
	recordDiscussionArenaCost,
	recordDiscussionArenaOutputChars,
	recordDiscussionArenaRoundDuration,
	recordHistogram,
	DEFAULT_DURATION_BUCKETS_SECONDS,
	logGuardCrash,
	logGuardTimeout,
	logGuardTruncated,
	logGuardBudgetExhausted,
	logGuardSkipped,
} from "../metrics.js";
import { runDiscussionArena, type RunTurnFn } from "../index.js";
import type { ParticipantTurnResult } from "../run-participant.js";
import { GSD_AGENT_DIR_ENV } from "./fixtures/pi-coding-agent-stub.js";

// ─── Fixture helpers (pattern discussion-arena-loop.test.ts) ──────────────────────────

function writeParticipant(
	dir: string,
	filename: string,
	opts: { name: string; role: string },
): void {
	fs.writeFileSync(
		path.join(dir, filename),
		`---\nname: ${opts.name}\nrole: ${opts.role}\ndescription: ${opts.name}\n---\n\nSystem prompt di ${opts.name}.\n`,
		"utf-8",
	);
}

interface Fixture {
	root: string;
	userDir: string;
	cwd: string;
}

function makeFixture(): Fixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-discussion-arena-metrics-"));
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

/** Silenzia process.stderr.write durante `fn` (log dei limiti, marker...). */
async function captureStderr<T>(fn: () => Promise<T>): Promise<T> {
	const original = process.stderr.write.bind(process.stderr);
	process.stderr.write = (() => true) as unknown as typeof process.stderr.write;
	try {
		return await fn();
	} finally {
		process.stderr.write = original;
	}
}

/** Cattura i chunk scritti su stderr durante `fn` (per asserire le righe NDJSON). */
async function captureStderrChunks<T>(
	fn: () => Promise<T>,
): Promise<{ result: T; chunks: string[] }> {
	const original = process.stderr.write.bind(process.stderr);
	const chunks: string[] = [];
	process.stderr.write = ((chunk: unknown) => {
		chunks.push(String(chunk));
		return true;
	}) as unknown as typeof process.stderr.write;
	try {
		const result = await fn();
		return { result, chunks };
	} finally {
		process.stderr.write = original;
	}
}

/** Variante sincrona di captureStderr (emitStructuredLog è sincrono). */
function captureStderrChunksSync(fn: () => void): string[] {
	const original = process.stderr.write.bind(process.stderr);
	const chunks: string[] = [];
	process.stderr.write = ((chunk: unknown) => {
		chunks.push(String(chunk));
		return true;
	}) as unknown as typeof process.stderr.write;
	try {
		fn();
		return chunks;
	} finally {
		process.stderr.write = original;
	}
}

/** Turno di successo deterministico per un dato partecipante. */
function okTurn(name: string, role: string, durationMs = 250): ParticipantTurnResult {
	return {
		participant: name,
		role,
		exitCode: 0,
		text: `${name} risponde`,
		stderr: "",
		usage: { input: 1, output: 1, cost: 0.001, turns: 1 },
		durationMs,
	};
}

beforeEach(() => {
	resetMetrics();
});

// ─── 1. Unit — counter discussion_arena_crashes_total ─────────────────────────────────

test("counter crash: recordDiscussionArenaCrash registra 1 su discussion_arena_crashes_total{participant=id}", () => {
	recordDiscussionArenaCrash("alice");
	const m = getMetrics();
	assert.equal(
		m.counters["discussion_arena_crashes_total"]?.["{participant=alice}"],
		1,
		"un crash -> counter = 1",
	);
});

test("counter crash: incrementi ripetuti cumulano (3 crash -> 3)", () => {
	recordDiscussionArenaCrash("alice");
	recordDiscussionArenaCrash("alice");
	recordDiscussionArenaCrash("alice");
	assert.equal(
		getMetrics().counters["discussion_arena_crashes_total"]?.["{participant=alice}"],
		3,
		"3 crash -> counter = 3 (counter additivo)",
	);
});

test("counter crash: label partecipante diversa -> serie distinta", () => {
	recordDiscussionArenaCrash("alice");
	recordDiscussionArenaCrash("bob");
	const series = getMetrics().counters["discussion_arena_crashes_total"] ?? {};
	assert.deepEqual(
		Object.keys(series).sort(),
		["{participant=alice}", "{participant=bob}"],
		"due serie distinte per partecipante",
	);
	assert.equal(series["{participant=alice}"], 1);
	assert.equal(series["{participant=bob}"], 1);
});

// ─── 2. Unit — histogram discussion_arena_round_duration_seconds ──────────────────────

test("histogram: count/sum e bucket cumulativi Prometheus (sample 0.1, 1.0, 5.0)", () => {
	recordDiscussionArenaRoundDuration("alice", 1, 0.1);
	recordDiscussionArenaRoundDuration("alice", 1, 1.0);
	recordDiscussionArenaRoundDuration("alice", 1, 5.0);
	const h =
		getMetrics().histograms["discussion_arena_round_duration_seconds"]?.[
			"{participant=alice,round=1}"
		];
	assert.ok(h, "serie histogram presente");
	assert.equal(h!.count, 3);
	assert.ok(Math.abs(h!.sum - 6.1) < 1e-9, `sum = 6.1 (atteso), attuale ${h!.sum}`);
	// Bucket cumulativi: 0.1=1, 1=2, 5=3, 30=3, 60=3, 120=3, 300=3, +Inf=3
	assert.deepEqual(
		h!.bucketCounts,
		[1, 2, 3, 3, 3, 3, 3, 3],
		"bucketCounts cumulativi (bucket[i] = oss <= buckets[i], ultimo = +Inf)",
	);
});

test("histogram: valore sopra l'ultimo bucket finisce solo nel +Inf", () => {
	recordDiscussionArenaRoundDuration("bob", 2, 500);
	const h =
		getMetrics().histograms["discussion_arena_round_duration_seconds"]?.[
			"{participant=bob,round=2}"
		];
	assert.equal(h!.count, 1);
	assert.equal(h!.sum, 500);
	assert.deepEqual(
		h!.bucketCounts,
		[0, 0, 0, 0, 0, 0, 0, 1],
		"500s > 300s: solo bucket +Inf (ultimo elemento) incrementato",
	);
});

test("histogram: getMetrics() ritorna una snapshot difensiva (mutazioni isolate)", () => {
	recordDiscussionArenaRoundDuration("alice", 1, 0.5);
	const snap = getMetrics();
	const key = "{participant=alice,round=1}";
	// Mutare la snapshot non deve toccare il registry.
	snap.counters["discussion_arena_crashes_total"] = {};
	if (snap.histograms["discussion_arena_round_duration_seconds"]?.[key]) {
		snap.histograms["discussion_arena_round_duration_seconds"][key]!.bucketCounts[0] = 999;
	}
	const after = getMetrics();
	assert.equal(
		after.histograms["discussion_arena_round_duration_seconds"]?.[key]!.bucketCounts[0],
		0,
		"bucketCounts della snapshot non è live",
	);
	assert.ok(
		after.counters["discussion_arena_crashes_total"] === undefined,
		"counter inesistente non compare nella snapshot successiva",
	);
});

test("histogram: bucket default calibrati [0.1, 1, 5, 30, 60, 120, 300]", () => {
	assert.deepEqual(
		[...DEFAULT_DURATION_BUCKETS_SECONDS],
		[0.1, 1, 5, 30, 60, 120, 300],
		"buckets calibrati sul range osservabile dei round",
	);
});

test("histogram: recordHistogram con labels arbitrarie e custom buckets", () => {
	recordHistogram("test_latency_seconds", { op: "a" }, 0.05, [0.1, 1]);
	recordHistogram("test_latency_seconds", { op: "a" }, 0.5, [0.1, 1]);
	const h =
		getMetrics().histograms["test_latency_seconds"]?.["{op=a}"];
	assert.deepEqual(
		h!.bucketCounts,
		[1, 2, 2],
		"0.05<=0.1 e 0.5<=1: cumulative [1, 2], +Inf=2",
	);
});

// ─── 3. Unit — multi-label counter discussion_arena_timeouts_total ────────────────────

test("multi-label: timeout_round vs timeout_event -> due serie distinte", () => {
	recordDiscussionArenaTimeout("alice", "timeout_round");
	recordDiscussionArenaTimeout("alice", "timeout_event");
	const series = getMetrics().counters["discussion_arena_timeouts_total"] ?? {};
	// LabelKey deterministico: chiavi ordinate lexicograficamente (kind < participant).
	assert.deepEqual(
		Object.keys(series).sort(),
		["{kind=timeout_event,participant=alice}", "{kind=timeout_round,participant=alice}"],
		"due serie distinte per kind",
	);
	assert.equal(series["{kind=timeout_round,participant=alice}"], 1);
	assert.equal(series["{kind=timeout_event,participant=alice}"], 1);
});

// ─── 4. Unit — log emitter NDJSON ──────────────────────────────────────────

test("log emitter: riga NDJSON con level/event/fields e ts ISO 8601 valido", () => {
	const chunks = captureStderrChunksSync(() =>
		emitStructuredLog("warn", "guard.crash", { participantId: "alice", reason: "boom" }),
	);
	assert.equal(chunks.length, 1, "una sola riga scritta su stderr");
	const line = chunks[0]!;
	assert.ok(line.endsWith("\n"), "riga terminata con newline");
	const parsed = JSON.parse(line);
	assert.equal(parsed.level, "warn");
	assert.equal(parsed.event, "guard.crash");
	assert.equal(parsed.participantId, "alice");
	assert.equal(parsed.reason, "boom");
	assert.ok(
		Number.isFinite(Date.parse(parsed.ts)),
		`ts ISO 8601 valido, attuale ${parsed.ts}`,
	);
});

test("log emitter: helper logGuard* emettono gli eventi di guardrail attesi", () => {
	const chunks = captureStderrChunksSync(() => {
		logGuardCrash("alice", "boom");
		logGuardTimeout("bob", "timeout_round", 1000);
		logGuardTruncated("carol", 100, 500);
		logGuardBudgetExhausted("dave", 1.5, 1.0, 3);
		logGuardSkipped("eve", "failed");
	});
	assert.equal(chunks.length, 5, "un riga NDJSON per helper");
	const parsed = chunks.map((c) => JSON.parse(c) as { event?: string; level?: string });
	assert.deepEqual(
		parsed.map((p) => p.event),
		[
			"guard.crash",
			"guard.timeout",
			"guard.output_truncated",
			"guard.budget_exhausted",
			"guard.skipped",
		],
		"event per ciascun guardrail",
	);
	assert.equal(parsed[0]!.level, "error", "crash -> level error");
	assert.equal(parsed[1]!.level, "warn", "timeout -> level warn");
	assert.equal(parsed[4]!.level, "info", "skipped -> level info");
	const timeout = JSON.parse(chunks[1]!) as { thresholdMs?: unknown; kind?: unknown };
	assert.equal(timeout.thresholdMs, 1000, "thresholdMs propagato");
	assert.equal(timeout.kind, "timeout_round", "kind propagato");
	const budget = JSON.parse(chunks[3]!) as { costUsd?: unknown; budgetUsd?: unknown; round?: unknown };
	assert.equal(budget.costUsd, 1.5);
	assert.equal(budget.budgetUsd, 1.0);
	assert.equal(budget.round, 3);
});

// ─── 5. Unit — resetMetrics ────────────────────────────────────────────────

test("resetMetrics: azzera counters e histograms (isolamento tra test)", () => {
	recordDiscussionArenaCrash("alice");
	recordDiscussionArenaTimeout("alice", "timeout_event");
	recordDiscussionArenaOutputChars("alice", 1, 100);
	recordDiscussionArenaRoundDuration("alice", 1, 0.5);
	recordDiscussionArenaCost("alice", 0.01);
	resetMetrics();
	assert.deepEqual(getMetrics(), { counters: {}, histograms: {} }, "registry vuoto dopo reset");
});

test("recordDiscussionArenaCost: costo <= 0 non crea serie spuria", () => {
	recordDiscussionArenaCost("alice", 0);
	recordDiscussionArenaCost("alice", -0.5);
	assert.ok(
		getMetrics().counters["discussion_arena_cost_usd"] === undefined,
		"nessuna serie a costo zero/negativo",
	);
});

test("recordDiscussionArenaCost: delta additivi cumulano il totale per partecipante", () => {
	recordDiscussionArenaCost("alice", 0.001);
	recordDiscussionArenaCost("alice", 0.002);
	assert.ok(
		Math.abs(
			(getMetrics().counters["discussion_arena_cost_usd"]?.["{participant=alice}"] ?? 0) - 0.003,
		) < 1e-9,
		"counter = somma dei delta (costo totale speso)",
	);
});

// ─── 6. Integration — guardrail → metrics (runTurn mockato) ────────────────

test("integration: crash+timeout+happy path -> getMetrics() riflette counters e histogram", async () => {
	const f = makeFixture();
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");

	writeParticipant(f.userDir, "alice.md", { name: "alice", role: "Analyst" });
	writeParticipant(f.userDir, "bob.md", { name: "bob", role: "Builder" });
	writeParticipant(f.userDir, "carol.md", { name: "carol", role: "Critic" });

	const runTurn: RunTurnFn = async (participant) => {
		if (participant.name === "bob") {
			throw new Error("crash simulato");
		}
		if (participant.name === "carol") {
			return {
				participant: "carol",
				role: participant.role,
				exitCode: 0,
				text: "",
				stderr: "",
				usage: { input: 1, output: 1, cost: 0.001, turns: 1 },
				durationMs: 0,
				failureKind: "timeout_event",
				failureReason: "event_watchdog",
			};
		}
		return okTurn(participant.name, participant.role, 250);
	};

	const out = await captureStderr(() =>
		runDiscussionArena(
			"topic test",
			["alice", "bob", "carol"],
			2,
			f.cwd,
			undefined,
			() => {},
			undefined,
			undefined,
			undefined,
			undefined,
			runTurn,
		),
	);

	assert.equal(out.outcome, "partial", "bob e carol morti -> partial");

	const m = getMetrics();
	// Crash guardrail: bob crasha al round 1 -> counter = 1.
	assert.equal(
		m.counters["discussion_arena_crashes_total"]?.["{participant=bob}"],
		1,
		"discussion_arena_crashes_total{participant=bob} = 1 dopo il crash",
	);
	// Timeout guardrail: carol timeout_event al round 1 -> counter = 1.
	assert.equal(
		m.counters["discussion_arena_timeouts_total"]?.["{kind=timeout_event,participant=carol}"],
		1,
		"discussion_arena_timeouts_total{participant=carol,kind=timeout_event} = 1",
	);
	// Happy path: alice completa i 2 round con testo "alice risponde" (14 char).
	assert.equal(
		m.counters["discussion_arena_output_chars_total"]?.["{participant=alice,round=1}"],
		14,
		"output chars round 1 = lunghezza testo",
	);
	assert.equal(
		m.counters["discussion_arena_output_chars_total"]?.["{participant=alice,round=2}"],
		14,
		"output chars round 2 = lunghezza testo",
	);
	// Costo: 2 turni da 0.001 -> discussion_arena_cost_usd{participant=alice} = 0.002.
	assert.ok(
		Math.abs(
			(m.counters["discussion_arena_cost_usd"]?.["{participant=alice}"] ?? 0) - 0.002,
		) < 1e-9,
		"discussion_arena_cost_usd{participant=alice} = 0.002 (2 turni x 0.001)",
	);
	// Histogram: alice round 1, durationMs 250 -> 0.25s -> bucket 1 (>= 0.1, <= 1).
	const h1 =
		m.histograms["discussion_arena_round_duration_seconds"]?.["{participant=alice,round=1}"];
	assert.ok(h1, "histogram presente per il turno completato");
	assert.equal(h1!.count, 1);
	assert.ok(Math.abs(h1!.sum - 0.25) < 1e-9, `sum = 0.25, attuale ${h1!.sum}`);
	assert.deepEqual(h1!.bucketCounts, [0, 1, 1, 1, 1, 1, 1, 1], "0.25s -> bucket 1 e superiori");
	// Il partecipante morto per timeout NON ha cost metric (nessun turno completo).
	assert.ok(
		m.counters["discussion_arena_cost_usd"]?.["{participant=carol}"] === undefined,
		"nessun costo registrato per il turno timeout",
	);
});

// ─── 7. Integration — structured log NDJSON su stderr ─────────────────────

test("integration: i guardrail emettono righe NDJSON parsabili con event atteso", async () => {
	const f = makeFixture();
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");

	writeParticipant(f.userDir, "alice.md", { name: "alice", role: "Analyst" });
	writeParticipant(f.userDir, "bob.md", { name: "bob", role: "Builder" });
	writeParticipant(f.userDir, "carol.md", { name: "carol", role: "Critic" });

	const runTurn: RunTurnFn = async (participant) => {
		if (participant.name === "bob") {
			throw new Error("crash simulato");
		}
		if (participant.name === "carol") {
			return {
				participant: "carol",
				role: participant.role,
				exitCode: 0,
				text: "",
				stderr: "",
				usage: { input: 1, output: 1, cost: 0.001, turns: 1 },
				durationMs: 0,
				failureKind: "timeout_event",
				failureReason: "event_watchdog",
			};
		}
		return okTurn(participant.name, participant.role);
	};

	const { chunks } = await captureStderrChunks(() =>
		runDiscussionArena(
			"topic test",
			["alice", "bob", "carol"],
			2,
			f.cwd,
			undefined,
			() => {},
			undefined,
			undefined,
			undefined,
			undefined,
			runTurn,
		),
	);

	// Filtra le righe NDJSON (le righe plain `[discussion-arena] ...` non lo sono).
	const events: string[] = [];
	for (const chunk of chunks) {
		const trimmed = chunk.trimEnd();
		if (trimmed.length === 0) continue;
		try {
			const parsed = JSON.parse(trimmed) as { event?: unknown; ts?: unknown };
			if (typeof parsed.event === "string") {
				assert.ok(
					Number.isFinite(Date.parse(String(parsed.ts))),
					"ts ISO valido sulla riga NDJSON",
				);
				events.push(parsed.event);
			}
		} catch {
			// riga non-NDJSON (log plain esistenti) — ignorata
		}
	}

	// Guardrail attesi: crash (bob round 1), timeout (carol round 1),
	// skipped (bob e carol al round 2) + discussionArena.complete terminale.
	assert.ok(events.includes("guard.crash"), `guard.crash presente, attuali: ${events.join(",")}`);
	assert.ok(events.includes("guard.timeout"), `guard.timeout presente, attuali: ${events.join(",")}`);
	assert.ok(events.includes("guard.skipped"), `guard.skipped presente, attuali: ${events.join(",")}`);
	assert.ok(events.includes("discussionArena.complete"), `discussionArena.complete presente, attuali: ${events.join(",")}`);
	const skippedCount = events.filter((e) => e === "guard.skipped").length;
	assert.equal(skippedCount, 2, "2 skip (bob e carol al round 2)");
});
