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

import { beforeEach, test } from "node:test";
import * as assert from "node:assert/strict";
import { attachUnitAwareHooks, resolvePhaseLabel } from "../src/hooks-unit-aware.js";
import {
	PLANNING_INSTRUCTION_MARKER,
	RESEARCH_INSTRUCTION_MARKER,
} from "../src/markers.js";
import { getMetrics, resetMetrics } from "../metrics.js";
import type { ResolveTriggerOutput } from "../trigger-resolver.js";

// Isolamento del registry metrico singleton (pattern identico a metrics.test.ts).
beforeEach(() => {
	resetMetrics();
});

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
	// v2 defaults (S01/M010, vedi ResolveTriggerInput in trigger-resolver.ts):
	// il resolver applica i default neutri `tier='A'`, `capabilities=∅`,
	// `groupEligibility=null` quando il caller non li fornisce. Le fixture
	// di test li esplicitano per soddisfare i campi richiesti di v2.
	tier: "A",
	capabilities: new Set(),
	groupEligibility: null,
};

const AVAILABLE_ONLY: ResolveTriggerOutput = {
	decision: "available-only",
	source: "fallback",
	warnings: [],
	parseErrors: [],
	tier: "A",
	capabilities: new Set(),
	groupEligibility: null,
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

test("resolvePhaseLabel: membro di gruppo → gruppo, chiave di gruppo → se stessa, altro → unknown (D087)", () => {
	// Unità membri del gruppo planning → gruppo planning.
	assert.equal(resolvePhaseLabel("plan-milestone"), "planning");
	assert.equal(resolvePhaseLabel("plan-slice"), "planning");
	assert.equal(resolvePhaseLabel("replan-task"), "planning");
	// Il gruppo research-decision contiene se stesso come membro → gruppo.
	assert.equal(resolvePhaseLabel("research-decision"), "research-decision");
	// Chiave di gruppo (T01 ha 6 gruppi: research-decision, research,
	// discussing, planning, executing, verifying) → la chiave stessa.
	assert.equal(resolvePhaseLabel("planning"), "planning");
	assert.equal(resolvePhaseLabel("executing"), "executing");
	assert.equal(resolvePhaseLabel("verifying"), "verifying");
	// Fuori dai gruppi noti (variants operativi esclusi per design da T01:
	// quick-task, rewrite-docs, triage-captures, workflow-preferences)
	// → sentinella unknown (D087, cardinalità label vincolata).
	assert.equal(resolvePhaseLabel("quick-task"), "unknown");
	assert.equal(resolvePhaseLabel(""), "unknown");
});

test("before_agent_start forced: incrementa discussion_arena_forced_total{phase} e logga NDJSON discussionArena.forced", () => {
	const d = createDispatcher();
	const api = { on: makeApi(d.handlers) };
	attachUnitAwareHooks(api as never, ctx as never, {
		activeUnitTypes: new Set(["planning"]),
		instructionMarker: PLANNING_INSTRUCTION_MARKER,
		instructionText: PLANNING_INSTRUCTION,
		resolveTrigger: FORCED,
	});

	// Sequenza reale: unit_start → before_agent_start forced.
	d.emit("unit_start", { unitType: "planning" });
	const chunks = captureStderrChunksSync(() => {
		d.emit("before_agent_start", {
			prompt: "p",
			systemPrompt: "Original.",
			systemPromptOptions: {},
		});
	});

	// (a) counter in getMetrics().
	const forced = getMetrics().counters["discussion_arena_forced_total"] ?? {};
	assert.equal(
		forced["{phase=planning}"],
		1,
		"forced{phase=planning} = 1 dopo una iniezione",
	);

	// (b) riga NDJSON su stderr con event discussionArena.forced e fields tier/phase.
	const forcedLog = chunks.find((c) => c.includes("discussionArena.forced"));
	assert.ok(forcedLog, "evento discussionArena.forced emesso su stderr");
	const parsed = JSON.parse(forcedLog!);
	assert.equal(parsed.event, "discussionArena.forced");
	assert.equal(parsed.level, "info");
	assert.equal(parsed.tier, "F");
	assert.equal(parsed.phase, "planning");
});

test("before_agent_start forced: retry su prompt già marcato NON incrementa né riloga (D088)", () => {
	const d = createDispatcher();
	const api = { on: makeApi(d.handlers) };
	attachUnitAwareHooks(api as never, ctx as never, {
		activeUnitTypes: new Set(["planning"]),
		instructionMarker: PLANNING_INSTRUCTION_MARKER,
		instructionText: PLANNING_INSTRUCTION,
		resolveTrigger: FORCED,
	});

	d.emit("unit_start", { unitType: "planning" });
	captureStderrChunksSync(() => {
		d.emit("before_agent_start", {
			prompt: "p",
			systemPrompt: "Original.",
			systemPromptOptions: {},
		});
	});
	const afterFirst =
		getMetrics().counters["discussion_arena_forced_total"]?.["{phase=planning}"] ?? 0;

	// Retry con prompt che già contiene il marker (d.prompts[0] è l'output della 1ª call).
	const chunks = captureStderrChunksSync(() => {
		d.emit("before_agent_start", {
			prompt: "p",
			systemPrompt: d.prompts[0] ?? "Original.",
			systemPromptOptions: {},
		});
	});
	const afterSecond =
		getMetrics().counters["discussion_arena_forced_total"]?.["{phase=planning}"] ?? 0;

	assert.equal(afterFirst, 1, "prima forzazione conta");
	assert.equal(afterSecond, 1, "retry no-op NON incrementa il counter (D088)");
	assert.equal(
		chunks.filter((c) => c.includes("discussionArena.forced")).length,
		0,
		"nessun log NDJSON per il retry no-op",
	);
});

test("before_agent_start non-forced (available-only): nessun counter e nessun log", () => {
	const d = createDispatcher();
	const api = { on: makeApi(d.handlers) };
	attachUnitAwareHooks(api as never, ctx as never, {
		activeUnitTypes: new Set(["planning"]),
		instructionMarker: PLANNING_INSTRUCTION_MARKER,
		instructionText: PLANNING_INSTRUCTION,
		resolveTrigger: AVAILABLE_ONLY,
	});

	d.emit("unit_start", { unitType: "planning" });
	const chunks = captureStderrChunksSync(() => {
		d.emit("before_agent_start", {
			prompt: "p",
			systemPrompt: "Original.",
			systemPromptOptions: {},
		});
	});

	assert.equal(
		getMetrics().counters["discussion_arena_forced_total"],
		undefined,
		"available-only: non registra alcuna forzatura",
	);
	assert.equal(
		chunks.filter((c) => c.includes("discussionArena.forced")).length,
		0,
		"available-only: nessun log discussionArena.forced",
	);
});

// ─── tool_call on-demand observer (S02/T02) ──────────────────────────────────
//
// Il listener `tool_call` è un OSSERVATORE puro registrato in
// `attachUnitAwareHooks`: NON è un meccanismo di forzatura
// (`discussion_arena` è già registrato con `api.registerTool` in index.ts e
// resta invocabile in ogni fase). Il listener serve a tracciare OGNI
// invocazione del tool — durante le fasi forced E durante le invocazioni
// on-demand al di fuori dei gruppi attivi (D107) — emettendo log NDJSON
// `discussionArena.on_demand` su stderr e incrementando il counter
// `discussion_arena_on_demand_total{phase}`. Viene registrato UNA sola volta
// per api (idempotenza indipendente dal marker), quindi multi-marker setup
// NON produce duplicati né over-count.

test("tool_call on-demand observer: discussion_arena → incrementa discussion_arena_on_demand_total{phase} e logga discussionArena.on_demand", () => {
	const d = createDispatcher();
	const api = { on: makeApi(d.handlers) };
	attachUnitAwareHooks(api as never, ctx as never, {
		activeUnitTypes: new Set(["planning"]),
		instructionMarker: PLANNING_INSTRUCTION_MARKER,
		instructionText: PLANNING_INSTRUCTION,
		resolveTrigger: FORCED,
	});

	// Sequenza reale: unit_start → tool_call del tool discussion_arena.
	d.emit("unit_start", { unitType: "planning" });
	const chunks = captureStderrChunksSync(() => {
		d.emit("tool_call", {
			type: "tool_call",
			toolName: "discussion_arena",
			toolCallId: "tc-1",
			input: {},
		});
	});

	// (a) counter in getMetrics(): discussion_arena_on_demand_total{phase=planning}=1.
	const onDemand = getMetrics().counters["discussion_arena_on_demand_total"] ?? {};
	assert.equal(
		onDemand["{phase=planning}"],
		1,
		"discussion_arena_on_demand_total{phase=planning} = 1 dopo una invocazione",
	);
	// I counter `forced` (S01/S02) NON vengono toccati dal listener on-demand.
	assert.equal(
		getMetrics().counters["discussion_arena_forced_total"],
		undefined,
		"tool_call listener non incrementa discussion_arena_forced_total",
	);

	// (b) riga NDJSON su stderr con event discussionArena.on_demand + fields.
	const onDemandLog = chunks.find((c) => c.includes("discussionArena.on_demand"));
	assert.ok(onDemandLog, "evento discussionArena.on_demand emesso su stderr");
	const parsed = JSON.parse(onDemandLog!);
	assert.equal(parsed.event, "discussionArena.on_demand");
	assert.equal(parsed.level, "info");
	assert.equal(parsed.toolName, "discussion_arena");
	assert.equal(parsed.phase, "planning");
	assert.ok(typeof parsed.ts === "string", "timestamp ISO presente");
});

test("tool_call on-demand observer: ignora eventi con toolName diversa da discussion_arena", () => {
	const d = createDispatcher();
	const api = { on: makeApi(d.handlers) };
	attachUnitAwareHooks(api as never, ctx as never, {
		activeUnitTypes: new Set(["planning"]),
		instructionMarker: PLANNING_INSTRUCTION_MARKER,
		instructionText: PLANNING_INSTRUCTION,
		resolveTrigger: FORCED,
	});

	d.emit("unit_start", { unitType: "planning" });
	const chunks = captureStderrChunksSync(() => {
		d.emit("tool_call", {
			type: "tool_call",
			toolName: "bash",
			toolCallId: "tc-bash",
			input: {},
		});
		d.emit("tool_call", {
			type: "tool_call",
			toolName: "read",
			toolCallId: "tc-read",
			input: {},
		});
	});

	assert.equal(
		getMetrics().counters["discussion_arena_on_demand_total"],
		undefined,
		"nessun counter on-demand per toolName != discussion_arena",
	);
	assert.equal(
		chunks.filter((c) => c.includes("discussionArena.on_demand")).length,
		0,
		"nessun log NDJSON on-demand per toolName != discussion_arena",
	);
});

test("tool_call on-demand observer: ignora eventi con type != 'tool_call'", () => {
	const d = createDispatcher();
	const api = { on: makeApi(d.handlers) };
	attachUnitAwareHooks(api as never, ctx as never, {
		activeUnitTypes: new Set(["planning"]),
		instructionMarker: PLANNING_INSTRUCTION_MARKER,
		instructionText: PLANNING_INSTRUCTION,
		resolveTrigger: FORCED,
	});

	d.emit("unit_start", { unitType: "planning" });
	const chunks = captureStderrChunksSync(() => {
		// type sbagliato: la guard `e?.type !== "tool_call"` deve intercettare
		// e fare early-return. Tool_callEvent non discrimina via type literal
		// per via dell'overlap toolName:string, ma type:"tool_call" è la
		// discriminante canonicamente supportata dal guard.
		d.emit("tool_call", {
			type: "tool_result",
			toolName: "discussion_arena",
			toolCallId: "tc-1",
		});
	});

	assert.equal(
		getMetrics().counters["discussion_arena_on_demand_total"],
		undefined,
		"nessun counter on-demand per type != tool_call",
	);
	assert.equal(
		chunks.filter((c) => c.includes("discussionArena.on_demand")).length,
		0,
		"nessun log NDJSON on-demand per type != tool_call",
	);
});

test("tool_call on-demand observer: phase = 'unknown' se current unitType fuori dai gruppi (D087)", () => {
	const d = createDispatcher();
	const api = { on: makeApi(d.handlers) };
	attachUnitAwareHooks(api as never, ctx as never, {
		activeUnitTypes: new Set(["planning"]),
		instructionMarker: PLANNING_INSTRUCTION_MARKER,
		instructionText: PLANNING_INSTRUCTION,
		resolveTrigger: FORCED,
	});

	// unit_start FUORI dal gruppo attivo (variant operativo "quick-task",
	// escluso per design da T01 fuori forcing) → resolvePhaseLabel restituisce
	// "unknown" via sentinella D087 (cardinalità label vincolata).
	d.emit("unit_start", { unitType: "quick-task" });
	captureStderrChunksSync(() => {
		d.emit("tool_call", {
			type: "tool_call",
			toolName: "discussion_arena",
			toolCallId: "tc-1",
			input: {},
		});
	});

	const onDemand = getMetrics().counters["discussion_arena_on_demand_total"] ?? {};
	assert.equal(
		onDemand["{phase=unknown}"],
		1,
		"discussion_arena_on_demand_total{phase=unknown} = 1 per unitType non classificato",
	);
});

test("tool_call on-demand observer: si attiva anche quando decision non è forced (puro osservatore, no isActive gating)", () => {
	const d = createDispatcher();
	const api = { on: makeApi(d.handlers) };
	attachUnitAwareHooks(api as never, ctx as never, {
		activeUnitTypes: new Set(["planning"]),
		instructionMarker: PLANNING_INSTRUCTION_MARKER,
		instructionText: PLANNING_INSTRUCTION,
		resolveTrigger: AVAILABLE_ONLY,
	});

	// Decision available-only: il path `forced` NON inietta tool/marker
	// (i 3 hook unit_start/adjust_tool_set/before_agent_start si fermano
	// al guard isActive()), ma il listener on-demand è puro osservatore e
	// DEVE continuare a osservare ogni invocazione del tool — il tool resta
	// registrato via api.registerTool in index.ts indipendentemente dalla
	// decision del trigger.
	d.emit("unit_start", { unitType: "planning" });
	captureStderrChunksSync(() => {
		d.emit("tool_call", {
			type: "tool_call",
			toolName: "discussion_arena",
			toolCallId: "tc-1",
			input: {},
		});
	});

	const onDemand = getMetrics().counters["discussion_arena_on_demand_total"] ?? {};
	assert.equal(
		onDemand["{phase=planning}"],
		1,
		"decision=available-only non spegne il listener on-demand (D107)",
	);
	// forced counter rimane non inizializzato (decision != forced).
	assert.equal(
		getMetrics().counters["discussion_arena_forced_total"],
		undefined,
		"forced counter non incrementato quando decision != forced",
	);
});

test("tool_call on-demand observer: idempotenza — listener registrato UNA sola volta per api (multi-marker no over-count D107)", () => {
	const d = createDispatcher();
	const api = { on: makeApi(d.handlers) };
	const ctxStub = {} as never;

	// Multi-marker (planning + research-decision) sullo stesso api.
	const firstPlanning = attachUnitAwareHooks(api as never, ctxStub, {
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
	assert.equal(firstPlanning, true, "prima registrazione planning: true");
	assert.equal(research, true, "registrazione research su api planning-only: true");

	// Anche se entrambi i marker sono attivi, il listener tool_call è una
	// sola istanza (WeakMap-toolCallListenerByApi) → UN solo increment del
	// counter per invocazione, no over-count.
	d.emit("unit_start", { unitType: "planning" });
	captureStderrChunksSync(() => {
		d.emit("tool_call", {
			type: "tool_call",
			toolName: "discussion_arena",
			toolCallId: "tc-1",
			input: {},
		});
	});

	// (a) counter incrementato UNA volta sola.
	const onDemand = getMetrics().counters["discussion_arena_on_demand_total"] ?? {};
	assert.equal(
		onDemand["{phase=planning}"],
		1,
		"counter incrementato UNA volta (no over-count da multi-marker)",
	);

	// (b) dispatcher: esattamente UN handler tool_call registrato.
	const toolCallHandlers = (d.handlers.get("tool_call") ?? []).length;
	assert.equal(
		toolCallHandlers,
		1,
		"esattamente 1 handler tool_call registrato sul dispatcher (idempotenza per-api)",
	);

	// (c) gli altri 3 hook (unit_start/adjust_tool_set/before_agent_start)
	// restano 2 (uno per marker) — il listener tool_call è indipendente.
	const adjustHandlers = (d.handlers.get("adjust_tool_set") ?? []).length;
	assert.equal(
		adjustHandlers,
		2,
		"adjust_tool_set resta a 2 handler (planning+research, idempotenza per-marker invariata)",
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