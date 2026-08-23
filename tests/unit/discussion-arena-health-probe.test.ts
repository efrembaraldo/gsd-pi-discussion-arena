/**
 * tests/unit/discussion-arena-health-probe.test.ts — T02/M013/S02.
 *
 * Suite del modulo `discussion-arena-health-probe.ts`: 5 unit test che
 * asseriscono il contratto a 3 superfici osservative dichiarato dalla slice
 * verification (log stderr NDJSON + health.json atomico + counter+histogram
 * telemetry) per ciascuno dei 3 outcome del lock pending-research
 * (success/timeout/fail).
 *
 * Pattern allineato a `tests/unit/pending-research-lock.test.ts:55`:
 * - niente self-import del loader (`../ts-esm-loader.mjs`), il loader globale
 *   è registrato dal flag `--import ./tests/ts-esm-loader.mjs` che la verify
 *   command passa a `node --test`;
 * - `collectStderr()` raccoglitore in-memory per asserire i log strutturati;
 * - tmpdir locali (`os.tmpdir() + mkdtemp`), mai path di progetto;
 * - `resetMetrics()` in `beforeEach` per isolare lo stato tra test.
 *
 * Il probe è sincrono per stderr + metriche ma ASINCRONO per la scrittura
 * di `health.json` (fire-and-forget serializzato via `emitChain` interna).
 * I test usano `flushPendingHealthEmits()` (esport test-only documentato) per
 * stabilizzare lo stato del file system prima di asserire contenuto/mtime
 * di `health.json` — senza questa helper le asserzioni sarebbero race-y.
 *
 * I test coprono:
 * 1. outcome=success → log plain + NDJSON + health.json + counter incrementato;
 * 2. outcome=timeout/fail → health.json lastOutcome corretto + pendingResearchWritten=false;
 * 3. tierFingerprint {tier:'D', reasons:['no_GSD_VERSION']} → health.json popolato;
 * 4. idempotenza: 2 chiamate identiche → mtime invariato + count metriche=2;
 * 5. best-effort: cwd read-only → log "probe emit failed" + metriche aggiornate + no throw.
 */

import { test, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
	recordPendingResearchOutcome,
	flushPendingHealthEmits,
	readHealthSnapshot,
	writeFileAtomicHealth,
	HEALTH_JSON_FILENAME,
	type RecordPendingResearchOutcomeArgs,
	type TierFingerprint,
} from "../../src/discussion-arena-health-probe.js";
import { resetMetrics, getMetrics } from "../../src/metrics.js";

// =============================================================================
// Helpers
// =============================================================================

/** Crea un workspace dir temporaneo per i test del probe. */
async function createTmpDir(): Promise<string> {
	return await fs.mkdtemp(path.join(os.tmpdir(), "health-probe-test-"));
}

/** Path canonico di health.json all'interno di un workspace. */
function healthJsonPath(cwd: string): string {
	return path.join(cwd, ".gsd", "discussion-arena", HEALTH_JSON_FILENAME);
}

/**
 * Raccoglitore stderr in-memory per asserire i log strutturati. Stessa shape
 * di `tests/unit/pending-research-lock.test.ts:55`: lo stream espone solo
 * `write(chunk)` e fa push delle righe (rimuovendo il newline terminale).
 */
function collectStderr(): {
	stream: NodeJS.WritableStream;
	lines: () => string[];
} {
	const lines: string[] = [];
	const stream = {
		write: (chunk: unknown) => {
			lines.push(String(chunk).replace(/\n$/, ""));
			return true;
		},
	} as NodeJS.WritableStream;
	return { stream, lines: () => lines };
}

/** Tier fingerprint riusato nei test (constant per chiarezza). */
const FINGERPRINT_A: TierFingerprint = { tier: "A", reasons: [] };
const FINGERPRINT_D: TierFingerprint = {
	tier: "D",
	reasons: ["no_GSD_VERSION"],
};

/** Costruisce args di base riusabili nei test. */
function makeArgs(
	overrides: Partial<RecordPendingResearchOutcomeArgs>,
): RecordPendingResearchOutcomeArgs {
	return {
		outcome: "success",
		durationMs: 5,
		lockHeld: false,
		tierFingerprint: FINGERPRINT_A,
		...overrides,
	};
}

/**
 * Asserisce che una riga NDJSON catturata dal `collectStderr()` abbia i campi
 * attesi del probe. `cwd` viene omesso dal check perché può/non può essere
 * presente (l'assenza del campo è significativa).
 */
function assertNdjsonLine(
	line: string,
	expected: {
		event: string;
		level: string;
		outcome: string;
		durationMs: number;
		lockHeld: boolean;
	},
): void {
	assert.ok(
		line.startsWith("{") && line.endsWith("}"),
		`NDJSON line non valida (no braces): ${line}`,
	);
	const parsed = JSON.parse(line) as Record<string, unknown>;
	assert.equal(parsed.event, expected.event, `event NDJSON errato: ${line}`);
	assert.equal(parsed.level, expected.level, `level NDJSON errato: ${line}`);
	assert.equal(parsed.outcome, expected.outcome, `outcome NDJSON errato: ${line}`);
	assert.equal(
		parsed.durationMs,
		expected.durationMs,
		`durationMs NDJSON errato: ${line}`,
	);
	assert.equal(
		parsed.lockHeld,
		expected.lockHeld,
		`lockHeld NDJSON errato: ${line}`,
	);
	assert.ok(typeof parsed.ts === "string", `ts NDJSON mancante/non string: ${line}`);
	const tf = parsed.tierFingerprint as TierFingerprint | undefined;
	assert.ok(tf && typeof tf === "object", `tierFingerprint NDJSON mancante: ${line}`);
}

// =============================================================================
// Setup / teardown
// =============================================================================

const workdirs: string[] = [];

beforeEach(() => {
	resetMetrics();
});

afterEach(async () => {
	// Restore eventuali permessi 0o555 prima del rm per evitare EACCES su cleanup.
	for (const d of workdirs) {
		try {
			await fs.chmod(d, 0o755);
			// Anche le subdir: chmod ricorsivo best-effort.
			const entries = await fs.readdir(d, { withFileTypes: true });
			for (const e of entries) {
				if (e.isDirectory()) {
					await fs.chmod(path.join(d, e.name), 0o755).catch(() => {});
				}
			}
		} catch {
			/* dir già rimossa */
		}
	}
	for (const d of workdirs.splice(0)) {
		await fs.rm(d, { recursive: true, force: true });
	}
	// Drena la chain: eventuali emissioni pendenti devono completare o fallire
	// prima del prossimo test (evita contaminazione di `health.json` su cwd di altri test).
	await flushPendingHealthEmits();
});

// =============================================================================
// Test 1: outcome=success → tutte e 3 le superfici osservative
// =============================================================================

test("recordPendingResearchOutcome: outcome=success emette plain text + NDJSON + health.json + counter", async () => {
	const cwd = await createTmpDir();
	workdirs.push(cwd);
	const { stream, lines } = collectStderr();

	recordPendingResearchOutcome(
		makeArgs({
			outcome: "success",
			durationMs: 5,
			lockHeld: false,
			tierFingerprint: FINGERPRINT_A,
			cwd,
			stderr: stream,
		}),
	);

	// Side-effect sync (1+2): log plain + NDJSON sono già visibili.
	const captured = lines();
	assert.ok(captured.length >= 2, `attese ≥2 righe stderr, trovate ${captured.length}`);

	const plain = captured[0]!;
	assert.ok(
		plain.includes("[discussion-arena] pending-research: success (5ms)"),
		`log plain text non contiene il prefisso canonico: ${plain}`,
	);

	const ndjson = captured.find((l) => l.startsWith("{")) ?? "";
	assert.ok(ndjson.length > 0, "nessuna riga NDJSON rilevata");
	assertNdjsonLine(ndjson, {
		event: "health_probe.pending_research",
		level: "info",
		outcome: "success",
		durationMs: 5,
		lockHeld: false,
	});

	// Side-effect 3 (metrica): sincrono SUBITO dopo la chiamata.
	const m1 = getMetrics();
	const counters1 = m1.counters["pending_research_writes_total"] ?? {};
	const cKey = "{outcome=success}";
	assert.equal(
		counters1[cKey],
		1,
		`counter pending_research_writes_total{outcome=success} atteso 1, trovato ${counters1[cKey] ?? 0}`,
	);
	const histo1 = m1.histograms["pending_research_write_duration_ms"] ?? {};
	const hKey = "{outcome=success}";
	assert.ok(
		histo1[hKey] !== undefined,
		"histogram pending_research_write_duration_ms{outcome=success} non presente",
	);
	assert.equal(histo1[hKey]!.count, 1);
	assert.equal(histo1[hKey]!.sum, 5);

	// Side-effect 4 (health.json): async, attendi la chain.
	await flushPendingHealthEmits();
	const snapshot = await readHealthSnapshot(cwd);
	assert.ok(snapshot !== null, "health.json non scritto o non parsabile");
	assert.equal(snapshot!.lastOutcome, "success");
	assert.equal(snapshot!.pendingResearchWritten, true);
	assert.equal(snapshot!.lockHeld, false);
	assert.equal(snapshot!.tierFingerprint.tier, "A");
	assert.deepEqual(snapshot!.tierFingerprint.reasons, []);
	assert.ok(
		typeof snapshot!.lastWriteTimestamp === "string" &&
			snapshot!.lastWriteTimestamp.length > 0,
		"lastWriteTimestamp mancante/non string",
	);
});

// =============================================================================
// Test 2: outcome=timeout e outcome=fail → health.json riflette correttamente
// =============================================================================

test("recordPendingResearchOutcome: outcome=timeout → health.json pendingResearchWritten=false", async () => {
	const cwd = await createTmpDir();
	workdirs.push(cwd);

	recordPendingResearchOutcome(
		makeArgs({
			outcome: "timeout",
			durationMs: 5000,
			lockHeld: false,
			tierFingerprint: FINGERPRINT_A,
			cwd,
		}),
	);

	await flushPendingHealthEmits();
	const snapshot = await readHealthSnapshot(cwd);
	assert.ok(snapshot !== null, "health.json non scritto");
	assert.equal(snapshot!.lastOutcome, "timeout");
	assert.equal(snapshot!.pendingResearchWritten, false);

	const m = getMetrics();
	const counter = m.counters["pending_research_writes_total"] ?? {};
	assert.equal(
		counter["{outcome=timeout}"],
		1,
		`counter timeout atteso 1, trovato ${counter["{outcome=timeout}"] ?? 0}`,
	);
});

test("recordPendingResearchOutcome: outcome=fail → health.json pendingResearchWritten=false", async () => {
	const cwd = await createTmpDir();
	workdirs.push(cwd);

	recordPendingResearchOutcome(
		makeArgs({
			outcome: "fail",
			durationMs: 250,
			lockHeld: false,
			tierFingerprint: FINGERPRINT_A,
			cwd,
		}),
	);

	await flushPendingHealthEmits();
	const snapshot = await readHealthSnapshot(cwd);
	assert.ok(snapshot !== null, "health.json non scritto");
	assert.equal(snapshot!.lastOutcome, "fail");
	assert.equal(snapshot!.pendingResearchWritten, false);

	const m = getMetrics();
	const counter = m.counters["pending_research_writes_total"] ?? {};
	assert.equal(
		counter["{outcome=fail}"],
		1,
		`counter fail atteso 1, trovato ${counter["{outcome=fail}"] ?? 0}`,
	);
});

// =============================================================================
// Test 3: tierFingerprint con tier='D' e reasons → health.json popolato
// =============================================================================

test("recordPendingResearchOutcome: tierFingerprint {tier:'D', reasons:['no_GSD_VERSION']} → health.json popolato", async () => {
	const cwd = await createTmpDir();
	workdirs.push(cwd);

	recordPendingResearchOutcome(
		makeArgs({
			outcome: "success",
			durationMs: 12,
			lockHeld: false,
			tierFingerprint: FINGERPRINT_D,
			cwd,
		}),
	);

	await flushPendingHealthEmits();
	const snapshot = await readHealthSnapshot(cwd);
	assert.ok(snapshot !== null, "health.json non scritto");
	assert.equal(snapshot!.tierFingerprint.tier, "D");
	assert.deepEqual(snapshot!.tierFingerprint.reasons, ["no_GSD_VERSION"]);
});

// =============================================================================
// Test 4: idempotenza — 2 chiamate identiche consecutive → mtime invariato + count=2
// =============================================================================

test("recordPendingResearchOutcome: 2 chiamate identiche consecutive → health.json byte-identico (no rewrite) ma metriche accumulano count=2", async () => {
	const cwd = await createTmpDir();
	workdirs.push(cwd);
	const hPath = healthJsonPath(cwd);

	// Prima chiamata: scrive health.json.
	recordPendingResearchOutcome(makeArgs({ outcome: "success", durationMs: 5, cwd }));
	await flushPendingHealthEmits();
	const stat1 = await fs.stat(hPath);
	const content1 = await fs.readFile(hPath, "utf-8");

	// Seconda chiamata con outcome/duration/tier IDENTICI: deve short-circuit
	// (read-then-compare identico → no atomic write).
	recordPendingResearchOutcome(makeArgs({ outcome: "success", durationMs: 5, cwd }));
	await flushPendingHealthEmits();
	const stat2 = await fs.stat(hPath);
	const content2 = await fs.readFile(hPath, "utf-8");

	assert.equal(content2, content1, "health.json dovrebbe essere byte-identico");
	assert.equal(
		stat2.mtimeMs,
		stat1.mtimeMs,
		`mtime cambiato: prima=${stat1.mtimeMs} dopo=${stat2.mtimeMs} (implica rewrite non idempotente)`,
	);

	// Metriche: counter incrementa ENTRAMBE le volte (count=2).
	const m = getMetrics();
	const counter = m.counters["pending_research_writes_total"] ?? {};
	assert.equal(
		counter["{outcome=success}"],
		2,
		`counter atteso 2 dopo 2 chiamate identiche, trovato ${counter["{outcome=success}"] ?? 0}`,
	);
	const histo = m.histograms["pending_research_write_duration_ms"] ?? {};
	assert.equal(histo["{outcome=success}"]!.count, 2);
	assert.equal(histo["{outcome=success}"]!.sum, 10);
});

// =============================================================================
// Test 5: best-effort — cwd read-only → log errore + no throw + metriche OK
// =============================================================================

test("recordPendingResearchOutcome: cwd read-only → log 'probe emit failed' + nessuna eccezione + metriche aggiornate", async () => {
	const cwd = await createTmpDir();
	workdirs.push(cwd);

	// Subdir che useremo come workspace read-only (l'utente che esegue i test
	// è `opengsd`, non root: chmod 0o555 blocca effettivamente mkdir/write).
	const readOnlyDir = path.join(cwd, "readonly-subdir");
	await fs.mkdir(readOnlyDir);
	await fs.chmod(readOnlyDir, 0o555);

	const { stream, lines } = collectStderr();

	// Deve NON lanciare eccezioni anche se la write atomic fallirà per EACCES.
	assert.doesNotThrow(() => {
		recordPendingResearchOutcome(
			makeArgs({
				outcome: "success",
				durationMs: 7,
				lockHeld: false,
				tierFingerprint: FINGERPRINT_A,
				cwd: readOnlyDir,
				stderr: stream,
			}),
		);
	});

	// Side-effect sync (1+2+3): log + NDJSON + metriche sono già visibili SUBITO.
	const capturedSync = lines();
	const hasPlain = capturedSync.some((l) =>
		l.includes("[discussion-arena] pending-research: success (7ms)"),
	);
	assert.ok(hasPlain, `atteso log plain text success (7ms), trovato: ${capturedSync.join(" | ")}`);
	const hasNdjson = capturedSync.some((l) => l.includes('"event":"health_probe.pending_research"'));
	assert.ok(hasNdjson, `attesa riga NDJSON, trovato: ${capturedSync.join(" | ")}`);

	const mSync = getMetrics();
	assert.equal(
		mSync.counters["pending_research_writes_total"]?.["{outcome=success}"] ?? 0,
		1,
		"counter pending_research_writes_total{outcome=success} atteso 1 (registrato sincronous prima della failure async)",
	);

	// Side-effect 4 (async) deve completare la chain → "probe emit failed" su stderr.
	await flushPendingHealthEmits();

	const capturedAsync = lines();
	const hasProbeFailed = capturedAsync.some((l) =>
		l.includes("[discussion-arena] pending-research: probe emit failed"),
	);
	assert.ok(
		hasProbeFailed,
		`atteso log 'probe emit failed' dopo failure async, trovato: ${capturedAsync.join(" | ")}`,
	);

	// Metriche restano aggiornate (= 1, NON resettate dalla failure async).
	const mAsync = getMetrics();
	assert.equal(
		mAsync.counters["pending_research_writes_total"]?.["{outcome=success}"] ?? 0,
		1,
		"counter deve restare a 1 dopo la failure async (registrato SUBITO, fuori dal try/catch)",
	);

	// health.json NON deve esistere (la write atomic è fallita per EACCES).
	const hPath = healthJsonPath(readOnlyDir);
	const exists = await fs
		.stat(hPath)
		.then(() => true)
		.catch(() => false);
	assert.equal(exists, false, `health.json non dovrebbe esistere in dir read-only: ${hPath}`);
});

// =============================================================================
// Test extra: writeFileAtomicHealth + readHealthSnapshot round-trip
// =============================================================================

test("writeFileAtomicHealth + readHealthSnapshot: round-trip di uno snapshot", async () => {
	const cwd = await createTmpDir();
	workdirs.push(cwd);
	const hPath = healthJsonPath(cwd);
	const snapshot = {
		lastWriteTimestamp: "2026-08-23T10:00:00.000Z",
		lastOutcome: "success" as const,
		lockHeld: false,
		pendingResearchWritten: true,
		tierFingerprint: { tier: "A" as const, reasons: ["ok"] },
	};
	const content = `${JSON.stringify(snapshot, null, 2)}\n`;

	await writeFileAtomicHealth(hPath, content);

	const readBack = await readHealthSnapshot(cwd);
	assert.ok(readBack !== null, "snapshot non letto");
	assert.deepEqual(readBack, snapshot);

	// Idempotenza byte-per-byte di writeFileAtomicHealth: scrivere lo stesso
	// contenuto due volte deve produrre byte identici (anche se mtime cambia).
	const stat1 = await fs.stat(hPath);
	await writeFileAtomicHealth(hPath, content);
	const stat2 = await fs.stat(hPath);
	const contentAfter = await fs.readFile(hPath, "utf-8");
	assert.equal(contentAfter, content, "contenuto alterato da seconda write");
	void stat1;
	void stat2;
});
