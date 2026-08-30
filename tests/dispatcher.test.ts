/**
 * tests/dispatcher.test.ts — Unit test del dispatcher M015/S03 (T01).
 *
 * Copertura:
 *  (1) hermes + isHermesAvailable=true -> delega a runParticipantTurnViaHermes + engineMarker hermes.
 *  (2) hermes + isHermesAvailable=false -> delega a runParticipantTurn + stderr warning una volta + engineMarker degradato.
 *  (3) engine="gsd" o undefined -> delega a runParticipantTurn (no marker, no warning); retrocompat pre-M015.
 *  (4) Dedup stress: due chiamate consecutive con hermes unavailable emettono warning UNA sola volta.
 *
 * Pattern di mock/controllo dipendenze:
 *  - `__setDispatcherRunnersForTest` / `__resetDispatcherRunnersForTest`
 *    (test-seam module-scope in run-participant.ts) sostituiscono i runner
 *    reali con mock MockFunction di node:test, evitando spawn di subprocess.
 *    I runner reali condividono il modulo del dispatcher, quindi NON sono
 *    mockabili via mock.module (che richiederebbe
 *    --experimental-test-module-mocks).
 *  - `isHermesAvailable()` (in ../src/hermes-readiness.js) viene controllata
 *    tramite manipolazione di process.env.PATH + resetHermesProbeCache().
 *    Quando hermes non è nel PATH, execFileSync("hermes", ...) lancia
 *    ENOENT PRIMA di qualsiasi spawn, quindi `isHermesAvailable()` ritorna
 *    false senza che alcun subprocess venga avviato. Il cache TTL 30s è
 *    invalidato tra test per garantire che il cambio di PATH abbia effetto.
 */

import { test, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ResolvedLimits } from "../helpers.js";
import type { ParticipantConfig } from "../participants.js";
import type { ParticipantTurnResult } from "../run-participant.js";
import { isHermesAvailable, resetHermesProbeCache } from "../src/hermes-readiness.js";

// ── Import del dispatcher (run-participant.js esporta il dispatcher; i
//    suoi runner reali sono swappati via test-seam in beforeEach). ──────────
const {
	dispatchParticipantTurn,
	__setDispatcherRunnersForTest,
	__resetDispatcherRunnersForTest,
} = await import("../run-participant.js");

// ── Helpers ──────────────────────────────────────────────────────────────────

type RunTurnFn = (
	participant: ParticipantConfig,
	promptForThisTurn: string,
	cwd: string,
	signal: AbortSignal | undefined,
	modelOverride?: string,
	limits?: ResolvedLimits,
) => Promise<ParticipantTurnResult>;

/**
 * Wrapper MockFunction. `runner` resta tipato come MockFunction così possiamo
 * ispezionare `runner.mock.callCount()` / `runner.mock.calls` nei assert; il
 * cast a RunTurnFn avviene SOLO al call site del test-seam, dove il tipo
 * del setter richiede la firma di runParticipantTurn.
 */
interface MockRunner {
	runner: ReturnType<typeof mock.fn>;
	calls: unknown[];
}

function makeMockRunner(textForResult: string): MockRunner {
	const calls: unknown[] = [];
	const runner = mock.fn(
		async (
			participant: ParticipantConfig,
			promptForThisTurn: string,
			cwd: string,
			signal: AbortSignal | undefined,
			modelOverride?: string,
			limits?: ResolvedLimits,
		): Promise<ParticipantTurnResult> => {
			calls.push({
				participant,
				promptForThisTurn,
				cwd,
				signal,
				modelOverride,
				limits,
			});
			return {
				participant: participant.name,
				role: participant.role,
				exitCode: 0,
				text: textForResult,
				stderr: "",
				usage: { input: 0, output: 0, cost: 0, turns: 1 },
				durationMs: 100,
			};
		},
	);
	return { runner, calls };
}

async function captureStderr<T>(
	fn: () => Promise<T>,
): Promise<{ result: T; stderr: string }> {
	const orig = process.stderr.write.bind(process.stderr);
	let buf = "";
	process.stderr.write = ((chunk: unknown): boolean => {
		buf +=
			typeof chunk === "string"
				? chunk
				: (chunk as { toString(): string }).toString();
		return true;
	}) as typeof process.stderr.write;
	try {
		const result = await fn();
		return { result, stderr: buf };
	} finally {
		process.stderr.write = orig;
	}
}

/**
 * Crea una directory vuota in os.tmpdir() e la usa come PATH per forzare
 * `isHermesAvailable()` a false (execFileSync lancia ENOENT perché hermes
 * non è trovato). Ritorna l'helper di cleanup che ripristina PATH e
 * invalida la cache 30s.
 */
async function withHermesUnavailable<T>(
	fn: () => Promise<T>,
): Promise<T> {
	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "no-hermes-"));
	const originalPath = process.env.PATH;
	process.env.PATH = tmpDir;
	resetHermesProbeCache();
	try {
		return await fn();
	} finally {
		process.env.PATH = originalPath;
		resetHermesProbeCache();
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
	}
}

// ── Test fixtures ────────────────────────────────────────────────────────────

const hermesParticipant: ParticipantConfig = {
	name: "researcher",
	role: "Ricercatore",
	description: "Indaga, raccoglie dati e cita fonti",
	engine: "hermes",
	limits: {},
	systemPrompt: "Sei il Ricercatore.",
	source: "bundled",
	filePath: "participants/researcher.md",
};

const gsdParticipant: ParticipantConfig = {
	name: "analyst",
	role: "Business Analyst",
	description: "Chiarisce requisiti",
	limits: {},
	systemPrompt: "Sei l'Analyst.",
	source: "bundled",
	filePath: "participants/analyst.md",
};

const legacyParticipant: ParticipantConfig = {
	name: "legacy",
	role: "Legacy",
	description: "Pre-M015 (engine undefined)",
	limits: {},
	systemPrompt: "Sei un participant legacy.",
	source: "bundled",
	filePath: "participants/legacy.md",
};

// ── Setup/reset tra test ─────────────────────────────────────────────────────

let mockGsd: MockRunner;
let mockHermes: MockRunner;

beforeEach(() => {
	__resetDispatcherRunnersForTest();
	mockGsd = makeMockRunner("gsd fallback output");
	mockHermes = makeMockRunner("hermes output");
	__setDispatcherRunnersForTest(
		mockGsd.runner as unknown as RunTurnFn,
		mockHermes.runner as unknown as RunTurnFn,
	);
});

afterEach(() => {
	__resetDispatcherRunnersForTest();
	// Invalidata la cache probe tra test per garantire che PATH overrides
	// dal test precedente non influenzino il successivo.
	resetHermesProbeCache();
});

// ── Test ─────────────────────────────────────────────────────────────────────

test(
	"dispatchParticipantTurn: engine=hermes && isHermesAvailable=true → delega a hermes + engineMarker hermes",
	async (t) => {
		// Affida al PATH reale del sistema: se hermes è in PATH
		// (verificato da `test -x /home/opengsd/.local/bin/hermes` nel
		// piano di slice M015/S03), isHermesAvailable() ritorna true.
		resetHermesProbeCache();
		if (!isHermesAvailable()) {
			t.skip(
				"hermes non disponibile nel PATH — test gated skippato (CI senza hermes install)",
			);
			return;
		}
		const result = await dispatchParticipantTurn(
			hermesParticipant,
			"...prompt...",
			"/tmp",
			undefined,
		);
		assert.equal(mockHermes.runner.mock.callCount(), 1);
		assert.equal(mockGsd.runner.mock.callCount(), 0);
		assert.equal(result.engineMarker, "<!-- engine: hermes -->");
		assert.equal(result.text, "hermes output");
	},
);

test(
	"dispatchParticipantTurn: engine=hermes && isHermesAvailable=false → delega a gsd + warning una volta + engineMarker degradato",
	async () => {
		await withHermesUnavailable(async () => {
			const { result, stderr } = await captureStderr(() =>
				dispatchParticipantTurn(
					hermesParticipant,
					"...prompt...",
					"/tmp",
					undefined,
				),
			);
			assert.equal(mockHermes.runner.mock.callCount(), 0);
			assert.equal(mockGsd.runner.mock.callCount(), 1);
			assert.equal(
				result.engineMarker,
				"<!-- engine: gsd (degradato da hermes: binario non disponibile) -->",
			);
			assert.match(stderr, /engine "hermes" richiesto ma binario non disponibile/);
			assert.match(stderr, /researcher/);
		});
	},
);

test(
	"dispatchParticipantTurn: engine=gsd o undefined → delega a gsd (no marker, no warning) — retrocompat pre-M015",
	async () => {
		await withHermesUnavailable(async () => {
			// engine=gsd
			const { result: r1, stderr: s1 } = await captureStderr(() =>
				dispatchParticipantTurn(gsdParticipant, "...prompt...", "/tmp", undefined),
			);
			assert.equal(mockGsd.runner.mock.callCount(), 1);
			assert.equal(r1.engineMarker, undefined);
			assert.equal(s1, "");
			// engine=undefined (pre-M015 retrocompat)
			const { result: r2, stderr: s2 } = await captureStderr(() =>
				dispatchParticipantTurn(
					legacyParticipant,
					"...prompt...",
					"/tmp",
					undefined,
				),
			);
			assert.equal(mockGsd.runner.mock.callCount(), 2);
			assert.equal(r2.engineMarker, undefined);
			assert.equal(s2, "");
		});
	},
);

test(
	"dispatchParticipantTurn: due chiamate consecutive con hermes unavailable emettono warning UNA sola volta",
	async () => {
		await withHermesUnavailable(async () => {
			const { stderr } = await captureStderr(async () => {
				await dispatchParticipantTurn(
					hermesParticipant,
					"...prompt...",
					"/tmp",
					undefined,
				);
				await dispatchParticipantTurn(
					hermesParticipant,
					"...prompt...",
					"/tmp",
					undefined,
				);
			});
			const matches = stderr.match(/engine "hermes" richiesto/);
			assert.equal(matches?.length ?? 0, 1);
			// Entrambe le chiamate hanno comunque eseguito il fallback gsd.
			assert.equal(mockGsd.runner.mock.callCount(), 2);
		});
	},
);
