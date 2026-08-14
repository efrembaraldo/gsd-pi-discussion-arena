/**
 * Unit tests for src/hooks-unit-aware.ts — il helper condiviso
 * attachUnitAwareHooks estratto da hooks-planning (S08/M008, T03).
 *
 * Testa direttamente il helper con configurazioni diverse (planning vs
 * research-decision):
 *   - registrazione idempotente per-marker sullo stesso api;
 *   - state machine unit_start → predicato attivo (isActive) per decisione
 *     forced e per l'unit_type ascoltato (incluse le transizioni);
 *   - adjust_tool_set: aggiunge discussion_arena solo quando unit_type attivo
 *     && decision forced, conservando i tool esistenti;
 *   - before_agent_start: appende istruzione marker-based in modo idempotente
 *     (nessuna duplicazione su chiamate ripetute);
 *   - snapshot/differenziale: planning vs research-decision producono PROMT
 *     con marker/istruzione diversi ed isolati per unit_type.
 *
 * Puro, nessun I/O subprocess: usa uno stub di ExtensionAPI che dispatcha ogni
 * evento a TUTTI gli handler registrati (comportamento reale dell'api) e
 * compone i ritorni come il framework, esattamente come il harness di
 * tests/integration/hooks-coexist.test.ts.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { attachUnitAwareHooks } from "../src/hooks-unit-aware.js";
import {
	PLANNING_INSTRUCTION_MARKER,
	RESEARCH_INSTRUCTION_MARKER,
} from "../src/markers.js";
import type { ResolveTriggerOutput } from "../trigger-resolver.js";

const FORCED: ResolveTriggerOutput = {
	decision: "forced",
	source: "env",
	warnings: [],
	parseErrors: [],
};

const AVAILABLE_ONLY: ResolveTriggerOutput = {
	decision: "available-only",
	source: "fallback",
	warnings: [],
	parseErrors: [],
};

const PLANNING_INSTRUCTION = "Usa discussion_arena prima di decidere il piano";
const RESEARCH_INSTRUCTION =
	"Usa discussion_arena prima di decidere l'approccio di ricerca";

const UNIT_AWARE_TOOL = "discussion_arena";

interface Dispatcher {
	handlers: Map<string, ((event: Record<string, unknown>) => unknown)[]>;
	emit: (eventName: string, payload: Record<string, unknown>) => void;
	tools: { lastTools: string[]; lastChanged: boolean };
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
	const tools = { lastTools: [] as string[], lastChanged: false };
	const prompts: string[] = [];

	function emit(eventName: string, payload: Record<string, unknown>): void {
		let finalTools: string[] | undefined;
		let finalSystemPrompt: string | undefined;
		for (const handler of handlers.get(eventName) ?? []) {
			const res = handler(payload) as
				| { toolNames?: string[]; systemPrompt?: string }
				| undefined;
			if (res && Array.isArray(res.toolNames)) finalTools = res.toolNames;
			if (res && typeof res.systemPrompt === "string") {
				finalSystemPrompt = res.systemPrompt;
			}
		}
		if (eventName === "adjust_tool_set") {
			tools.lastTools = finalTools ?? [...(payload.activeToolNames as string[])];
			tools.lastChanged = finalTools !== undefined;
		}
		if (eventName === "before_agent_start") {
			prompts.push(finalSystemPrompt ?? (payload.systemPrompt as string));
		}
	}
	return { handlers, emit, tools, prompts };
}

const ctx = { cwd: "/tmp/unit-aware" };

test("registration idempotenza: marker dello stesso api registra una sola volta, marker diversi coesistono", () => {
	const d = createDispatcher();
	const api = { on: makeApi(d.handlers) };
	const ctxStub = {} as never;

	const firstPlanning = attachUnitAwareHooks(api as never, ctxStub, {
		activeUnitTypes: new Set(["planning"]),
		instructionMarker: PLANNING_INSTRUCTION_MARKER,
		instructionText: PLANNING_INSTRUCTION,
		resolveTrigger: FORCED,
	});
	const secondPlanning = attachUnitAwareHooks(api as never, ctxStub, {
		activeUnitTypes: new Set(["planning"]),
		instructionMarker: PLANNING_INSTRUCTION_MARKER,
		instructionText: PLANNING_INSTRUCTION,
		resolveTrigger: FORCED,
	});
	const research = attachUnitAwareHooks(api as never, ctxStub, {
		activeUnitTypes: new Set(["research-decision"]),
		instructionMarker: RESEARCH_INSTRUCTION_MARKER,
		instructionText: RESEARCH_INSTRUCTION,
		resolveTrigger: FORCED,
	});

	assert.equal(firstPlanning, true, "prima registrazione planning ok");
	assert.equal(
		secondPlanning,
		false,
		"ri-registrazione stesso marker: no-op idempotente",
	);
	assert.equal(
		research,
		true,
		"marker research diverso: registra anche sul solito api",
	);
	// La ri-registrazione planning ha no-op → i handler rimangono 2 (planning+research).
	const adjustHandlers = (d.handlers.get("adjust_tool_set") ?? []).length;
	assert.equal(
		adjustHandlers,
		2,
		"esattamente 2 handler adjust_tool_set (planning+research, NON duplicato)",
	);
});

test("adjust_tool_set: aggiunge discussion_arena quando unit_type attivo e forced, conservando i tool esistenti", () => {
	const d = createDispatcher();
	const api = { on: makeApi(d.handlers) };
	attachUnitAwareHooks(api as never, ctx as never, {
		activeUnitTypes: new Set(["research"]),
		instructionMarker: RESEARCH_INSTRUCTION_MARKER,
		instructionText: RESEARCH_INSTRUCTION,
		resolveTrigger: FORCED,
	});

	d.emit("unit_start", { unitType: "research" });
	d.emit("adjust_tool_set", { activeToolNames: ["t1", "t2"] });

	assert.deepEqual(
		d.tools.lastTools,
		["t1", "t2", UNIT_AWARE_TOOL],
		"discussion_arena aggiunto in coda senza rimuovere t1/t2",
	);
	assert.ok(d.tools.lastChanged, "hook ha modificato il toolset");
});

test("adjust_tool_set: nessuna iniezione fuori dall'unit_type attivo (state machine) anche se forced", () => {
	const d = createDispatcher();
	const api = { on: makeApi(d.handlers) };
	attachUnitAwareHooks(api as never, ctx as never, {
		activeUnitTypes: new Set(["research"]),
		instructionMarker: RESEARCH_INSTRUCTION_MARKER,
		instructionText: RESEARCH_INSTRUCTION,
		resolveTrigger: FORCED,
	});

	d.emit("unit_start", { unitType: "executing" });
	d.emit("adjust_tool_set", { activeToolNames: ["t1"] });

	assert.equal(
		d.tools.lastChanged,
		false,
		"nessun hook agisce su unit_type estraneo",
	);
	assert.deepEqual(
		d.tools.lastTools,
		["t1"],
		"toolset invariato fuori dall'unit_type attivo",
	);
});

test("adjust_tool_set: state machine transiziona — dopo switch a unit_type attivo inietta", () => {
	const d = createDispatcher();
	const api = { on: makeApi(d.handlers) };
	attachUnitAwareHooks(api as never, ctx as never, {
		activeUnitTypes: new Set(["research"]),
		instructionMarker: RESEARCH_INSTRUCTION_MARKER,
		instructionText: RESEARCH_INSTRUCTION,
		resolveTrigger: FORCED,
	});

	// Prima in unit estraneo, poi passa a quello attivo: la closure traccia il
	// currentUnitType proveniente da unit_start.
	d.emit("unit_start", { unitType: "executing" });
	d.emit("adjust_tool_set", { activeToolNames: ["t1"] });
	d.emit("unit_start", { unitType: "research" });
	d.emit("adjust_tool_set", { activeToolNames: ["t2"] });

	assert.equal(
		d.tools.lastChanged,
		true,
		"dopo la transizione a research l'hook agisce",
	);
	assert.deepEqual(
		d.tools.lastTools,
		["t2", UNIT_AWARE_TOOL],
		"inietta discussion_arena dopo la transizione di unit_type",
	);
});

test("adjust_tool_set: nessuna iniezione quando decision non è forced", () => {
	const d = createDispatcher();
	const api = { on: makeApi(d.handlers) };
	attachUnitAwareHooks(api as never, ctx as never, {
		activeUnitTypes: new Set(["planning"]),
		instructionMarker: PLANNING_INSTRUCTION_MARKER,
		instructionText: PLANNING_INSTRUCTION,
		resolveTrigger: AVAILABLE_ONLY,
	});

	d.emit("unit_start", { unitType: "planning" });
	d.emit("adjust_tool_set", { activeToolNames: ["t1"] });

	assert.equal(
		d.tools.lastChanged,
		false,
		"available-only: nessuna modifica toolset",
	);
	assert.deepEqual(
		d.tools.lastTools,
		["t1"],
		"toolset invariato con decisione available-only",
	);
});

test("before_agent_start: appende istruzione marker-based una sola volta per unit_type attivo", () => {
	const d = createDispatcher();
	const api = { on: makeApi(d.handlers) };
	attachUnitAwareHooks(api as never, ctx as never, {
		activeUnitTypes: new Set(["research"]),
		instructionMarker: RESEARCH_INSTRUCTION_MARKER,
		instructionText: RESEARCH_INSTRUCTION,
		resolveTrigger: FORCED,
	});

	d.emit("unit_start", { unitType: "research" });
	d.emit("before_agent_start", {
		prompt: "p",
		systemPrompt: "Original.",
		systemPromptOptions: {},
	});
	d.emit("before_agent_start", {
		prompt: "p",
		systemPrompt: d.prompts[0] ?? "Original.",
		systemPromptOptions: {},
	});

	const first = d.prompts[0] ?? "";
	const second = d.prompts[1] ?? "";
	assert.equal(second, first, "chiamate ripetute non duplicano (idempotenza via marker)");
	const markerCount = (
		second.match(/<!-- gsd-pi-discussion-arena-research-instruction -->/g) ??
		[]
	).length;
	assert.equal(markerCount, 1, "marker presente esattamente una volta");
	assert.ok(second.includes("Usa discussion_arena"), "testo istruzione presente nel prompt");
});

test("before_agent_start: nessuna modifica quando decision non è forced", () => {
	const d = createDispatcher();
	const api = { on: makeApi(d.handlers) };
	attachUnitAwareHooks(api as never, ctx as never, {
		activeUnitTypes: new Set(["planning"]),
		instructionMarker: PLANNING_INSTRUCTION_MARKER,
		instructionText: PLANNING_INSTRUCTION,
		resolveTrigger: AVAILABLE_ONLY,
	});

	d.emit("unit_start", { unitType: "planning" });
	d.emit("before_agent_start", {
		prompt: "p",
		systemPrompt: "Original.",
		systemPromptOptions: {},
	});

	assert.ok(
		!d.prompts[0]?.includes(PLANNING_INSTRUCTION_MARKER),
		"nessun marker nel prompt quando available-only",
	);
});

test("snapshot: planning vs research-decision — toolset e marker distinti e isolati per unit_type", () => {
	// Registra le due config sullo stesso api (come activate() in index.ts).
	const d = createDispatcher();
	const api = { on: makeApi(d.handlers) };
	const ctxStub = {} as never;

	attachUnitAwareHooks(api as never, ctxStub, {
		activeUnitTypes: new Set(["planning"]),
		instructionMarker: PLANNING_INSTRUCTION_MARKER,
		instructionText: PLANNING_INSTRUCTION,
		resolveTrigger: FORCED,
	});
	attachUnitAwareHooks(api as never, ctxStub, {
		activeUnitTypes: new Set(["research-decision"]),
		instructionMarker: RESEARCH_INSTRUCTION_MARKER,
		instructionText: RESEARCH_INSTRUCTION,
		resolveTrigger: FORCED,
	});

	// Snapshot planning (era con base ["x"]).
	d.emit("unit_start", { unitType: "planning" });
	d.emit("adjust_tool_set", { activeToolNames: ["x"] });
	d.emit("before_agent_start", {
		prompt: "p",
		systemPrompt: "P.",
		systemPromptOptions: {},
	});
	const planTools = [...d.tools.lastTools];
	const planPrompt = d.prompts[0] ?? "";

	// Snapshot research-decision (era con base ["a"]).
	d.emit("unit_start", { unitType: "research-decision" });
	d.emit("adjust_tool_set", { activeToolNames: ["a"] });
	d.emit("before_agent_start", {
		prompt: "p",
		systemPrompt: "R.",
		systemPromptOptions: {},
	});
	const resTools = [...d.tools.lastTools];
	const resPrompt = d.prompts[1] ?? "";

	// toolset nettamente distinguibili per basi diverse + marker isolati.
	assert.deepEqual(planTools, ["x", UNIT_AWARE_TOOL], "planning: base x + tool");
	assert.deepEqual(resTools, ["a", UNIT_AWARE_TOOL], "research-decision: base a + tool");
	assert.notEqual(planPrompt, resPrompt, "i prompt snapshot sono diversi");
	assert.ok(planPrompt.includes(PLANNING_INSTRUCTION_MARKER), "planning: marker planning");
	assert.ok(planPrompt.includes("prima di decidere il piano"), "planning: testo istruzione");
	assert.ok(resPrompt.includes(RESEARCH_INSTRUCTION_MARKER), "research: marker research");
	assert.ok(resPrompt.includes("Usa discussion_arena"), "research: istruzione presente");
	assert.ok(
		!resPrompt.includes(PLANNING_INSTRUCTION_MARKER),
		"research: MAI marker planning",
	);
	assert.ok(
		!planPrompt.includes(RESEARCH_INSTRUCTION_MARKER),
		"planning: MAI marker research",
	);
});