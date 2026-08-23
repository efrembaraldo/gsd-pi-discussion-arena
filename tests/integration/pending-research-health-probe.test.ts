/**
 * tests/integration/pending-research-health-probe.test.ts — T03/M013/S02.
 *
 * Suite di integrazione per il wiring di `recordPendingResearchOutcome` nei
 * 3 rami di `withPendingResearchLock` (success/timeout/fail). Ogni test:
 *
 *   - invoca `withPendingResearchLock` con uno scenario controllato (fn()
 *     che ritorna, oppure lock pre-seedato che forza timeout, oppure fn()
 *     che lancia errore generico);
 *   - asserisce che TUTTE le 4 superfici osservative siano attivate in
 *     modo sincronizzato: (a) stderr plain text con prefisso canonico
 *     `[discussion-arena] pending-research:`, (b) stderr NDJSON con
 *     `event:"health_probe.pending_research"`, (c) counter
 *     `pending_research_writes_total{outcome=<...>}` e histogram
 *     `pending_research_write_duration_ms{outcome=<...>}`, (d) file
 *     `.gsd/discussion-arena/health.json` con snapshot coerente.
 *
 * Branch coperti:
 *   - **SUCCESS** — `fn()` ritorna senza errori → outcome=success,
 *     `lockHeld=true` (lock acquisito durante `fn()`, rilascio in finally),
 *     `pendingResearchWritten=true`.
 *   - **TIMEOUT** — pre-seed lock attivo (non stale) + `timeoutMs` basso →
 *     `acquirePendingResearchLock` lancia `PendingResearchLockTimeoutError`
 *     → outcome=timeout, `lockHeld=false` (lock mai acquisito),
 *     `pendingResearchWritten=false`. `fn()` MAI invocata.
 *   - **FAIL** — `fn()` lancia `Error` generico (simula writePendingResearch
 *     fallita) → outcome=fail, `lockHeld=true` (lock acquisito durante
 *     `fn()`), `pendingResearchWritten=false`.
 *
 * Pattern allineato a `tests/integration/pending-research-roundtrip.test.ts`
 * (self-import del loader per self-sufficiency anche senza il flag
 * `--import ./tests/ts-esm-loader.mjs`, mkdtemp locale, afterEach cleanup
 * best-effort) + `tests/unit/discussion-arena-health-probe.test.ts`
 * (`flushPendingHealthEmits` per stabilizzare l'emissione async di
 * `health.json`).
 */

// Self-sufficiency: registra i hook ESM (`.js` -> `.ts` + stub
// `@gsd/pi-coding-agent`) anche quando il file gira sotto `node --test`
// senza il flag `--import ./tests/ts-esm-loader.mjs` (es. quando invocato
// direttamente via verify command slice-level).
import "../ts-esm-loader.mjs";
import * as assert from "node:assert/strict";
import { test, beforeEach, afterEach } from "node:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
	withPendingResearchLock,
	pendingResearchLockPath,
	PendingResearchLockTimeoutError,
} from "../../src/discussion-arena-pending-research.js";
import {
	readHealthSnapshot,
	flushPendingHealthEmits,
	type TierFingerprint,
} from "../../src/discussion-arena-health-probe.js";
import { resetMetrics, getMetrics } from "../../src/metrics.js";

// =============================================================================
// Helpers
// =============================================================================

/** Workspace dirs creati durante la suite (cleanup deterministico in afterEach). */
const workdirs: string[] = [];

/** Raccoglitore stderr in-memory, shape identica a
 *  `tests/unit/pending-research-lock.test.ts:55`. */
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

/** Pre-popola un lock file con stato raw (per test timeout). */
async function seedLockFile(
	lockPath: string,
	state: { pid: number; createdAtMs: number },
): Promise<void> {
	const dir = path.dirname(lockPath);
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(lockPath, JSON.stringify(state), "utf-8");
}

/** Crea un workspace dir temporaneo isolato per ogni test. */
async function createTmpDir(): Promise<string> {
	return await fs.mkdtemp(path.join(os.tmpdir(), "health-probe-int-"));
}

/** Regex statiche pre-compilate per la plain text del probe (una per
 *  outcome). Lookup table + typed outcome → nessuna `new RegExp(stringa)`
 *  dinamica (il pattern è allowlisted a compile-time dal union type, e le
 *  regex sono pre-costruite al module load). Formato plain text del probe:
 *  `[discussion-arena] pending-research: <outcome> (<durationMs>ms)`.
 *  Altre righe del modulo pending-research (es. lock acquisition/wait/
 *  timeout, formato `pending-research: lock timeout pid=... waited=...ms
 *  PATH`) hanno prefisso `lock ` e NON matchano (evita falsi positivi
 *  tipo matchare "timeout" nella riga "lock timeout pid=..."). */
const PLAIN_LINE_REGEX: Readonly<Record<"success" | "timeout" | "fail", RegExp>> = {
	success: /^\[discussion-arena\] pending-research: success \(\d+ms\)$/,
	timeout: /^\[discussion-arena\] pending-research: timeout \(\d+ms\)$/,
	fail: /^\[discussion-arena\] pending-research: fail \(\d+ms\)$/,
};

/** Cerca la prima riga stderr plain text del probe con il prefisso canonico. */
function findPlainLine(
	lines: string[],
	outcome: "success" | "timeout" | "fail",
): string | undefined {
	const re = PLAIN_LINE_REGEX[outcome];
	return lines.find((l) => re.test(l));
}

/** Cerca la prima riga NDJSON del probe (event=health_probe.pending_research). */
function findNdjsonLine(lines: string[]): string | undefined {
	return lines.find(
		(l) =>
			l.startsWith("{") &&
			l.includes('"event":"health_probe.pending_research"'),
	);
}

// =============================================================================
// Setup / teardown
// =============================================================================

beforeEach(() => {
	// Isola le metriche tra test (counter/histogram sono singleton in-process).
	resetMetrics();
});

afterEach(async () => {
	// Restore permessi 0o555 prima del rm (test best-effort potrebbe averli
	// modificati) + rimozione ricorsiva. Best-effort: ENOENT ignorato.
	for (const d of workdirs.splice(0)) {
		try {
			await fs.chmod(d, 0o755);
			const entries = await fs.readdir(d, { withFileTypes: true });
			for (const e of entries) {
				if (e.isDirectory()) {
					await fs.chmod(path.join(d, e.name), 0o755).catch(() => {});
				}
			}
		} catch {
			/* dir già rimossa */
		}
		await fs.rm(d, { recursive: true, force: true });
	}
	// Drena la emitChain del probe: emissioni pendenti devono completare o
	// fallire prima del prossimo test (evita contaminazione di `health.json`).
	await flushPendingHealthEmits();
});

// =============================================================================
// Test 1: SUCCESS branch
// =============================================================================

test("withPendingResearchLock + health probe: SUCCESS branch attiva tutte e 4 le superfici osservative", async () => {
	const cwd = await createTmpDir();
	workdirs.push(cwd);
	const { stream, lines } = collectStderr();
	const tf: TierFingerprint = { tier: "A", reasons: [] };

	const result = await withPendingResearchLock(
		cwd,
		async () => "ok",
		{ tierFingerprint: tf, stderr: stream },
	);
	assert.equal(result, "ok", "fn() deve essere eseguita e ritornare il valore");

	const captured = lines();

	// (a) Stderr plain text.
	const plain = findPlainLine(captured, "success");
	assert.ok(
		plain !== undefined,
		`atteso log plain text 'success': ${captured.join(" | ")}`,
	);
	assert.match(
		plain!,
		/^\[discussion-arena\] pending-research: success \(\d+ms\)$/,
		`formato plain text canonico non rispettato: ${plain}`,
	);

	// (b) Stderr NDJSON.
	const ndjson = findNdjsonLine(captured);
	assert.ok(ndjson !== undefined, `attesa riga NDJSON: ${captured.join(" | ")}`);
	const parsed = JSON.parse(ndjson!) as Record<string, unknown>;
	assert.equal(parsed.event, "health_probe.pending_research");
	assert.equal(parsed.outcome, "success");
	assert.equal(parsed.lockHeld, true, "lockHeld=true durante fn() (rilascio in finally)");
	assert.equal(parsed.cwd, cwd, "cwd propagato nel NDJSON");
	const ndjsonTf = parsed.tierFingerprint as TierFingerprint;
	assert.equal(ndjsonTf.tier, "A");
	assert.deepEqual(ndjsonTf.reasons, []);

	// (c) Metriche sincrone (counter + histogram).
	const m = getMetrics();
	const counterKey = "{outcome=success}";
	assert.equal(
		m.counters["pending_research_writes_total"]?.[counterKey] ?? 0,
		1,
		`counter pending_research_writes_total{outcome=success} atteso 1, trovato ${
			m.counters["pending_research_writes_total"]?.[counterKey] ?? 0
		}`,
	);
	const histoKey = "{outcome=success}";
	const histo = m.histograms["pending_research_write_duration_ms"]?.[histoKey];
	assert.ok(
		histo !== undefined,
		"histogram pending_research_write_duration_ms{outcome=success} non presente",
	);
	assert.equal(histo!.count, 1, "histogram count=1");
	assert.ok(
		histo!.sum >= 0,
		`histogram sum deve essere un numero non negativo (era ${histo!.sum})`,
	);

	// (d) health.json async (attendere flush).
	await flushPendingHealthEmits();
	const snapshot = await readHealthSnapshot(cwd);
	assert.ok(snapshot !== null, "health.json non scritto o non parsabile");
	assert.equal(snapshot!.lastOutcome, "success");
	assert.equal(
		snapshot!.pendingResearchWritten,
		true,
		"pendingResearchWritten=true solo per outcome=success",
	);
	assert.equal(snapshot!.lockHeld, true);
	assert.equal(snapshot!.tierFingerprint.tier, "A");
	assert.deepEqual(snapshot!.tierFingerprint.reasons, []);
	assert.ok(
		typeof snapshot!.lastWriteTimestamp === "string" &&
			snapshot!.lastWriteTimestamp.length > 0,
		"lastWriteTimestamp presente",
	);
});

// =============================================================================
// Test 2: TIMEOUT branch
// =============================================================================

test("withPendingResearchLock + health probe: TIMEOUT branch emette outcome=timeout quando acquire fallisce per timeout", async () => {
	const cwd = await createTmpDir();
	workdirs.push(cwd);
	const { stream, lines } = collectStderr();
	const tf: TierFingerprint = { tier: "A", reasons: [] };

	// Pre-seed lock ATTIVO (createdAtMs=now, age=0 < staleAfterMs): non
	// verrà recuperato per stale-recovery, il waiter deve ciclare fino al
	// timeout. staleAfterMs alto (60s) impedisce il recovery.
	const lockPath = pendingResearchLockPath(cwd);
	await seedLockFile(lockPath, { pid: 99999, createdAtMs: Date.now() });

	let fnCalled = false;
	await assert.rejects(
		withPendingResearchLock(
			cwd,
			async () => {
				fnCalled = true;
				return "should-not-run";
			},
			{
				timeoutMs: 120,
				pollIntervalMs: 10,
				staleAfterMs: 60_000,
				stderr: stream,
				tierFingerprint: tf,
			},
		),
		(err: unknown) => {
			assert.ok(
				err instanceof PendingResearchLockTimeoutError,
				"errore deve essere PendingResearchLockTimeoutError",
			);
			const e = err as PendingResearchLockTimeoutError;
			assert.equal(e.lockPath, lockPath);
			assert.equal(e.ownerPid, 99999, "ownerPid riflette il PID blocker");
			assert.ok(
				e.waitedMs >= 120,
				`waitedMs >= timeoutMs (era ${e.waitedMs})`,
			);
			return true;
		},
	);
	assert.equal(fnCalled, false, "fn MAI chiamata quando acquire fa timeout");

	const captured = lines();

	// (a) Stderr plain text 'timeout'.
	const plain = findPlainLine(captured, "timeout");
	assert.ok(
		plain !== undefined,
		`atteso log plain text 'timeout': ${captured.join(" | ")}`,
	);
	assert.match(
		plain!,
		/^\[discussion-arena\] pending-research: timeout \(\d+ms\)$/,
		`formato plain text canonico non rispettato: ${plain}`,
	);

	// (b) Stderr NDJSON con outcome=timeout.
	const ndjson = findNdjsonLine(captured);
	assert.ok(ndjson !== undefined, `attesa riga NDJSON: ${captured.join(" | ")}`);
	const parsed = JSON.parse(ndjson!) as Record<string, unknown>;
	assert.equal(parsed.outcome, "timeout");
	assert.equal(
		parsed.lockHeld,
		false,
		"lockHeld=false (lock mai acquisito durante timeout)",
	);
	assert.equal(parsed.cwd, cwd, "cwd propagato nel NDJSON");

	// (c) Metriche sincrone — counter+histogram{outcome=timeout}.
	const m = getMetrics();
	const counterKey = "{outcome=timeout}";
	assert.equal(
		m.counters["pending_research_writes_total"]?.[counterKey] ?? 0,
		1,
		`counter pending_research_writes_total{outcome=timeout} atteso 1, trovato ${
			m.counters["pending_research_writes_total"]?.[counterKey] ?? 0
		}`,
	);
	const histo = m.histograms["pending_research_write_duration_ms"]?.[counterKey];
	assert.ok(histo !== undefined, "histogram{outcome=timeout} non presente");
	assert.equal(histo!.count, 1);
	assert.ok(
		histo!.sum >= 120,
		`histogram sum deve riflettere waitedMs>=timeoutMs (era ${histo!.sum})`,
	);

	// (d) health.json async.
	await flushPendingHealthEmits();
	const snapshot = await readHealthSnapshot(cwd);
	assert.ok(snapshot !== null, "health.json non scritto");
	assert.equal(snapshot!.lastOutcome, "timeout");
	assert.equal(
		snapshot!.pendingResearchWritten,
		false,
		"pendingResearchWritten=false per outcome=timeout",
	);
	assert.equal(
		snapshot!.lockHeld,
		false,
		"health.json lockHeld=false per timeout (lock mai acquisito)",
	);
});

// =============================================================================
// Test 3: FAIL branch
// =============================================================================

test("withPendingResearchLock + health probe: FAIL branch emette outcome=fail quando fn() lancia errore generico", async () => {
	const cwd = await createTmpDir();
	workdirs.push(cwd);
	const { stream, lines } = collectStderr();
	const tf: TierFingerprint = {
		tier: "D",
		reasons: ["no_GSD_VERSION", "missing_capability:discussion_arena"],
	};

	// Errore lanciato da fn() simulando un writePendingResearch fallito.
	const sentinel = "writePendingResearch boom";
	await assert.rejects(
		withPendingResearchLock(
			cwd,
			async () => {
				throw new Error(sentinel);
			},
			{ stderr: stream, tierFingerprint: tf },
		),
		(err: unknown) => err instanceof Error && err.message === sentinel,
	);

	const captured = lines();

	// (a) Stderr plain text 'fail'.
	const plain = findPlainLine(captured, "fail");
	assert.ok(
		plain !== undefined,
		`atteso log plain text 'fail': ${captured.join(" | ")}`,
	);
	assert.match(
		plain!,
		/^\[discussion-arena\] pending-research: fail \(\d+ms\)$/,
		`formato plain text canonico non rispettato: ${plain}`,
	);

	// (b) Stderr NDJSON con outcome=fail e tierFingerprint completo.
	const ndjson = findNdjsonLine(captured);
	assert.ok(ndjson !== undefined, `attesa riga NDJSON: ${captured.join(" | ")}`);
	const parsed = JSON.parse(ndjson!) as Record<string, unknown>;
	assert.equal(parsed.outcome, "fail");
	assert.equal(
		parsed.lockHeld,
		true,
		"lockHeld=true (lock acquisito durante fn(); finally non ancora eseguito)",
	);
	assert.equal(parsed.cwd, cwd, "cwd propagato nel NDJSON");
	const ndjsonTf = parsed.tierFingerprint as TierFingerprint;
	assert.equal(ndjsonTf.tier, "D");
	assert.deepEqual(ndjsonTf.reasons, [
		"no_GSD_VERSION",
		"missing_capability:discussion_arena",
	]);

	// (c) Metriche sincrone — counter+histogram{outcome=fail}.
	const m = getMetrics();
	const counterKey = "{outcome=fail}";
	assert.equal(
		m.counters["pending_research_writes_total"]?.[counterKey] ?? 0,
		1,
		`counter pending_research_writes_total{outcome=fail} atteso 1, trovato ${
			m.counters["pending_research_writes_total"]?.[counterKey] ?? 0
		}`,
	);
	const histo = m.histograms["pending_research_write_duration_ms"]?.[counterKey];
	assert.ok(histo !== undefined, "histogram{outcome=fail} non presente");
	assert.equal(histo!.count, 1);

	// (d) health.json async.
	await flushPendingHealthEmits();
	const snapshot = await readHealthSnapshot(cwd);
	assert.ok(snapshot !== null, "health.json non scritto");
	assert.equal(snapshot!.lastOutcome, "fail");
	assert.equal(
		snapshot!.pendingResearchWritten,
		false,
		"pendingResearchWritten=false per outcome=fail (write non avvenuto)",
	);
	assert.equal(
		snapshot!.lockHeld,
		true,
		"health.json lockHeld=true per fail (lock acquisito durante fn())",
	);
	assert.equal(snapshot!.tierFingerprint.tier, "D");
	assert.deepEqual(snapshot!.tierFingerprint.reasons, [
		"no_GSD_VERSION",
		"missing_capability:discussion_arena",
	]);
});
