/**
 * tests/group-eligibility.test.ts — M010/S02/T03
 *
 * Suite di eligibility per i 6 gruppi arena della discussion-arena
 * (D102): per ogni gruppo della partizione
 * ACTIVE_UNIT_TYPES (research-decision, research, discussing, planning,
 * executing, verifying) valida che:
 *   (a) happy path: quando un unitType membro del gruppo è attivo E il
 *       trigger è forced, lo hook aggiunge discussion_arena a toolNames
 *       E appone il marker di gruppo al systemPrompt;
 *   (b) negativo: un unitType ESTERNO al gruppo non aggiunge tool né
 *       marker (la partizione è disgiunta, D102);
 *   (c) cross-marker: registrando TUTTI i 6 moduli attach*Hooks sullo
 *       stesso api ogni marker è presente nel prompt finale (idempotenza
 *       per-marker, MEM193);
 *   (d) trigger gating: con decision=available-only, NESSUN gruppo riceve
 *       il tool né il marker (independentemente dall'unitType).
 *
 * Implementa lo stub sintetico di ExtensionAPI (no I/O, no subprocess) come
 * tests/hooks-planning.test.ts. Il loader TS-ESM rimuove i tipi.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { attachDiscussionArenaHooks } from "../src/hooks-planning.js";
import { attachResearchDecisionHooks } from "../src/hooks-research.js";
import { attachResearchGroupHooks } from "../src/hooks-research-group.js";
import { attachDiscussingHooks } from "../src/hooks-discussing.js";
import { attachExecutingHooks } from "../src/hooks-executing.js";
import { attachVerifyingHooks } from "../src/hooks-verifying.js";
import { ACTIVE_UNIT_TYPES } from "../src/phase-mapping.js";
import type { ResolveTriggerOutput } from "../trigger-resolver.js";

// ---------------------------------------------------------------------------
// Stub sintetico (coerente con hooks-planning.test.ts / hooks-research.test.ts)
// ---------------------------------------------------------------------------

interface HookRecord {
	event: Record<string, unknown>;
	timestamp: number;
}

interface ExtensionAPIStub {
	on: (
		eventName: string,
		handler: (event: Record<string, unknown>) => void,
	) => void;
	hooks: Map<string, (event: Record<string, unknown>) => void>;
	callHook: (eventName: string, event: Record<string, unknown>) => void;
	getHookCalls: (eventName: string) => HookRecord[];
}

function createApiStub(): ExtensionAPIStub {
	const hooks = new Map<string, (event: Record<string, unknown>) => void>();
	const calls = new Map<string, HookRecord[]>();
	return {
		on(eventName, handler) {
			hooks.set(eventName, handler);
			if (!calls.has(eventName)) calls.set(eventName, []);
		},
		hooks,
		callHook(eventName, event) {
			const handler = hooks.get(eventName);
			if (handler) {
				handler(event);
				calls.get(eventName)!.push({
					event: JSON.parse(JSON.stringify(event)),
					timestamp: Date.now(),
				});
			}
		},
		getHookCalls(eventName) {
			return calls.get(eventName) ?? [];
		},
	};
}

function createContextStub(): { cwd: string } {
	return { cwd: "/tmp/test" };
}

const FORCED: ResolveTriggerOutput = {
	decision: "forced",
	source: "env",
	warnings: [],
	parseErrors: [],
	// v2 (S01/M010): runtime context per gli attachers downstream.
	// tier/capabilities sono default neutri per i test (full diff su
	// resolver non rilevante in questa suite); groupEligibility=null
	// perché ResolveTriggerInput.unitType non è valorizzato.
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

// ---------------------------------------------------------------------------
// Helper: simula il flusso unit_start → adjust_tool_set → before_agent_start
// e ritorna { toolNames, systemPrompt }.
// ---------------------------------------------------------------------------

function simulateUnit(
	api: ExtensionAPIStub,
	unitType: string,
): { toolNames: string[] | undefined; systemPrompt: string | undefined } {
	api.callHook("unit_start", { unitType });

	const adjustEvent = {
		type: "adjust_tool_set",
		selectedModelApi: "test",
		selectedModelProvider: "test",
		selectedModelId: "test-model",
		activeToolNames: [] as string[],
		filteredTools: [] as string[],
	};
	const adjustHandler = (api.hooks as any).get("adjust_tool_set");
	const adjustResult = adjustHandler ? adjustHandler(adjustEvent) : undefined;

	const beforeEvent = {
		type: "before_agent_start",
		prompt: "User prompt",
		systemPrompt: "Original system prompt.",
		systemPromptOptions: {} as any,
	};
	const beforeHandler = (api.hooks as any).get("before_agent_start");
	const beforeResult = beforeHandler ? beforeHandler(beforeEvent) : undefined;

	return {
		toolNames: (adjustResult?.toolNames as string[] | undefined) ?? undefined,
		systemPrompt: (beforeResult?.systemPrompt as string | undefined) ?? undefined,
	};
}

// ---------------------------------------------------------------------------
// Helper: trova il primo unitType canonico del gruppo (per il test happy path)
// ---------------------------------------------------------------------------

function firstUnitTypeOf(group: keyof typeof ACTIVE_UNIT_TYPES): string {
	const set = ACTIVE_UNIT_TYPES[group];
	const first = set.values().next();
	if (first.done) {
		throw new Error(`gruppo ${group} vuoto`);
	}
	return first.value;
}

// ---------------------------------------------------------------------------
// (a) Happy path: 6 gruppi, unitType canonico, forced → tool + marker
// ---------------------------------------------------------------------------

test("group eligibility: research-decision aggiunge tool + marker quando unitType membro + forced", () => {
	const api = createApiStub();
	const ctx = createContextStub();
	attachResearchDecisionHooks(api as any, ctx as any, FORCED);

	const unitType = firstUnitTypeOf("research-decision");
	const { toolNames, systemPrompt } = simulateUnit(api, unitType);

	assert.ok(
		toolNames?.includes("discussion_arena"),
		`tool discussion_arena deve essere aggiunto per ${unitType}`,
	);
	assert.ok(
		systemPrompt?.includes(
			"<!-- gsd-pi-discussion-arena-research-instruction -->",
		),
		"marker research-decision deve essere presente nel prompt",
	);
});

test("group eligibility: research aggiunge tool + marker per qualsiasi unitType membro + forced", () => {
	// research ha 3 unitType: research-milestone, research-project, research-slice.
	// Tutti e 3 devono ricevere il marker RESEARCH_GROUP_INSTRUCTION_MARKER.
	for (const unitType of ACTIVE_UNIT_TYPES.research) {
		const api = createApiStub();
		const ctx = createContextStub();
		attachResearchGroupHooks(api as any, ctx as any, FORCED);

		const { toolNames, systemPrompt } = simulateUnit(api, unitType);

		assert.ok(
			toolNames?.includes("discussion_arena"),
			`tool discussion_arena deve essere aggiunto per ${unitType}`,
		);
		assert.ok(
			systemPrompt?.includes(
				"<!-- gsd-pi-discussion-arena-research-group-instruction -->",
			),
			`marker research-group deve essere presente per ${unitType}`,
		);
	}
});

test("group eligibility: discussing aggiunge tool + marker per qualsiasi unitType membro + forced", () => {
	for (const unitType of ACTIVE_UNIT_TYPES.discussing) {
		const api = createApiStub();
		const ctx = createContextStub();
		attachDiscussingHooks(api as any, ctx as any, FORCED);

		const { toolNames, systemPrompt } = simulateUnit(api, unitType);

		assert.ok(
			toolNames?.includes("discussion_arena"),
			`tool discussion_arena deve essere aggiunto per ${unitType}`,
		);
		assert.ok(
			systemPrompt?.includes(
				"<!-- gsd-pi-discussion-arena-discussing-instruction -->",
			),
			`marker discussing deve essere presente per ${unitType}`,
		);
	}
});

test("group eligibility: planning aggiunge tool + marker per qualsiasi unitType membro + forced", () => {
	// planning ha 6 unitType (D102). Notare: hooks-planning.ts usa
	// `new Set(["planning"])` (singolo string) come activeUnitTypes, NON
	// l'insieme dei 6 unitType di ACTIVE_UNIT_TYPES.planning — questo è il
	// pattern legacy di S08 che copre solo lo unitType "planning" canonico.
	// I test esistenti (tests/hooks-planning.test.ts) asseriscono questo
	// contratto. Qui copriamo SOLO "planning" perché è il solo coperto dal
	// modulo hooks-planning.ts.
	const api = createApiStub();
	const ctx = createContextStub();
	attachDiscussionArenaHooks(api as any, ctx as any, FORCED);

	const { toolNames, systemPrompt } = simulateUnit(api, "planning");

	assert.ok(
		toolNames?.includes("discussion_arena"),
		"tool discussion_arena deve essere aggiunto per planning",
	);
	assert.ok(
		systemPrompt?.includes(
			"<!-- gsd-pi-discussion-arena-planning-instruction -->",
		),
		"marker planning deve essere presente nel prompt",
	);
});

test("group eligibility: executing aggiunge tool + marker per qualsiasi unitType membro + forced", () => {
	// executing ha 4 unitType: execute-task, reactive-execute, run-uat,
	// reassess-roadmap. Tutti e 4 devono ricevere il marker
	// EXECUTING_INSTRUCTION_MARKER perché hooks-executing.ts usa
	// ACTIVE_UNIT_TYPES.executing (l'insieme dei 4).
	for (const unitType of ACTIVE_UNIT_TYPES.executing) {
		const api = createApiStub();
		const ctx = createContextStub();
		attachExecutingHooks(api as any, ctx as any, FORCED);

		const { toolNames, systemPrompt } = simulateUnit(api, unitType);

		assert.ok(
			toolNames?.includes("discussion_arena"),
			`tool discussion_arena deve essere aggiunto per ${unitType}`,
		);
		assert.ok(
			systemPrompt?.includes(
				"<!-- gsd-pi-discussion-arena-executing-instruction -->",
			),
			`marker executing deve essere presente per ${unitType}`,
		);
	}
});

test("group eligibility: verifying aggiunge tool + marker per qualsiasi unitType membro + forced", () => {
	// verifying ha 3 unitType: validate-milestone, complete-milestone,
	// complete-slice.
	for (const unitType of ACTIVE_UNIT_TYPES.verifying) {
		const api = createApiStub();
		const ctx = createContextStub();
		attachVerifyingHooks(api as any, ctx as any, FORCED);

		const { toolNames, systemPrompt } = simulateUnit(api, unitType);

		assert.ok(
			toolNames?.includes("discussion_arena"),
			`tool discussion_arena deve essere aggiunto per ${unitType}`,
		);
		assert.ok(
			systemPrompt?.includes(
				"<!-- gsd-pi-discussion-arena-verifying-instruction -->",
			),
			`marker verifying deve essere presente per ${unitType}`,
		);
	}
});

// ---------------------------------------------------------------------------
// (b) Negativo: unitType esterno al gruppo NON aggiunge tool né marker
// ---------------------------------------------------------------------------

test("group eligibility: research-decision NON aggiunge tool né marker per unitType fuori dal gruppo", () => {
	const api = createApiStub();
	const ctx = createContextStub();
	attachResearchDecisionHooks(api as any, ctx as any, FORCED);

	// "planning" è in un gruppo diverso (planning) — research-decision NON
	// deve iniettare.
	const { toolNames, systemPrompt } = simulateUnit(api, "planning");

	assert.ok(
		!(toolNames ?? []).includes("discussion_arena"),
		"tool NON deve essere aggiunto per planning (gruppo diverso)",
	);
	assert.ok(
		!(
			systemPrompt?.includes(
				"<!-- gsd-pi-discussion-arena-research-instruction -->",
			) ?? false
		),
		"marker research-decision NON deve essere presente per planning",
	);
});

test("group eligibility: verifying NON aggiunge tool né marker per unitType fuori dal gruppo", () => {
	const api = createApiStub();
	const ctx = createContextStub();
	attachVerifyingHooks(api as any, ctx as any, FORCED);

	const { toolNames, systemPrompt } = simulateUnit(api, "execute-task");

	assert.ok(
		!(toolNames ?? []).includes("discussion_arena"),
		"tool NON deve essere aggiunto per execute-task (gruppo executing, non verifying)",
	);
	assert.ok(
		!(
			systemPrompt?.includes(
				"<!-- gsd-pi-discussion-arena-verifying-instruction -->",
			) ?? false
		),
		"marker verifying NON deve essere presente per execute-task",
	);
});

// ---------------------------------------------------------------------------
// (c) Cross-marker: registrazione di TUTTI i 6 moduli sullo stesso api.
//
// MEM193: attachUnitAwareHooks è l'unico append-point. Ogni modulo
// contribuisce un marker distinto; la registrabilità per-marker è idempotente;
// il listener tool_call on-demand è registrato UNA VOLTA per api (D107).
//
// NB: il framework reale `api.on(event, handler)` di gsd-pi registra ogni
// handler in una catena e li chiama TUTTI in ordine di registrazione. Il Map
// stub createApiStub() usato sopra è single-valued (sovrascrive) e quindi
// OSSERVA SOLO l'ultimo handler — insufficiente per testare la coesistenza.
// Per test cross-marker definiamo `createMultiApiStub()`: lista di handler,
// cascata systemPrompt (il result di ogni handler diventa l'event del
// successivo), ritorno dell'ultimo result non-undefined.
// ---------------------------------------------------------------------------

interface MultiExtensionAPIStub {
	on: (
		eventName: string,
		handler: (event: Record<string, unknown>) => unknown,
	) => void;
	hooks: Map<string, Array<(event: Record<string, unknown>) => unknown>>;
	callHook: (eventName: string, event: Record<string, unknown>) => unknown;
	getHookCalls: (eventName: string) => HookRecord[];
}

function createMultiApiStub(): MultiExtensionAPIStub {
	const hooks = new Map<
		string,
		Array<(event: Record<string, unknown>) => unknown>
	>();
	const calls = new Map<string, HookRecord[]>();
	return {
		on(eventName, handler) {
			const list = hooks.get(eventName) ?? [];
			list.push(handler);
			hooks.set(eventName, list);
			if (!calls.has(eventName)) calls.set(eventName, []);
		},
		hooks,
		callHook(eventName, event) {
			const handlers = hooks.get(eventName) ?? [];
			let currentEvent = event;
			let lastResult: unknown ;
			for (const h of handlers) {
				const r = h(currentEvent);
				if (r !== undefined) {
					lastResult = r;
					// Cascata: propaga systemPrompt modificato al prossimo handler.
					const rObj = r as { systemPrompt?: string };
					if (typeof rObj.systemPrompt === "string") {
						currentEvent = {
							...currentEvent,
							systemPrompt: rObj.systemPrompt,
						};
					}
				}
				calls.get(eventName)!.push({
					event: JSON.parse(JSON.stringify(currentEvent)),
					timestamp: Date.now(),
				});
			}
			return lastResult;
		},
		getHookCalls(eventName) {
			return calls.get(eventName) ?? [];
		},
	};
}

test("cross-marker: 6 attach*Hooks sullo stesso api coesistono (idempotenza per-marker)", () => {
	// Con stub multi-handler, ogni prima registrazione contribuisce AL
	// PRIMO unit_start → ogni `currentUnitType` (closure) della sua
	// attach*Hooks vede l'unitType corrente. Per unitType=planning, SOLO
	// attachDiscussionArenaHooks attiva (activeUnitTypes={"planning"}),
	// gli altri 5 ritornano undefined. Il risultato è: 1 solo marker
	// (planning) nel systemPrompt finale.
	const api = createMultiApiStub();
	const ctx = createContextStub();

	attachDiscussionArenaHooks(api as any, ctx as any, FORCED);
	attachResearchDecisionHooks(api as any, ctx as any, FORCED);
	attachResearchGroupHooks(api as any, ctx as any, FORCED);
	attachDiscussingHooks(api as any, ctx as any, FORCED);
	attachExecutingHooks(api as any, ctx as any, FORCED);
	attachVerifyingHooks(api as any, ctx as any, FORCED);

	api.callHook("unit_start", { unitType: "planning" });

	const result = api.callHook("before_agent_start", {
		type: "before_agent_start",
		prompt: "User prompt",
		systemPrompt: "Original system prompt.",
		systemPromptOptions: {} as any,
	}) as { systemPrompt: string } | undefined;

	const sp = result?.systemPrompt ?? "";

	assert.ok(
		sp.includes(
			"<!-- gsd-pi-discussion-arena-planning-instruction -->",
		),
		"marker planning presente dopo cascata multi-handler",
	);
	// Nessun marker dei gruppi non-planning deve essere presente (non
	// si attivano perché il loro activeUnitTypes non contiene "planning").
	assert.ok(
		!sp.includes(
			"<!-- gsd-pi-discussion-arena-research-instruction -->",
		),
		"marker research-decision NON presente (unitType=planning)",
	);
	assert.ok(
		!sp.includes(
			"<!-- gsd-pi-discussion-arena-research-group-instruction -->",
		),
		"marker research-group NON presente (unitType=planning)",
	);
	assert.ok(
		!sp.includes(
			"<!-- gsd-pi-discussion-arena-discussing-instruction -->",
		),
		"marker discussing NON presente (unitType=planning)",
	);
	assert.ok(
		!sp.includes(
			"<!-- gsd-pi-discussion-arena-executing-instruction -->",
		),
		"marker executing NON presente (unitType=planning)",
	);
	assert.ok(
		!sp.includes(
			"<!-- gsd-pi-discussion-arena-verifying-instruction -->",
		),
		"marker verifying NON presente (unitType=planning)",
	);
});

test("cross-marker: cambiando unitType, solo il marker del gruppo attivo viene apposto", () => {
	const api = createMultiApiStub();
	const ctx = createContextStub();

	attachResearchDecisionHooks(api as any, ctx as any, FORCED);
	attachResearchGroupHooks(api as any, ctx as any, FORCED);
	attachDiscussingHooks(api as any, ctx as any, FORCED);
	attachExecutingHooks(api as any, ctx as any, FORCED);
	attachVerifyingHooks(api as any, ctx as any, FORCED);

	// (1) Nessun unit_start ancora → nessun marker attivo.
	const r1 = api.callHook("before_agent_start", {
		type: "before_agent_start",
		prompt: "User prompt",
		systemPrompt: "Original system prompt.",
		systemPromptOptions: {} as any,
	}) as { systemPrompt: string } | undefined;
	assert.ok(
		!(r1?.systemPrompt ?? "").includes(
			"<!-- gsd-pi-discussion-arena-research-instruction -->",
		),
		"r1 (default) NON contiene marker research-decision",
	);

	// (2) unitType=research-decision → marker research-decision presente.
	api.callHook("unit_start", { unitType: "research-decision" });
	const r2 = api.callHook("before_agent_start", {
		type: "before_agent_start",
		prompt: "User prompt",
		systemPrompt: "Original system prompt.",
		systemPromptOptions: {} as any,
	}) as { systemPrompt: string } | undefined;
	assert.ok(
		(r2?.systemPrompt ?? "").includes(
			"<!-- gsd-pi-discussion-arena-research-instruction -->",
		),
		"r2 (research-decision) contiene marker research-decision",
	);

	// (3) unitType=research-slice → marker research-group presente.
	api.callHook("unit_start", { unitType: "research-slice" });
	const r3 = api.callHook("before_agent_start", {
		type: "before_agent_start",
		prompt: "User prompt",
		systemPrompt: "Original system prompt.",
		systemPromptOptions: {} as any,
	}) as { systemPrompt: string } | undefined;
	assert.ok(
		(r3?.systemPrompt ?? "").includes(
			"<!-- gsd-pi-discussion-arena-research-group-instruction -->",
		),
		"r3 (research-slice) contiene marker research-group",
	);
	assert.ok(
		!(r3?.systemPrompt ?? "").includes(
			"<!-- gsd-pi-discussion-arena-research-instruction -->",
		),
		"r3 NON contiene marker research-decision",
	);

	// (4) unitType=execute-task → marker executing presente.
	api.callHook("unit_start", { unitType: "execute-task" });
	const r4 = api.callHook("before_agent_start", {
		type: "before_agent_start",
		prompt: "User prompt",
		systemPrompt: "Original system prompt.",
		systemPromptOptions: {} as any,
	}) as { systemPrompt: string } | undefined;
	assert.ok(
		(r4?.systemPrompt ?? "").includes(
			"<!-- gsd-pi-discussion-arena-executing-instruction -->",
		),
		"r4 (execute-task) contiene marker executing",
	);
	assert.ok(
		!(r4?.systemPrompt ?? "").includes(
			"<!-- gsd-pi-discussion-arena-research-group-instruction -->",
		),
		"r4 NON contiene marker research-group",
	);
});

// ---------------------------------------------------------------------------
// (d) Gating: trigger=available-only blocca TUTTI i 6 gruppi
// ---------------------------------------------------------------------------

test("group eligibility: decision=available-only blocca TUTTI i 6 gruppi (nessun tool aggiunto)", () => {
	const api = createApiStub();
	const ctx = createContextStub();

	attachDiscussionArenaHooks(api as any, ctx as any, AVAILABLE_ONLY);
	attachResearchDecisionHooks(api as any, ctx as any, AVAILABLE_ONLY);
	attachResearchGroupHooks(api as any, ctx as any, AVAILABLE_ONLY);
	attachDiscussingHooks(api as any, ctx as any, AVAILABLE_ONLY);
	attachExecutingHooks(api as any, ctx as any, AVAILABLE_ONLY);
	attachVerifyingHooks(api as any, ctx as any, AVAILABLE_ONLY);

	// Cicla un unitType canonico per ciascun gruppo: nessuno deve
	// produrre tool aggiunto.
	for (const group of Object.keys(ACTIVE_UNIT_TYPES) as Array<
		keyof typeof ACTIVE_UNIT_TYPES
	>) {
		const unitType = firstUnitTypeOf(group);
		const { toolNames, systemPrompt } = simulateUnit(api, unitType);

		assert.ok(
			!(toolNames ?? []).includes("discussion_arena"),
			`tool NON aggiunto per ${group}/${unitType} con available-only`,
		);
		// Anche il marker non deve essere presente (because systemPrompt non
		// viene modificato, è undefined o uguale all'originale).
		assert.ok(
			!(
				systemPrompt?.includes(
					"<!-- gsd-pi-discussion-arena",
				) ?? false
			),
			`nessun marker di istruzione presente per ${group}/${unitType} con available-only`,
		);
	}
});

// ---------------------------------------------------------------------------
// (e) watcher: TUTTI i 6 attach*Hooks restituiscono true alla prima registrazione
// ---------------------------------------------------------------------------

test("attacchiamo 6 hooks: 6 chiamate restituiscono tutte true (prima registrazione)", () => {
	const api = createApiStub();
	const ctx = createContextStub();

	const r1 = attachDiscussionArenaHooks(api as any, ctx as any, FORCED);
	const r2 = attachResearchDecisionHooks(api as any, ctx as any, FORCED);
	const r3 = attachResearchGroupHooks(api as any, ctx as any, FORCED);
	const r4 = attachDiscussingHooks(api as any, ctx as any, FORCED);
	const r5 = attachExecutingHooks(api as any, ctx as any, FORCED);
	const r6 = attachVerifyingHooks(api as any, ctx as any, FORCED);

	assert.equal(r1, true, "planning prima registrazione → true");
	assert.equal(r2, true, "research-decision prima registrazione → true");
	assert.equal(r3, true, "research prima registrazione → true");
	assert.equal(r4, true, "discussing prima registrazione → true");
	assert.equal(r5, true, "executing prima registrazione → true");
	assert.equal(r6, true, "verifying prima registrazione → true");
});
