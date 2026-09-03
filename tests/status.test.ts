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
 * Scenari avanzati (piano T02):
 *
 *   3. metrics.json presente con shape MetricsSnapshot valida →
 *      present true, counters popolati, sezione formattata CON il path;
 *      metrics.json malformato o shape-invalida → present false,
 *      unreadableCount incrementato, mai throw.
 *   4. health.json con lastOutcome fail/timeout → failureCount 1;
 *      success → failureCount 0; counter failures visibile in formatStatus.
 *   5. file corrotti: transcript ed event log illeggibili (simulati con
 *      una directory con estensione .md/.jsonl → EISDIR, errore non-ENOENT
 *      deterministico indipendente dai permessi/root) → unreadableCount > 0,
 *      conteggi degli altri file corretti, mai throw. Le righe non-JSON di
 *      un .jsonl NON incrementano unreadableCount: readEvents (helpers.ts)
 *      le salta fail-safe per design (comportamento verificato, non gap).
 *   6. cap 20 (D007): 22 transcript (1 round ciascuno) → aggregato su 20,
 *      truncated true, turnCount = turni dei SOLO file letti, nota visibile
 *      in formatStatus.
 *   7. graceful totale: .gsd/discussion-arena presente ma transcripts/
 *      events assenti → report valido con zeri e paths valorizzati.
 *   8. purità di formatStatus: stesso StatusReport → stringa identica
 *      (nessun clock); chiavi dei counters renderizzate ordinate.
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

import type { StatusReport } from "../status.js";
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

/**
 * Fixture `HealthSnapshot` (src/discussion-arena-health-probe.ts): shape
 * accettata da `readHealthSnapshot` (lastWriteTimestamp/lastOutcome/lockHeld/
 * pendingResearchWritten/tierFingerprint tutti presenti e tipati).
 */
function healthFixture(lastOutcome: "success" | "timeout" | "fail"): string {
	return (
		JSON.stringify({
			lastWriteTimestamp: "2026-01-01T00:00:00.000Z",
			lastOutcome,
			lockHeld: false,
			pendingResearchWritten: lastOutcome === "success",
			tierFingerprint: { tier: "F", reasons: [] },
		}, null, 2) + "\n"
	);
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

// ─── Scenario 3: metrics.json presente / malformato / shape-invalido ───────

test("computeStatus con metrics.json valido: present true, counters, sezione con path", async () => {
	const tmp = makeTmpDir("metrics-ok");
	try {
		const base = path.join(tmp, ".gsd", "discussion-arena");
		// Fixture diretta (nessun writer nel repo): shape `MetricsSnapshot`
		// di src/metrics.ts — counters con LabelKey `"{k=v}"`.
		await writeFileAt(
			path.join(base, "metrics.json"),
			JSON.stringify({
				counters: {
					discussion_arena_cost_usd: { "{participant=analyst}": 0.42 },
				},
				histograms: {},
			}, null, 2) + "\n",
		);

		const report = await computeStatus(tmp);
		assert.equal(report.metrics.present, true);
		assert.deepEqual(report.metrics.counters, {
			discussion_arena_cost_usd: { "{participant=analyst}": 0.42 },
		});
		assert.equal(report.unreadableCount, 0);

		const out = formatStatus(report);
		assert.ok(out.includes(`Metriche strutturate (${report.paths.metricsPath}):`));
		assert.ok(out.includes("discussion_arena_cost_usd"));
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("computeStatus con metrics.json malformato (JSON rotto): present false, unreadableCount, mai throw", async () => {
	const tmp = makeTmpDir("metrics-bad");
	try {
		const base = path.join(tmp, ".gsd", "discussion-arena");
		await writeFileAt(path.join(base, "metrics.json"), "{ non sono json <<<");

		const report = await computeStatus(tmp);
		assert.equal(report.metrics.present, false);
		assert.equal(report.metrics.counters, undefined);
		assert.equal(report.unreadableCount, 1);

		// La sezione formattata resta esplicita sul path (mai silenzio).
		assert.ok(formatStatus(report).includes(`non disponibili (${report.paths.metricsPath})`));
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("computeStatus con metrics.json shape-invalido (valori non numerici): present false, unreadableCount", async () => {
	const tmp = makeTmpDir("metrics-shape");
	try {
		const base = path.join(tmp, ".gsd", "discussion-arena");
		// JSON valido ma counters con valore stringa: viola la shape
		// Record<string, Record<string, number>> → presente ma inutilizzabile.
		await writeFileAt(
			path.join(base, "metrics.json"),
			JSON.stringify({ counters: { m: { "{k=1}": "non-un-numero" } } }) + "\n",
		);

		const report = await computeStatus(tmp);
		assert.equal(report.metrics.present, false);
		assert.equal(report.unreadableCount, 1);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

// ─── Scenario 4: health fail / timeout / success → failureCount 1/1/0 ──────

test("computeStatus health.json: fail/timeout → failureCount 1, success → 0, counter in formatStatus", async () => {
	for (const outcome of ["fail", "timeout", "success"] as const) {
		const tmp = makeTmpDir(`health-${outcome}`);
		try {
			const base = path.join(tmp, ".gsd", "discussion-arena");
			await writeFileAt(path.join(base, "health.json"), healthFixture(outcome));

			const report = await computeStatus(tmp);
			assert.equal(report.health.present, true, `outcome=${outcome}: present`);
			assert.equal(report.health.lastOutcome, outcome);
			const expectedFailures = outcome === "success" ? 0 : 1;
			assert.equal(
				report.health.failureCount,
				expectedFailures,
				`outcome=${outcome}: failureCount`,
				);

			// Il failure counter è SEMPRE visibile nella sezione formattata.
			assert.ok(formatStatus(report).includes(`failures: ${expectedFailures}`));
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	}
});

// ─── Scenario 5: file corrotti → unreadableCount, conteggi corretti, mai throw ─

test("computeStatus con file corrotti: unreadableCount > 0, resto corretto, mai throw", async () => {
	const tmp = makeTmpDir("corrupt");
	try {
		const base = path.join(tmp, ".gsd", "discussion-arena");

		// Simulazione deterministica di file illeggibile indipendente da
		// permessi/root: una DIRECTORY con estensione .md/.jsonl produce EISDIR
		// alla readFile — errore non-ENOENT che i path di aggregazione
		// contabilizzano come unreadable.
		await fsPromises.mkdir(path.join(base, "transcripts", "corrupt.md"), { recursive: true });
		await fsPromises.mkdir(path.join(base, "events", "corrupt.jsonl"), { recursive: true });

		// Un transcript valido e un event log valido sopravvivono ai corrotti.
		await writeFileAt(
			path.join(base, "transcripts", "good.md"),
			makeTranscript(2, "analyst", "<!-- engine: hermes -->"),
		);
		// Righe non-JSON e shape-invalida INTERCALATE: readEvents le salta in
		// silenzio (fail-safe documentato helpers.ts:404) → NON incrementano
		// unreadableCount, ma non inquinano i conteggi.
		await writeFileAt(
			path.join(base, "events", "good.jsonl"),
			[
				"<<< riga non-JSON >>>",
				JSON.stringify({ type: "manca-ts" }),
				ev("discussion_arena_done", { outcome: "complete", totalCost: 0.021 }),
			].join("\n") + "\n",
		);

		const report = await computeStatus(tmp);
		assert.equal(report.sessionCount, 1);
		assert.equal(report.turnCount, 2);
		assert.deepEqual(report.engines, { gsd: 0, hermes: 1, unknown: 0 });
		assert.ok(Math.abs(report.totalCostUsd - 0.021) < 1e-9);
		assert.deepEqual(report.outcomes, { complete: 1, partial: 0, unknown: 0 });
		// I 2 file illeggibili (corrupt.md + corrupt.jsonl) sono contati come
		// dati, non fatali; le righe garbage di good.jsonl NON sono contate.
		assert.equal(report.unreadableCount, 2);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

// ─── Scenario 6: cap 20 transcript (D007) → truncated + nota formattata ────

test("computeStatus cap 20: 22 transcript → aggregato su 20, truncated true, turni sui file letti", async () => {
	const tmp = makeTmpDir("cap");
	try {
		const base = path.join(tmp, ".gsd", "discussion-arena");
		// Ogni file ha ESATTAMENTE 1 round: quale sottoinsieme di 20 venga
		// selezionato (mtime/tie-break), turnCount è deterministico = 20.
		for (let i = 0; i < 22; i++) {
			await writeFileAt(
				path.join(base, "transcripts", `session-${String(i).padStart(2, "0")}.md`),
				makeTranscript(1, `participant-${i}`, null),
			);
		}

		const report = await computeStatus(tmp);
		assert.equal(report.sessionCount, 20);
		assert.equal(report.turnCount, 20);
		assert.equal(report.truncated, true);

		// La troncatura è documentata NELL'OUTPUT formattato, non solo nei dati.
		assert.ok(formatStatus(report).includes("showing the latest 20 sessions"));
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

// ─── Scenario 7: graceful totale — base dir presente, sottodirectory assenti ─

test("computeStatus graceful: .gsd/discussion-arena presente ma transcripts/events assenti", async () => {
	const tmp = makeTmpDir("graceful");
	try {
		// Solo la directory base: niente transcripts/, events/, health.json,
		// metrics.json — computeStatus NON deve lanciare e NON deve restare
		// silenzioso (zeri + paths valorizzati come dati).
		await fsPromises.mkdir(path.join(tmp, ".gsd", "discussion-arena"), { recursive: true });

		const report = await computeStatus(tmp);
		assert.equal(report.sessionCount, 0);
		assert.equal(report.turnCount, 0);
		assert.equal(report.totalCostUsd, 0);
		assert.deepEqual(report.engines, { gsd: 0, hermes: 0, unknown: 0 });
		assert.deepEqual(report.outcomes, { complete: 0, partial: 0, unknown: 0 });
		assert.equal(report.health.present, false);
		assert.equal(report.health.failureCount, 0);
		assert.equal(report.metrics.present, false);
		assert.equal(report.truncated, false);
		assert.equal(report.unreadableCount, 0);
		// Paths valorizzati anche su assenza totale delle fonti.
		const base = path.join(tmp, ".gsd", "discussion-arena");
		assert.equal(report.paths.transcriptsDir, path.join(base, "transcripts"));
		assert.equal(report.paths.eventsDir, path.join(base, "events"));
		assert.equal(report.paths.healthPath, path.join(base, "health.json"));
		assert.equal(report.paths.metricsPath, path.join(base, "metrics.json"));

		const out = formatStatus(report);
		assert.ok(out.includes("Sessions: 0"));
		assert.ok(out.includes("failures: 0"));
		assert.ok(out.includes(`non disponibili (${report.paths.metricsPath})`));
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

// ─── Scenario 8: purità di formatStatus — determinismo + ordinamento ──────

test("formatStatus è pura: stesso StatusReport → stringa identica, counters ordinati", () => {
	// Report costruito a mano con chiavi counters inserite in ordine NON
	// lessicografico: il rendering deve ordinarle comunque.
	const report: StatusReport = {
		sessionCount: 2,
		turnCount: 5,
		totalCostUsd: 0.125,
		engines: { gsd: 1, hermes: 1, unknown: 0 },
		outcomes: { complete: 1, partial: 1, unknown: 0 },
		health: {
			present: true,
			lastOutcome: "timeout",
			failureCount: 1,
			tierFingerprint: { tier: "A", reasons: ["has_capability"] },
			path: "/tmp/fixture/health.json",
		},
		metrics: {
			present: true,
			path: "/tmp/fixture/metrics.json",
			counters: {
				zz_metric: { "{b=2}": 1, "{a=1}": 5 },
				aa_metric: { "{x=9}": 3 },
			},
		},
		paths: {
			transcriptsDir: "/tmp/fixture/transcripts",
			eventsDir: "/tmp/fixture/events",
			healthPath: "/tmp/fixture/health.json",
			metricsPath: "/tmp/fixture/metrics.json",
		},
		truncated: false,
		unreadableCount: 0,
	};

	const first = formatStatus(report);
	const second = formatStatus(report);
	// Nessun clock, nessuna mutazione di stato: byte-identica.
	assert.equal(first, second);

	// Dentro una serie counter le LabelKey sono in ordine lessicografico...
	const zzLine = first.split("\n").find((line) => line.includes("zz_metric"));
	assert.ok(zzLine !== undefined, "riga zz_metric presente");
	assert.ok(
		zzLine.indexOf("{a=1}") !== -1 && zzLine.indexOf("{a=1}") < zzLine.indexOf("{b=2}"),
		`LabelKey ordinate dentro la serie: ${zzLine}`,
	);
	// ...e i nomi delle serie sono in ordine lessicografico.
	assert.ok(first.indexOf("aa_metric") < first.indexOf("zz_metric"));
});
