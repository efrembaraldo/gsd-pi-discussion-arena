/**
 * tests/adjust-tool-set-delta.test.ts — I2 delta toolset su adjust_tool_set
 * (S04/T2, M019, capability #1998).
 *
 * Verifica il ramo delta e il ramo legacy di Hook 2 (adjust_tool_set) di
 * `attachUnitAwareHooks` (src/hooks-unit-aware.ts):
 *
 *   delta (host ≥ 1.21.0, `hostFeatures.deltaToolSet === true`):
 *     attivo → ritorna `{ addTools: ["discussion_arena"] }` — NESSUN
 *     array-copy dell'activeToolNames, NESSUN removeTools MAI (D083:
 *     additivo). Il risultato del ramo contiene ESATTAMENTE `addTools`.
 *
 *   legacy (env-assente / host ≤ 1.20, `deltaToolSet === false`):
 *     attivo → ritorna `{ toolNames: [...event.activeToolNames, "discussion_arena"] }`
 *     array-copy invariato byte-per-byte a v0.9.2, SENZA `addTools`.
 *
 *   gating invariato per entrambi i rami: il predicato `isActive()` resta
 *   l'unica porta di ingresso (snapshot `currentUnitType` via unit_start;
 *   AdjustToolSetEvent non espone unitType/phase — gsd-extension-types.d.ts:191-198).
 *
 * Harness: Dispatcher Map+emit+calls (pattern tests/hooks-unit-aware.test.ts,
 * stub plain `{on}` SENZA getPhase → legacy path isActive). A differenza del
 * harness di hooks-unit-aware.test.ts (che compone il merge finale), qui
 * catturiamo il RISULTATO GREZZO del handler del ramo per asserire la shape
 * esatta del ritorno (addTools vs toolNames) senza normalizzazione.
 *
 * Ogni test avvolge l'asserzione in `withGSDVersion` per prevenire leakage di
 * `process.env.GSD_VERSION` tra test (pattern tests/runtime-classifier.test.ts,
 * usato come riferimento, NON come file da modificare). I test legacy usano
 * `withGSDVersion(undefined, ...)`.
 *
 * Puro, nessun I/O subprocess. `resetMetrics()` per isolare il registry
 * metrico singleton (pattern metrics.test.ts / hooks-unit-aware.test.ts).
 */

import { beforeEach, test } from "node:test";
import * as assert from "node:assert/strict";
import { attachUnitAwareHooks } from "../src/hooks-unit-aware.js";
import { PLANNING_INSTRUCTION_MARKER } from "../src/markers.js";
import { getMetrics, resetMetrics } from "../src/metrics.js";
import type { ResolveTriggerOutput } from "../trigger-resolver.js";

beforeEach(() => {
	resetMetrics();
});

/** Setta/rimuove `process.env.GSD_VERSION` per la durata di `fn` e ripristina. */
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
	tier: "A",
	capabilities: new Set(),
	groupEligibility: null,
};

const PLANNING_INSTRUCTION = "Usa discussion_arena prima di decidere il piano";
const UNIT_AWARE_TOOL = "discussion_arena";

type Handler = (event: Record<string, unknown>) => unknown;

/**
 * Dispatcher minimale che inoltra ogni evento a TUTTI gli handler registrati
 * (come il framework) e cattura il RISULTATO GREZZO dell'ultimo handler
 * `adjust_tool_set` (nessuna composizione/merge): serve ad asserire la shape
 * esatta del ritorno del ramo (addTools vs toolNames) — il punto del delta.
 */
function createRawDispatcher(): {
	handlers: Map<string, Handler[]>;
	emit: (eventName: string, payload: Record<string, unknown>) => void;
	lastAdjustRaw: unknown;
} {
	const handlers = new Map<string, Handler[]>();
	let lastAdjustRaw: unknown;

	function emit(eventName: string, payload: Record<string, unknown>): void {
		let res: unknown;
		for (const handler of handlers.get(eventName) ?? []) {
			res = handler(payload);
		}
		if (eventName === "adjust_tool_set") {
			lastAdjustRaw = res;
		}
	}

	return { handlers, emit, get lastAdjustRaw() { return lastAdjustRaw; } };
}

const ctx = { cwd: "/tmp/adjust-tool-set-delta" };

// ─── Ramo delta (host ≥ 1.21.0) ───────────────────────────────────────────────

test("delta (1.21.0): adjust_tool_set attivo ritorna {addTools:[\"discussion_arena\"]} senza toolNames/removeTools", async () => {
	await withGSDVersion("1.21.0", () => {
		const d = createRawDispatcher();
		const api = { on: (evt: string, h: Handler) => {
			const list = d.handlers.get(evt) ?? [];
			list.push(h);
			d.handlers.set(evt, list);
			return {};
		} };
		attachUnitAwareHooks(api as never, ctx as never, {
			activeUnitTypes: new Set(["planning"]),
			instructionMarker: PLANNING_INSTRUCTION_MARKER,
			instructionText: PLANNING_INSTRUCTION,
			resolveTrigger: FORCED,
		});

		d.emit("unit_start", { unitType: "planning" });
		const chunks = captureStderrChunksSync(() => {
			d.emit("adjust_tool_set", { activeToolNames: ["t1", "t2"] });
		});

		// Shape esatta del ramo delta: SOLO addTools, nessun array-copy,
		// nessun removeTools (D083: additivo).
		assert.deepEqual(
			d.lastAdjustRaw,
			{ addTools: [UNIT_AWARE_TOOL] },
			"ramo delta: risultato esattamente {addTools:[discussion_arena]}",
		);
		const raw = d.lastAdjustRaw as { addTools?: unknown; toolNames?: unknown; removeTools?: unknown };
		assert.equal(raw.toolNames, undefined, "ramo delta: nessun toolNames (no array-copy)");
		assert.equal(raw.removeTools, undefined, "ramo delta: nessun removeTools mai (D083)");

		// Log strutturato dichiarativo di selezione del ramo delta (R3/D160).
		const deltaLog = chunks.find((c) => c.includes("discussionArena.toolsetDelta"));
		assert.ok(deltaLog, "evento discussionArena.toolsetDelta emesso sul ramo delta");
		const parsed = JSON.parse(deltaLog!);
		assert.equal(parsed.event, "discussionArena.toolsetDelta");
		assert.equal(parsed.toolName, UNIT_AWARE_TOOL);
	});
});

test("delta (1.21.0): nessuna aggiunta quando unit fuori dai gruppi attivi (gating isActive invariato)", async () => {
	await withGSDVersion("1.21.0", () => {
		const d = createRawDispatcher();
		const api = { on: (evt: string, h: Handler) => {
			const list = d.handlers.get(evt) ?? [];
			list.push(h);
			d.handlers.set(evt, list);
			return {};
		} };
		attachUnitAwareHooks(api as never, ctx as never, {
			activeUnitTypes: new Set(["planning"]),
			instructionMarker: PLANNING_INSTRUCTION_MARKER,
			instructionText: PLANNING_INSTRUCTION,
			resolveTrigger: FORCED,
		});

		d.emit("unit_start", { unitType: "executing" });
		d.emit("adjust_tool_set", { activeToolNames: ["t1"] });

		assert.equal(
			d.lastAdjustRaw,
			undefined,
			"ramo delta: gating isActive=false → nessun ritorno dal handler",
		);
	});
});

// ─── Ramo legacy (env-assente / host ≤ 1.20) ─────────────────────────────────

test("legacy env-assente (GSD_VERSION undefined): risultato {toolNames:[...activeToolNames, discussion_arena]} senza addTools", async () => {
	await withGSDVersion(undefined, () => {
		const d = createRawDispatcher();
		const api = { on: (evt: string, h: Handler) => {
			const list = d.handlers.get(evt) ?? [];
			list.push(h);
			d.handlers.set(evt, list);
			return {};
		} };
		attachUnitAwareHooks(api as never, ctx as never, {
			activeUnitTypes: new Set(["planning"]),
			instructionMarker: PLANNING_INSTRUCTION_MARKER,
			instructionText: PLANNING_INSTRUCTION,
			resolveTrigger: FORCED,
		});

		d.emit("unit_start", { unitType: "planning" });
		const chunks = captureStderrChunksSync(() => {
			d.emit("adjust_tool_set", { activeToolNames: ["t1", "t2"] });
		});

		// Shape esatta del ramo legacy: array-copy dei tool esistenti + push
		// guarded di discussion_arena in coda (byte-per-byte v0.9.2).
		assert.deepEqual(
			d.lastAdjustRaw,
			{ toolNames: ["t1", "t2", UNIT_AWARE_TOOL] },
			"ramo legacy: toolNames array-copy con discussion_arena in coda",
		);
		const raw = d.lastAdjustRaw as { addTools?: unknown };
		assert.equal(raw.addTools, undefined, "ramo legacy: nessun addTools");
		// Nessun log delta su env-assente (ramo delta morto).
		assert.equal(
			chunks.filter((c) => c.includes("discussionArena.toolsetDelta")).length,
			0,
			"env-assente: nessun log discussionArena.toolsetDelta",
		);
	});
});

test("legacy host 1.20.1 (< soglia 1.21.0): risultato {toolNames:[...activeToolNames, discussion_arena]} senza addTools", async () => {
	await withGSDVersion("1.20.1", () => {
		const d = createRawDispatcher();
		const api = { on: (evt: string, h: Handler) => {
			const list = d.handlers.get(evt) ?? [];
			list.push(h);
			d.handlers.set(evt, list);
			return {};
		} };
		attachUnitAwareHooks(api as never, ctx as never, {
			activeUnitTypes: new Set(["planning"]),
			instructionMarker: PLANNING_INSTRUCTION_MARKER,
			instructionText: PLANNING_INSTRUCTION,
			resolveTrigger: FORCED,
		});

		d.emit("unit_start", { unitType: "planning" });
		d.emit("adjust_tool_set", { activeToolNames: ["t1"] });

		assert.deepEqual(
			d.lastAdjustRaw,
			{ toolNames: ["t1", UNIT_AWARE_TOOL] },
			"host 1.20.1: ramo legacy array-copy invariato",
		);
		const raw = d.lastAdjustRaw as { addTools?: unknown };
		assert.equal(raw.addTools, undefined, "host 1.20.1: nessun addTools");
	});
});

test("legacy env-assente: nessuna aggiunta quando unit fuori dai gruppi attivi (gating isActive invariato)", async () => {
	await withGSDVersion(undefined, () => {
		const d = createRawDispatcher();
		const api = { on: (evt: string, h: Handler) => {
			const list = d.handlers.get(evt) ?? [];
			list.push(h);
			d.handlers.set(evt, list);
			return {};
		} };
		attachUnitAwareHooks(api as never, ctx as never, {
			activeUnitTypes: new Set(["planning"]),
			instructionMarker: PLANNING_INSTRUCTION_MARKER,
			instructionText: PLANNING_INSTRUCTION,
			resolveTrigger: FORCED,
		});

		d.emit("unit_start", { unitType: "executing" });
		d.emit("adjust_tool_set", { activeToolNames: ["t1"] });

		assert.equal(
			d.lastAdjustRaw,
			undefined,
			"ramo legacy: gating isActive=false → nessun ritorno dal handler",
		);
	});
});