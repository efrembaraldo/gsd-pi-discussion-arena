/**
 * Test del modulo root status.ts (M018/S07/T01 — computeStatus mai-throw +
 * formatStatus pura).
 *
 * Pattern viewer.test.ts: self-sufficiency via `import "./ts-esm-loader.mjs"`,
 * node:test + node:assert/strict, fixture SU TMP DIR (MAI .gsd/ reale).
 *
 * Scenari core (piano T01):
 *
 *   1. cwd vuoto (tmp senza .gsd) → tutti i conteggi 0, health.present
 *      false, failureCount 0, metrics.present false, truncated false,
 *      unreadableCount 0; formatStatus contiene i 4 path osservabili e la
 *      dicitura `non disponibili (<metrics path>)`.
 *   2. fixture 3 sessioni markdown (9 header `### Round `) + 3 event log
 *      JSONL (costi 0.02/0.005/0.003, outcomes complete/partial/assente) +
 *      marker engine (hermes / gsd degradato / assente) → sessionCount 3,
 *      turnCount 9, totalCostUsd ≈ 0.028, engines e outcomes corretti,
 *      formatStatus riporta i numeri e la sezione "non disponibili" resta
 *      (metrics.json assente).
 *
 * Nota MEM148: questi test girano sui sorgenti .ts SOLO tramite il loader —
 * `node --import ./tests/ts-esm-loader.mjs --test tests/status.test.ts`
 * (gsd_exec runtime=node NON carica il loader).
 */

// Self-sufficiency: registra gli hook ESM (`.js` -> `.ts` + stub
// `@gsd/pi-coding-agent`) anche senza `--import` esplicito (pattern
// viewer.test.ts / replay.test.ts).
import "./ts-esm-loader.mjs";
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";

import { computeStatus, formatStatus } from "../status.js";

// ─── Fixture helpers (sempre su tmp dir, mai .gsd/ reale) ────────────────────

/** Directory tmp unica per scenario. */
function makeTmpDir(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), `discussion-arena-status-${prefix}-`));
}

/** Scrive ricorsivamente file di fixture su tmp (mkdir + writeFile). */
async function writeFileAt(filePath: string, content: string): Promise<void> {
	await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
	await fsPromises.writeFile(filePath, content, "utf-8");
}

/** Transcript markdown con `rounds` header `### Round N — participant` e marker engine opzionale. */
function makeTranscript(rounds: number, participant: string, engineMarker: string | null): string {
	const parts: string[] = [`# Discussion ${participant}`];
	for (let i = 1; i <= rounds; i++) {
		parts.push(`### Round ${i} — ${participant} (analyst)`);
		parts.push(`Turn body for round ${i}.`);
	}
	if (engineMarker !== null) parts.push(engineMarker);
	return parts.join("\n\n") + "\n";
}

/** Riga JSONL di evento (shape helpers.ts:86: `ts` + `type` string). */
function ev(type: string, extra: Record<string, unknown> = {}): string {
	return JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", type, ...extra });
}

// ─── Scenario 1: cwd vuoto → zeri + "non disponibili" ───────────────────────

test("computeStatus su cwd vuoto: tutti i conteggi a 0, niente presente, mai throw", async () => {
	const tmp = makeTmpDir("empty");
	try {
		const report = await computeStatus(tmp);

		assert.equal(report.sessionCount, 0);
		assert.equal(report.turnCount, 0);
		assert.equal(report.totalCostUsd, 0);
		assert.deepEqual(report.engines, { gsd: 0, hermes: 0, unknown: 0 });
		assert.deepEqual(report.outcomes, { complete: 0, partial: 0, unknown: 0 });
		assert.equal(report.health.present, false);
		assert.equal(report.health.lastOutcome, null);
		assert.equal(report.health.failureCount, 0);
		assert.equal(report.metrics.present, false);
		assert.equal(report.metrics.counters, undefined);
		assert.equal(report.truncated, false);
		assert.equal(report.unreadableCount, 0);

		// Paths SEMPRE valorizzati anche su assenza (contratto computeStatus).
		const base = path.join(tmp, ".gsd", "discussion-arena");
		assert.equal(report.paths.transcriptsDir, path.join(base, "transcripts"));
		assert.equal(report.paths.eventsDir, path.join(base, "events"));
		assert.equal(report.paths.healthPath, path.join(base, "health.json"));
		assert.equal(report.paths.metricsPath, path.join(base, "metrics.json"));
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("formatStatus su cwd vuoto: path presenti + dicitura 'non disponibili'", async () => {
	const tmp = makeTmpDir("empty-fmt");
	try {
		const report = await computeStatus(tmp);
		const out = formatStatus(report);

		assert.ok(out.includes("Sessions: 0"));
		assert.ok(out.includes("Turns: 0"));
		assert.ok(out.includes(`non disponibili (${report.paths.metricsPath})`));
		assert.ok(out.includes(report.paths.transcriptsDir));
		assert.ok(out.includes(report.paths.eventsDir));
		assert.ok(out.includes(report.paths.healthPath));
		assert.ok(out.includes(report.paths.metricsPath));
		// Failure counter SEMPRE visibile anche a 0 (osservability: mai silenzio).
		assert.ok(out.includes("failures: 0"));
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

// ─── Scenario 2: 3 sessioni / 9 turni / costi e outcomes misti ──────────────

test("computeStatus su 3 sessioni + 3 event log: conteggi, costi, engine, outcomes corretti", async () => {
	const tmp = makeTmpDir("full");
	try {
		const base = path.join(tmp, ".gsd", "discussion-arena");

		// Transcripts: 3 file × 3 round = 9 header `### Round `; marker engine
		// canonici di run-participant.ts (hermes / gsd degradato / assente).
		await writeFileAt(
			path.join(base, "transcripts", "session-a.md"),
			makeTranscript(3, "analyst", "<!-- engine: hermes -->"),
		);
		await writeFileAt(
			path.join(base, "transcripts", "session-b.md"),
			makeTranscript(3, "critic", "<!-- engine: gsd (degradato da hermes: binario non disponibile) -->"),
		);
		await writeFileAt(
			path.join(base, "transcripts", "session-c.md"),
			makeTranscript(3, "observer", null),
		);

		// Event logs: costi terminali 0.02 / 0.005 / 0.003; esiti
		// complete / partial / nessun done (→ unknown).
		await writeFileAt(
			path.join(base, "events", "session-a.jsonl"),
			[
				ev("discussion_arena_start", { discussionArenaId: "a".repeat(32) }),
				ev("participant_message", { round: 1, participantId: "analyst", totalCost: 0.01 }),
				ev("round_end", { round: 1 }),
				ev("participant_message", { round: 2, participantId: "analyst", totalCost: 0.02 }),
				ev("round_end", { round: 2 }),
				ev("discussion_arena_done", { outcome: "complete", totalCost: 0.02 }),
			].join("\n") + "\n",
		);
		await writeFileAt(
			path.join(base, "events", "session-b.jsonl"),
			[
				ev("participant_message", { round: 1, participantId: "critic", totalCost: 0.005 }),
				ev("discussion_arena_done", { outcome: "partial", totalCost: 0.005 }),
			].join("\n") + "\n",
		);
		await writeFileAt(
			path.join(base, "events", "session-c.jsonl"),
			[
				ev("participant_message", { round: 1, participantId: "observer", totalCost: 0.003 }),
				ev("round_end", { round: 1 }),
			].join("\n") + "\n",
		);

		const report = await computeStatus(tmp);

		assert.equal(report.sessionCount, 3);
		assert.equal(report.turnCount, 9);
		// Somma dei costi terminali per sessione (restoredCost per file).
		assert.ok(
			Math.abs(report.totalCostUsd - 0.028) < 1e-9,
			`totalCostUsd atteso ~0.028, ottenuto ${report.totalCostUsd}`,
		);
		assert.deepEqual(report.engines, { gsd: 1, hermes: 1, unknown: 1 });
		assert.deepEqual(report.outcomes, { complete: 1, partial: 1, unknown: 1 });
		// Nessun file corrotto in questo scenario.
		assert.equal(report.unreadableCount, 0);
		assert.equal(report.truncated, false);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("formatStatus su fixture completa: riporta i numeri aggregati", async () => {
	const tmp = makeTmpDir("full-fmt");
	try {
		const base = path.join(tmp, ".gsd", "discussion-arena");
		await writeFileAt(
			path.join(base, "transcripts", "session-a.md"),
			makeTranscript(3, "analyst", "<!-- engine: hermes -->"),
		);
		await writeFileAt(
			path.join(base, "events", "session-a.jsonl"),
			[
				ev("participant_message", { round: 1, participantId: "analyst", totalCost: 0.02 }),
				ev("discussion_arena_done", { outcome: "complete", totalCost: 0.02 }),
			].join("\n") + "\n",
		);

		const report = await computeStatus(tmp);
		const out = formatStatus(report);

		assert.ok(out.includes("Sessions: 1"));
		assert.ok(out.includes("Turns: 3"));
		assert.ok(out.includes(`Cost: $${report.totalCostUsd.toFixed(4)}`));
		assert.ok(out.includes("Engine distribution: gsd 0, hermes 1, unknown 0"));
		assert.ok(out.includes("Outcomes: complete 1, partial 0, unknown 0"));
		// metrics.json assente → sezione metriche con "non disponibili".
		assert.ok(out.includes("non disponibili"));
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});
