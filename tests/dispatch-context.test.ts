/**
 * Unit tests for src/hooks-unit-aware.ts — I1 dispatch context nativo su
 * before_agent_start (S04/T1, M019, R066/R1).
 *
 * Contratto verificato:
 *   - Ramo nativo (host ≥ 1.21.0, `hostFeatures.dispatchContext === true`,
 *     `event.unitType !== undefined`): il forcing del tool discussion_arena
 *     in Hook 3 si decide NATIVAMENTE sui campi dell'evento
 *     (`BeforeAgentStartEvent.unitType` — tipi vendored
 *     extension-upstream-types.d.ts:506-519, dispatch context #1997), senza
 *     dipendere da `unit_start` mai emesso a runtime (R1: precedenza
 *     nativo > snapshot). La label del counter `forced` deriva da
 *     `resolvePhaseLabel(event.unitType ?? currentUnitType)`.
 *   - Fallback esplicito al ramo legacy (snapshot) quando `event.unitType`
 *     è assente (turno ordinario user-initiated) oppure
 *     `dispatchContext === false` (env-assente / host ≤ 1.20): output
 *     byte-per-byte identico a v0.9.2.
 *   - Campo additivo opzionale `hostFeatures` su UnitAwareHooksOptions
 *     (D084): default env-computato via
 *     `computeHostFeatures(parseSemver(process.env.GSD_VERSION))`; l'opzione
 *     esplicita vince sul default (iniezione senza env possibile).
 *
 * Harness: Dispatcher Map+emit+calls (pattern tests/hooks-unit-aware.test.ts,
 * stub plain `{on}` SENZA getPhase salvo test espliciti su GSDExtensionAPI).
 * Ogni test avvolge l'asserzione in `withGSDVersion` per prevenire leakage di
 * `process.env.GSD_VERSION` tra test (pattern tests/runtime-classifier.test.ts,
 * usato come riferimento, NON come file da modificare).
 *
 * Puro, nessun I/O subprocess. `resetMetrics()` per isolare il registry
 * metrico singleton (pattern metrics.test.ts / hooks-unit-aware.test.ts).
 */

import { beforeEach, test } from "node:test";
import * as assert from "node:assert/strict";
import { attachUnitAwareHooks } from "../src/hooks-unit-aware.js";
import { PLANNING_INSTRUCTION_MARKER } from "../src/markers.js";
import { ACTIVE_UNIT_TYPES } from "../src/phase-mapping.js";
import { getMetrics, resetMetrics } from "../src/metrics.js";
import type { HostFeatures } from "../src/runtime-classifier.js";
import type { ResolveTriggerOutput } from "../trigger-resolver.js";

// Isolamento del registry metrico singleton (pattern identico a
// hooks-unit-aware.test.ts).
beforeEach(() => {
	resetMetrics();
});

/**
 * Setta `process.env.GSD_VERSION` per la durata di `fn` e ripristina il
 * valore precedente (anche se `fn` lancia). Salva lo stato anche se
 * `GSD_VERSION` non era definita all'ingresso. Pattern copiato da
 * tests/runtime-classifier.test.ts (riferimento, non modificato).
 */
async function withGSDVersion<T>(
	value: string | undefined,
	fn: () => T | Promise<T>,
): Promise<T> {
	const prev = process.env.GSD_VERSION;
	if (value === undefined) delete process.env.GSD_VERSION;
	else process.env.GSD_VERSION = value;
	try {
		return await fn();
	} finally {
		if (prev === undefined) delete process.env.GSD_VERSION;
		else process.env.GSD_VERSION = prev;
	}
}

/** Variante sincrona di cattura stderr (emitStructuredLog è sincrono). */
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

const FORCED: ResolveTriggerOutput = {
	decision: "forced",
	source: "env",
	warnings: [],
	parseErrors: [],
	// v2 defaults (S01/M010): stessi campi richiesti di ResolveTriggerOutput v2.
	tier: "A",
	capabilities: new Set(),
	groupEligibility: null,
};

const PLANNING_INSTRUCTION = "Usa discussion_arena prima di decidere il piano";

interface Dispatcher {
	handlers: Map<string, ((event: Record<string, unknown>) => unknown)[]>;
	emit: (eventName: string, payload: Record<string, unknown>) => void;
	/** Nomi degli eventi emessi, in ordine (per asserire MAI unit_start). */
	emitted: string[];
	prompts: string[];
}

/** Stub di api.on() che accoda gli handler per evento (come il framework). */
function makeApi(
	handlers: Dispatcher["handlers"],
): (eventName: string, handler: (event: Record<string, unknown>) => unknown) => unknown {
	return (eventName: string, handler: (event: Record<string, unknown>) => unknown) => {
		const list = handlers.get(eventName) ?? [];
		list.push(handler);
		handlers.set(eventName, list);
		return {};
	};
}

/** Registra un dispatcher che inoltra ogni evento a TUTTI gli handler (come il framework). */
function createDispatcher(): Dispatcher {
	const handlers = new Map<
		string,
		((event: Record<string, unknown>) => unknown)[]
	>();
	const emitted: string[] = [];
	const prompts: string[] = [];

	function emit(eventName: string, payload: Record<string, unknown>): void {
		emitted.push(eventName);
		let finalSystemPrompt: string | undefined;
		for (const handler of handlers.get(eventName) ?? []) {
			const res = handler(payload) as { systemPrompt?: string } | undefined;
			if (res && typeof res.systemPrompt === "string") {
				finalSystemPrompt = res.systemPrompt;
			}
		}
		if (eventName === "before_agent_start") {
			prompts.push(finalSystemPrompt ?? (payload.systemPrompt as string));
		}
	}
	return { handlers, emit, emitted, prompts };
}

/** Evento before_agent_start canonico (campi vendored:506-519). */
function basEvent(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		prompt: "p",
		systemPrompt: "Original.",
		systemPromptOptions: {},
		...overrides,
	};
}

const ctx = { cwd: "/tmp/dispatch-context" };

function forcedCount(phase: string): number | undefined {
	return getMetrics().counters["discussion_arena_forced_total"]?.[
		`{phase=${phase}}`
	];
}

// ─── R1: forcing nativo senza unit_start (prima prova, rischio più alto) ─────

test("I1 nativo (R1): before_agent_start {unitType:plan-slice} senza MAI unit_start → marker iniettato + forced{phase=planning}=1", async () => {
	await withGSDVersion("1.21.0", () => {
		const d = createDispatcher();
		// Plain stub {on} SENZA getPhase → isActive legacy sarebbe false
		// (currentUnitType resta "unknown" senza unit_start). Senza ramo
		// nativo questo test FALLISCE: è la prova di R1.
		const api = { on: makeApi(d.handlers) };
		attachUnitAwareHooks(api as never, ctx as never, {
			// Wiring di produzione (hooks-planning.ts): il set contiene i MEMBRI del
			// gruppo planning (es. "plan-slice"), non la chiave di gruppo.
			activeUnitTypes: ACTIVE_UNIT_TYPES.planning,
			instructionMarker: PLANNING_INSTRUCTION_MARKER,
			instructionText: PLANNING_INSTRUCTION,
			resolveTrigger: FORCED,
		});

		// SOLO before_agent_start — MAI unit_start.
		d.emit("before_agent_start", basEvent({ unitType: "plan-slice" }));

		// (a) marker + istruzione iniettati nel systemPrompt.
		const prompt = d.prompts[0] ?? "";
		const markerCount = (
			prompt.match(/<!-- gsd-pi-discussion-arena-planning-instruction -->/g) ?? []
		).length;
		assert.equal(markerCount, 1, "marker presente esattamente una volta");
		assert.ok(
			prompt.includes(PLANNING_INSTRUCTION),
			"testo istruzione presente nel prompt",
		);
		assert.ok(
			prompt.startsWith("Original."),
			"istruzione appesa al systemPrompt originale",
		);

		// (b) counter forced con label derivata dall'unitType NATIVO
		// (resolvePhaseLabel("plan-slice") = "planning").
		assert.equal(
			forcedCount("planning"),
			1,
			"forced{phase=planning} = 1 dal forcing nativo",
		);

		// (c) unit_start NON mai emesso dal harness (nessuna entry per
		// "unit_start" nel registro degli eventi emessi).
		assert.ok(
			!d.emitted.includes("unit_start"),
			"unit_start MAI emesso nel test nativo",
		);
	});
});

test("I1 nativo (R1): log NDJSON discussionArena.forced con phase dal contesto nativo", async () => {
	await withGSDVersion("1.21.0", () => {
		const d = createDispatcher();
		const api = { on: makeApi(d.handlers) };
		attachUnitAwareHooks(api as never, ctx as never, {
			// Wiring di produzione (hooks-planning.ts): il set contiene i MEMBRI del
			// gruppo planning (es. "plan-slice"), non la chiave di gruppo.
			activeUnitTypes: ACTIVE_UNIT_TYPES.planning,
			instructionMarker: PLANNING_INSTRUCTION_MARKER,
			instructionText: PLANNING_INSTRUCTION,
			resolveTrigger: FORCED,
		});

		const chunks = captureStderrChunksSync(() => {
			d.emit("before_agent_start", basEvent({ unitType: "plan-slice" }));
		});

		const forcedLog = chunks.find((c) => c.includes("discussionArena.forced"));
		assert.ok(forcedLog, "evento discussionArena.forced emesso su stderr");
		const parsed = JSON.parse(forcedLog!) as {
			event: string;
			level: string;
			tier: string;
			phase: string;
		};
		assert.equal(parsed.event, "discussionArena.forced");
		assert.equal(parsed.level, "info");
		assert.equal(parsed.tier, "F");
		assert.equal(parsed.phase, "planning");
	});
});

test("I1 nativo (R1): precedenza nativo > snapshot — unit_start stantio fuori gruppo non vince sull'evento", async () => {
	await withGSDVersion("1.21.0", () => {
		const d = createDispatcher();
		const api = { on: makeApi(d.handlers) };
		attachUnitAwareHooks(api as never, ctx as never, {
			// Wiring di produzione (hooks-planning.ts): il set contiene i MEMBRI del
			// gruppo planning (es. "plan-slice"), non la chiave di gruppo.
			activeUnitTypes: ACTIVE_UNIT_TYPES.planning,
			instructionMarker: PLANNING_INSTRUCTION_MARKER,
			instructionText: PLANNING_INSTRUCTION,
			resolveTrigger: FORCED,
		});

		// Snapshot STANTIO/FUORI gruppo: "executing" ∉ activeUnitTypes
		// ["planning"]. Il ramo legacy con questo snapshot NON forzerebbe.
		d.emit("unit_start", { unitType: "executing" });

		// L'evento nativo porta l'unitType CORRENTE: deve vincere sullo
		// snapshot (precedenza nativo > snapshot, R1).
		d.emit("before_agent_start", basEvent({ unitType: "plan-slice" }));

		assert.ok(
			(d.prompts[0] ?? "").includes(PLANNING_INSTRUCTION_MARKER),
			"unitType nativo dell'evento vince sullo snapshot stantio",
		);
		assert.equal(
			forcedCount("planning"),
			1,
			"label counter dalla fonte nativa (planning), non dallo snapshot",
		);
	});
});

// ─── Controparte e fallback legacy (R1) ──────────────────────────────────────

test("controparte: before_agent_start SENZA unitType (user-initiated) su 1.21.0 → nessuna iniezione spuria (fallback isActive legacy)", async () => {
	await withGSDVersion("1.21.0", () => {
		const d = createDispatcher();
		const api = { on: makeApi(d.handlers) };
		attachUnitAwareHooks(api as never, ctx as never, {
			// Wiring di produzione (hooks-planning.ts): il set contiene i MEMBRI del
			// gruppo planning (es. "plan-slice"), non la chiave di gruppo.
			activeUnitTypes: ACTIVE_UNIT_TYPES.planning,
			instructionMarker: PLANNING_INSTRUCTION_MARKER,
			instructionText: PLANNING_INSTRUCTION,
			resolveTrigger: FORCED,
		});

		// Nessun unit_start, nessun unitType nell'evento: snapshot resta
		// "unknown" → legacy isActive() false → NESSUNA iniezione spuria.
		d.emit("before_agent_start", basEvent());

		assert.ok(
			!(d.prompts[0] ?? "").includes(PLANNING_INSTRUCTION_MARKER),
			"nessun marker per turno ordinario senza unitType",
		);
		assert.equal(
			getMetrics().counters["discussion_arena_forced_total"],
			undefined,
			"forced counter non incrementato per turno ordinario",
		);
	});
});

test("controparte: unitType fuori dai gruppi attivi (quick-task) su 1.21.0 → nessuna iniezione", async () => {
	await withGSDVersion("1.21.0", () => {
		const d = createDispatcher();
		const api = { on: makeApi(d.handlers) };
		attachUnitAwareHooks(api as never, ctx as never, {
			// Wiring di produzione (hooks-planning.ts): il set contiene i MEMBRI del
			// gruppo planning (es. "plan-slice"), non la chiave di gruppo.
			activeUnitTypes: ACTIVE_UNIT_TYPES.planning,
			instructionMarker: PLANNING_INSTRUCTION_MARKER,
			instructionText: PLANNING_INSTRUCTION,
			resolveTrigger: FORCED,
		});

		d.emit("before_agent_start", basEvent({ unitType: "quick-task" }));

		assert.ok(
			!(d.prompts[0] ?? "").includes(PLANNING_INSTRUCTION_MARKER),
			"unitType nativo fuori dai gruppi attivi: nessun forcing",
		);
		assert.equal(
			getMetrics().counters["discussion_arena_forced_total"],
			undefined,
			"forced counter non incrementato per unitType fuori gruppo",
		);
	});
});

// ─── Env-assente / host ≤ 1.20: ramo nativo morto, output legacy ────────────

test("env-assente (GSD_VERSION undefined): ramo nativo morto, output legacy identico a v0.9.2 (nessun marker per unitType nativo)", async () => {
	await withGSDVersion(undefined, () => {
		const d = createDispatcher();
		const api = { on: makeApi(d.handlers) };
		attachUnitAwareHooks(api as never, ctx as never, {
			// Wiring di produzione (hooks-planning.ts): il set contiene i MEMBRI del
			// gruppo planning (es. "plan-slice"), non la chiave di gruppo.
			activeUnitTypes: ACTIVE_UNIT_TYPES.planning,
			instructionMarker: PLANNING_INSTRUCTION_MARKER,
			instructionText: PLANNING_INSTRUCTION,
			resolveTrigger: FORCED,
		});

		// dispatchContext=false via default compute (isFeatureHost(null)=false)
		// → anche CON unitType nell'evento il ramo nativo è morto e il ramo
		// legacy usa lo snapshot "unknown" → false → nessuna iniezione.
		const chunks = captureStderrChunksSync(() => {
			d.emit("before_agent_start", basEvent({ unitType: "plan-slice" }));
		});

		assert.ok(
			!(d.prompts[0] ?? "").includes(PLANNING_INSTRUCTION_MARKER),
			"env-assente: nessun marker (output legacy byte-per-byte)",
		);
		assert.equal(
			getMetrics().counters["discussion_arena_forced_total"],
			undefined,
			"env-assente: nessun counter forced",
		);
		assert.equal(
			chunks.filter((c) => c.includes("discussionArena.forced")).length,
			0,
			"env-assente: nessun log discussionArena.forced",
		);
	});
});

test("host 1.20.1 (< soglia 1.21.0): dispatchContext=false → ramo nativo morto, nessuna iniezione", async () => {
	await withGSDVersion("1.20.1", () => {
		const d = createDispatcher();
		const api = { on: makeApi(d.handlers) };
		attachUnitAwareHooks(api as never, ctx as never, {
			// Wiring di produzione (hooks-planning.ts): il set contiene i MEMBRI del
			// gruppo planning (es. "plan-slice"), non la chiave di gruppo.
			activeUnitTypes: ACTIVE_UNIT_TYPES.planning,
			instructionMarker: PLANNING_INSTRUCTION_MARKER,
			instructionText: PLANNING_INSTRUCTION,
			resolveTrigger: FORCED,
		});

		d.emit("before_agent_start", basEvent({ unitType: "plan-slice" }));

		assert.ok(
			!(d.prompts[0] ?? "").includes(PLANNING_INSTRUCTION_MARKER),
			"host sotto soglia: nessun forcing nativo",
		);
		assert.equal(
			getMetrics().counters["discussion_arena_forced_total"],
			undefined,
			"host sotto soglia: nessun counter forced",
		);
	});
});

// ─── Campo additivo opzionale hostFeatures (D084) ────────────────────────────

test("opzione hostFeatures esplicita: dispatchContext=true inietta anche senza GSD_VERSION (default env-computato bypassato)", async () => {
	await withGSDVersion(undefined, () => {
		const d = createDispatcher();
		const api = { on: makeApi(d.handlers) };
		const explicitFeatures: HostFeatures = Object.freeze({
			dispatchContext: true,
			deltaToolSet: false,
			phaseChangeEvent: false,
		});
		attachUnitAwareHooks(api as never, ctx as never, {
			// Wiring di produzione (hooks-planning.ts): il set contiene i MEMBRI del
			// gruppo planning (es. "plan-slice"), non la chiave di gruppo.
			activeUnitTypes: ACTIVE_UNIT_TYPES.planning,
			instructionMarker: PLANNING_INSTRUCTION_MARKER,
			instructionText: PLANNING_INSTRUCTION,
			resolveTrigger: FORCED,
			hostFeatures: explicitFeatures,
		});

		d.emit("before_agent_start", basEvent({ unitType: "plan-slice" }));

		assert.ok(
			(d.prompts[0] ?? "").includes(PLANNING_INSTRUCTION_MARKER),
			"opzione esplicita attiva il ramo nativo anche senza env",
		);
		assert.equal(forcedCount("planning"), 1, "counter forced dal ramo nativo esplicito");
	});
});

test("opzione hostFeatures esplicita: dispatchContext=false spegne il ramo nativo anche su 1.21.0", async () => {
	await withGSDVersion("1.21.0", () => {
		const d = createDispatcher();
		const api = { on: makeApi(d.handlers) };
		attachUnitAwareHooks(api as never, ctx as never, {
			// Wiring di produzione (hooks-planning.ts): il set contiene i MEMBRI del
			// gruppo planning (es. "plan-slice"), non la chiave di gruppo.
			activeUnitTypes: ACTIVE_UNIT_TYPES.planning,
			instructionMarker: PLANNING_INSTRUCTION_MARKER,
			instructionText: PLANNING_INSTRUCTION,
			resolveTrigger: FORCED,
			hostFeatures: Object.freeze({
				dispatchContext: false,
				deltaToolSet: false,
				phaseChangeEvent: false,
			}),
		});

		d.emit("before_agent_start", basEvent({ unitType: "plan-slice" }));

		assert.ok(
			!(d.prompts[0] ?? "").includes(PLANNING_INSTRUCTION_MARKER),
			"opzione esplicita false: ramo nativo morto, fallback legacy snapshot",
		);
		assert.equal(
			getMetrics().counters["discussion_arena_forced_total"],
			undefined,
			"nessun counter forced con dispatchContext esplicito false",
		);
	});
});

// ─── Semantica preservata: idempotenza D088 e gating GSDExtensionAPI ─────────

test("retry su prompt già marcato nel ramo nativo: NON incrementa né riloga (D088 preservata)", async () => {
	await withGSDVersion("1.21.0", () => {
		const d = createDispatcher();
		const api = { on: makeApi(d.handlers) };
		attachUnitAwareHooks(api as never, ctx as never, {
			// Wiring di produzione (hooks-planning.ts): il set contiene i MEMBRI del
			// gruppo planning (es. "plan-slice"), non la chiave di gruppo.
			activeUnitTypes: ACTIVE_UNIT_TYPES.planning,
			instructionMarker: PLANNING_INSTRUCTION_MARKER,
			instructionText: PLANNING_INSTRUCTION,
			resolveTrigger: FORCED,
		});

		d.emit("before_agent_start", basEvent({ unitType: "plan-slice" }));
		const afterFirst = forcedCount("planning") ?? 0;

		let secondChunks: string[] = [];
		// Retry: il framework ri-entra con il prompt GIÀ marcato (output 1ª call).
		secondChunks = captureStderrChunksSync(() => {
			d.emit(
				"before_agent_start",
				basEvent({ unitType: "plan-slice", systemPrompt: d.prompts[0] }),
			);
		});
		const afterSecond = forcedCount("planning") ?? 0;

		assert.equal(afterFirst, 1, "prima forzazione conta");
		assert.equal(afterSecond, 1, "retry no-op NON incrementa il counter (D088)");
		assert.equal(
			secondChunks.filter((c) => c.includes("discussionArena.forced")).length,
			0,
			"nessun log NDJSON per il retry no-op",
		);
	});
});

test("GSDExtensionAPI + evento nativo senza unit_start: branch 1 (phase ∈ ACTIVE_PHASES) forza anche con unitType fuori gruppo", async () => {
	await withGSDVersion("1.21.0", () => {
		const d = createDispatcher();
		// Stub GSDExtensionAPI con getPhase() = "planning" ∈ ACTIVE_PHASES →
		// branch 1 del predicato: forced-by-context ignora resolveTrigger.decision
		// e la membership (fonte nativa = phase dell'api, unitType evento
		// fuori gruppo). Nessun unit_start.
		const api = { on: makeApi(d.handlers), getPhase: () => "planning" };
		attachUnitAwareHooks(api as never, ctx as never, {
			// Wiring di produzione (hooks-planning.ts): il set contiene i MEMBRI del
			// gruppo planning (es. "plan-slice"), non la chiave di gruppo.
			activeUnitTypes: ACTIVE_UNIT_TYPES.planning,
			instructionMarker: PLANNING_INSTRUCTION_MARKER,
			instructionText: PLANNING_INSTRUCTION,
			resolveTrigger: FORCED,
		});

		d.emit("before_agent_start", basEvent({ unitType: "quick-task" }));

		assert.ok(
			(d.prompts[0] ?? "").includes(PLANNING_INSTRUCTION_MARKER),
			"branch 1 (phase ∈ ACTIVE_PHASES) forza senza unit_start",
		);
		// Label dal contesto che ha motivato il forcing: unitType nativo
		// "quick-task" → sentinella "unknown" (D087, cardinalità vincolata).
		assert.equal(
			forcedCount("unknown"),
			1,
			"forced{phase=unknown} per unitType fuori gruppo con forcing da phase api",
		);
		const detected = getMetrics().counters["gsd_extension_api_detected_total"] ?? {};
		assert.equal(
			detected["{outcome=detected}"],
			1,
			"counter gsd_extension_api_detected_total{outcome=detected}=1",
		);
	});
});
