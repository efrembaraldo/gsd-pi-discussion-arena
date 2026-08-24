/**
 * tests/integration/gsd-api-adapter.test.ts — Integration test per
 * GSDExtensionAPI adapter + conditional forcing end-to-end (S01/T03 — M014).
 *
 * Spec eseguibile del success criteria S01 (4 test). Esercita il path
 * completo adapter → hooks → metrics, isolando le failures che i unit test
 * T01 + T02 non coprono:
 *   - interaction `getRuntimePhase` async wrapper + `isGSDExtensionAPI`
 *     narrowing su stub reale (compile-time + runtime);
 *   - integrazione `getRuntimePhaseSync` con `attachUnitAwareHooks:isActive()`
 *     in condizioni reali di stub (phase "planning" ∈ ACTIVE_PHASES →
 *     forced-by-context Tier F reale, D081/D121);
 *   - counter osservability end-to-end: `discussion_arena_forced_total` +
 *     `gsd_extension_api_detected_total` con cardinalità label 2.
 *
 * Scope del file: 4 test PASS = success criteria del piano S01. Test 4 è il
 * più esteso — verifica che la catena adapter → isActive → recordForced →
 * marker injection funzioni correttamente end-to-end con metrics isolate.
 * I path Tier G (availability-only) e Tier legacy (non-GSDExtensionAPI)
 * sono coperti a livello unit dai 3 test condizionali aggiunti in T02
 * (`tests/hooks-unit-aware.test.ts: T02-A/B/C`). Qui il path legacy
 * è coperto dal test 2 (plain API → null).
 *
 * Helpers locali (NON in fixtures/ per isolare l'integration):
 *   - `makeApiStub()` — ExtensionAPI minimale (no getPhase)
 *   - `createDispatcher()` — replica del pattern di `tests/hooks-unit-aware.test.ts`
 *   - `captureStderrChunksSync()` — cattura stderr sync per NDJSON assertions
 *   - `FORCED` — `ResolveTriggerOutput` con v2 defaults
 */

import "../ts-esm-loader.mjs";

import { test } from "node:test";
import * as assert from "node:assert/strict";

import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";
import {
	getRuntimePhase,
	isGSDExtensionAPI,
	type GSDExtensionAPI,
} from "../../src/gsd-api-adapter.js";
import { attachUnitAwareHooks } from "../../src/hooks-unit-aware.js";
import { getMetrics, resetMetrics } from "../../src/metrics.js";
import type { ResolveTriggerOutput } from "../../trigger-resolver.js";

// ─── Helpers locali (isolamento dall'integration) ────────────────────────────

/**
 * Stub minimale di `ExtensionAPI`: solo `on`. Modella il caso plain (no
 * getPhase). Usato dai test 2-3 per asserire narrowing negativo + null path.
 */
function makeApiStub(): ExtensionAPI {
	return {
		on(_event: string, _handler: unknown): unknown {
			return undefined;
		},
	} as unknown as ExtensionAPI;
}

/** Dispatcher usato dal Test 4. Espone `on` (per registrazione hook) ed `emit`. */
interface Dispatcher {
	handlers: Map<string, ((event: Record<string, unknown>) => unknown)[]>;
	emit: (eventName: string, payload: Record<string, unknown>) => void;
	prompts: string[];
	on: (
		eventName: string,
		handler: (event: Record<string, unknown>) => unknown,
	) => unknown;
}

/**
 * Replica del pattern di `tests/hooks-unit-aware.test.ts:108-138
 * createDispatcher`: registra gli handler via `on()`, dispatcha ogni evento a
 * TUTTI gli handler (comportamento reale del framework), compone i ritorni
 * (`systemPrompt` per `before_agent_start`) e traccia i systemPrompt
 * osservati in `prompts[]`.
 */
function createDispatcher(): Dispatcher {
	const handlers = new Map<
		string,
		((event: Record<string, unknown>) => unknown)[]
	>();
	const prompts: string[] = [];

	function on(
		eventName: string,
		handler: (event: Record<string, unknown>) => unknown,
	): unknown {
		const list = handlers.get(eventName) ?? [];
		list.push(handler);
		handlers.set(eventName, list);
		return {};
	}

	function emit(eventName: string, payload: Record<string, unknown>): void {
		let finalSystemPrompt: string | undefined;
		for (const handler of handlers.get(eventName) ?? []) {
			const res = handler(payload) as
				| { toolNames?: string[]; systemPrompt?: string }
				| undefined;
			if (res && typeof res.systemPrompt === "string") {
				finalSystemPrompt = res.systemPrompt;
			}
		}
		if (eventName === "before_agent_start") {
			prompts.push(finalSystemPrompt ?? (payload.systemPrompt as string));
		}
	}

	return { handlers, emit, prompts, on };
}

/**
 * Cattura le write su `process.stderr` durante l'esecuzione di `fn()`,
 * ripristinando sempre l'originale. Stesso pattern di
 * `tests/hooks-unit-aware.test.ts:64-75 captureStderrChunksSync`. Non usato
 * nei 4 test specificati dal piano (i log NDJSON sono asseriti via
 * `getMetrics().counters` direttamente); mantenuto come helper locale per
 * completezza e per eventuali estensioni future (es. assertion su log
 * `discussionArena.forced`).
 */
function captureStderrChunksSync<T>(fn: () => T): { result: T; lines: string[] } {
	const lines: string[] = [];
	const original = process.stderr.write.bind(process.stderr);
	process.stderr.write = ((chunk: unknown) => {
		lines.push(typeof chunk === "string" ? chunk : String(chunk));
		return true;
	}) as unknown as typeof process.stderr.write;
	try {
		return { result: fn(), lines };
	} finally {
		process.stderr.write = original;
	}
}

/**
 * `resolveTrigger` con `decision=forced` e v2 defaults (S01/M010):
 * `tier='A'`, `capabilities=∅`, `groupEligibility=null`. Replica del
 * pattern in `tests/hooks-unit-aware.test.ts:78-87`.
 */
const FORCED: ResolveTriggerOutput = {
	decision: "forced",
	source: "env",
	warnings: [],
	parseErrors: [],
	tier: "A",
	capabilities: new Set(),
	groupEligibility: null,
};

// ══════════════════════════════════════════════════════════════════════════════
// TEST 1 — happy path: getRuntimePhase con GSDExtensionAPI stub → Phase attesa
// ══════════════════════════════════════════════════════════════════════════════

test("integration: getRuntimePhase con GSDExtensionAPI stub → ritorna la Phase attesa (narrowing runtime confermato)", async () => {
	const api = {
		on: () => undefined,
		getPhase: () => "planning" as const,
	} as unknown as GSDExtensionAPI;

	// (1) type guard narrowing positivo
	assert.equal(isGSDExtensionAPI(api), true);

	// (2) narrowing runtime: se il type guard fallisse, l'accesso a
	// `api.getPhase()` nel blocco `if (isGSDExtensionAPI(api))` non sarebbe
	// nemmeno compilabile (compile-time narrowing). A runtime asseriamo che
	// il valore ritornato corrisponda al literal `Phase` dichiarato.
	if (isGSDExtensionAPI(api)) {
		const phase = await getRuntimePhase(api);
		assert.equal(phase, "planning");
		assert.equal(api.getPhase(), "planning");
	} else {
		assert.fail("isGSDExtensionAPI doveva essere true per stub con getPhase fn");
	}
});

// ══════════════════════════════════════════════════════════════════════════════
// TEST 2 — null su plain ExtensionAPI (no getPhase)
// ══════════════════════════════════════════════════════════════════════════════

test("integration: getRuntimePhase con plain ExtensionAPI stub → null (narrowing negativo + caso api vuoto)", async () => {
	// (a) stub plain con solo `on` (nessun getPhase) — caso reale di
	// test/fixtures/pi-coding-agent-stub.ts
	const apiOn = makeApiStub();
	assert.equal(isGSDExtensionAPI(apiOn), false);
	const phaseOn = await getRuntimePhase(apiOn);
	assert.equal(phaseOn, null);

	// (b) api completamente vuoto `{}` — caso peggiore (zero metodi)
	const apiEmpty = {} as unknown as ExtensionAPI;
	assert.equal(isGSDExtensionAPI(apiEmpty), false);
	const phaseEmpty = await getRuntimePhase(apiEmpty);
	assert.equal(phaseEmpty, null);
});

// ══════════════════════════════════════════════════════════════════════════════
// TEST 3 — isGSDExtensionAPI narrowing: doppia asserzione (true + false)
// ══════════════════════════════════════════════════════════════════════════════

test("integration: isGSDExtensionAPI narrowing — stub con getPhase fn → true; stub plain → false", () => {
	// (a) stub con getPhase fn → type guard true (GSDExtensionAPI)
	const gsdApi = {
		on: () => undefined,
		getPhase: () => "planning" as const,
	} as unknown as GSDExtensionAPI;
	assert.equal(isGSDExtensionAPI(gsdApi), true);

	// (b) stub plain → type guard false (ExtensionAPI)
	const plainApi = makeApiStub();
	assert.equal(isGSDExtensionAPI(plainApi), false);
});

// ══════════════════════════════════════════════════════════════════════════════
// TEST 4 — conditional forcing end-to-end Tier F (forced-by-context)
// ══════════════════════════════════════════════════════════════════════════════

test("integration: conditional forcing Tier F — GSDExtensionAPI con phase='planning' + attachUnitAwareHooks → marker iniettato + counter detected", () => {
	// Reset metriche per isolare lo stato (i counter sono singleton globali
	// e altri test file possono averli popolati in esecuzioni parallele di
	// `npm test`). Il reset azzera SOLO localmente prima di questo test.
	resetMetrics();

	const d = createDispatcher();
	const api = {
		on: d.on,
		getPhase: () => "planning" as const,
	} as unknown as ExtensionAPI;

	const ctx = { cwd: "/tmp/gsd-api-adapter-integration" } as unknown as ExtensionContext;

	// Setup: `attachUnitAwareHooks` con `activeUnitTypes=["planning"]`,
	// marker custom, FORCED. Il cablaggio `isActive()` (T02) ha 3 rami:
	// ramo 1 (GSDExtensionAPI + phase ∈ ACTIVE_PHASES) → forced-by-context
	// (Tier F reale, D081/D121). Con phase="planning" ∈ ACTIVE_PHASES, il
	// ramo 1 viene preso.
	const registered = attachUnitAwareHooks(api, ctx, {
		activeUnitTypes: new Set(["planning"]),
		instructionMarker: "<!-- marker -->",
		instructionText: "Istruzione",
		resolveTrigger: FORCED,
	});
	assert.equal(registered, true, "prima registrazione planning ok");

	// Sequenza eventi reali del framework:
	//   1. unit_start con unitType="planning" → currentUnitType="planning"
	//   2. before_agent_start con systemPrompt vergine (no marker)
	d.emit("unit_start", { unitType: "planning" });
	d.emit("before_agent_start", {
		systemPrompt: "Original.",
		prompt: "p",
		systemPromptOptions: {},
	});

	// ── Assertion (a): marker presente nel systemPrompt finale ──
	assert.equal(
		d.prompts.length,
		1,
		"esattamente UN before_agent_start osservato",
	);
	const finalPrompt = d.prompts[0]!;
	assert.ok(
		finalPrompt.includes("<!-- marker -->"),
		`systemPrompt dopo forcing include il marker; ottenuto: ${finalPrompt}`,
	);
	assert.ok(
		finalPrompt.includes("Istruzione"),
		"systemPrompt include il testo istruzione",
	);
	assert.ok(
		finalPrompt.startsWith("Original."),
		"systemPrompt conserva il prefisso originale",
	);

	// ── Assertion (b): discussion_arena_forced_total{phase=planning} === 1 ──
	const forcedCount = getMetrics().counters["discussion_arena_forced_total"]?.[
		"{phase=planning}"
	];
	assert.equal(
		forcedCount,
		1,
		"discussion_arena_forced_total{phase=planning} deve essere 1 (Tier F reale)",
	);

	// ── Assertion (c): gsd_extension_api_detected_total{outcome=detected} === 1 ──
	const detectedCount = getMetrics().counters["gsd_extension_api_detected_total"]?.[
		"{outcome=detected}"
	];
	assert.equal(
		detectedCount,
		1,
		"gsd_extension_api_detected_total{outcome=detected} deve essere 1 (Tier F/G visibility)",
	);

	// ── Assertion (d): gsd_extension_api_detected_total{outcome=not_detected} === undefined ──
	const notDetectedCount =
		getMetrics().counters["gsd_extension_api_detected_total"]?.[
			"{outcome=not_detected}"
		];
	assert.equal(
		notDetectedCount,
		undefined,
		"gsd_extension_api_detected_total{outcome=not_detected} deve essere undefined (api è GSDExtensionAPI)",
	);
});
