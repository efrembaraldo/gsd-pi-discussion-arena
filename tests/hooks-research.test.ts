/**
 * Unit tests for hooks-research.ts — mirror di tests/hooks-planning.test.ts.
 *
 * Test attive attachResearchDecisionHooks che registra i tre hook via il
 * helper condiviso attachUnitAwareHooks con unit_type `research-decision`.
 * Pure function tests usando una API stub sintetica (no I/O, no subprocess).
 *
 * Lo stub sintetico (createApiStub/createContextStub) sostituisce i tipi SDK
 * ExtensionAPI/ExtensionContext: i file in tests/ non rientrano in tsconfig
 * include (il typecheck copre src/*.ts) — i test vengono eseguiti dal loader
 * TS ESM che rimuove i tipi.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { Writable } from "node:stream";
import { attachResearchDecisionHooks } from "../src/hooks-research.js";
import type { ResolveTriggerOutput } from "../trigger-resolver.js";

/** Mock ExtensionAPI stub for testing hook registration. */
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

interface ExtensionContextStub {
	cwd: string;
}

function createApiStub(): ExtensionAPIStub {
	const hooks = new Map<string, (event: Record<string, unknown>) => void>();
	const calls = new Map<string, HookRecord[]>();

	return {
		on(eventName: string, handler: (event: Record<string, unknown>) => void) {
			hooks.set(eventName, handler);
			if (!calls.has(eventName)) {
				calls.set(eventName, []);
			}
		},
		hooks,
		callHook(eventName: string, event: Record<string, unknown>) {
			const handler = hooks.get(eventName);
			if (handler) {
				handler(event);
				calls.get(eventName)!.push({
					event: JSON.parse(JSON.stringify(event)),
					timestamp: Date.now(),
				});
			}
		},
		getHookCalls(eventName: string): HookRecord[] {
			return calls.get(eventName) ?? [];
		},
	};
}

function createContextStub(): ExtensionContextStub {
	return { cwd: "/tmp/test" };
}

const FORCED: ResolveTriggerOutput = {
	decision: "forced",
	source: "env",
	warnings: [],
	parseErrors: [],
	// v2 (S01/M010): runtime context per gli attachers downstream.
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

function collectStderr(): { stream: Writable; lines: string[] } {
	const lines: string[] = [];
	const stream = new Writable({
		write(chunk, _enc, cb) {
			lines.push(String(chunk));
			cb();
		},
	});
	return { stream, lines };
}

test("(1) adjust_tool_set: adds discussion_arena when research-decision forced", () => {
	const api = createApiStub();
	const ctx = createContextStub();

	attachResearchDecisionHooks(api as any, ctx as any, FORCED);

	const apiStub = api;
	apiStub.callHook("unit_start", { unitType: "research-decision" });

	const adjustEvent = {
		type: "adjust_tool_set",
		selectedModelApi: "test",
		selectedModelProvider: "test",
		selectedModelId: "test-model",
		activeToolNames: [] as string[],
		filteredTools: [] as string[],
	};
	const handler = (apiStub.hooks as any).get("adjust_tool_set");
	const result = handler(adjustEvent);

	assert.ok(
		result?.toolNames?.includes("discussion_arena"),
		"discussion_arena should be added when research-decision forced",
	);
});

test("(2) adjust_tool_set: excludes discussion_arena when available-only", () => {
	const api = createApiStub();
	const ctx = createContextStub();

	attachResearchDecisionHooks(api as any, ctx as any, AVAILABLE_ONLY);

	const apiStub = api;
	apiStub.callHook("unit_start", { unitType: "research-decision" });

	const adjustEvent = {
		type: "adjust_tool_set",
		selectedModelApi: "test",
		selectedModelProvider: "test",
		selectedModelId: "test-model",
		activeToolNames: [] as string[],
		filteredTools: [] as string[],
	};
	const handler = (apiStub.hooks as any).get("adjust_tool_set");
	const result = handler(adjustEvent);

	assert.ok(
		!(result?.toolNames?.includes("discussion_arena")),
		"discussion_arena should NOT be added when available-only",
	);
});

test("(3) adjust_tool_set: excludes discussion_arena during a different unit type", () => {
	const api = createApiStub();
	const ctx = createContextStub();

	attachResearchDecisionHooks(api as any, ctx as any, FORCED);

	const apiStub = api;
	apiStub.callHook("unit_start", { unitType: "planning" });

	const adjustEvent = {
		type: "adjust_tool_set",
		selectedModelApi: "test",
		selectedModelProvider: "test",
		selectedModelId: "test-model",
		activeToolNames: [] as string[],
		filteredTools: [] as string[],
	};
	const handler = (apiStub.hooks as any).get("adjust_tool_set");
	const result = handler(adjustEvent);

	assert.ok(
		!(result?.toolNames?.includes("discussion_arena")),
		"discussion_arena should NOT be added outside research-decision, even when forced",
	);
});

test("(4) before_agent_start: prompt instruction contains research marker", () => {
	const api = createApiStub();
	const ctx = createContextStub();

	attachResearchDecisionHooks(api as any, ctx as any, FORCED);

	const apiStub = api;
	apiStub.callHook("unit_start", { unitType: "research-decision" });

	const beforeEvent = {
		type: "before_agent_start",
		prompt: "User prompt",
		systemPrompt: "Original system prompt.",
		systemPromptOptions: {} as any,
	};
	const handler = (apiStub.hooks as any).get("before_agent_start");
	const result = handler(beforeEvent);

	assert.ok(
		result?.systemPrompt?.includes(
			"<!-- gsd-pi-discussion-arena-research-instruction -->",
		),
		"research marker should be present in returned systemPrompt",
	);
	assert.ok(
		result?.systemPrompt?.includes("Usa discussion_arena"),
		"research instruction text should be present in returned systemPrompt",
	);
});

test("(5) before_agent_start: repeated calls do not duplicate instruction (marker-based)", () => {
	const api = createApiStub();
	const ctx = createContextStub();

	attachResearchDecisionHooks(api as any, ctx as any, FORCED);

	const apiStub = api;
	apiStub.callHook("unit_start", { unitType: "research-decision" });

	const handler = (apiStub.hooks as any).get("before_agent_start");

	const beforeEvent1 = {
		type: "before_agent_start",
		prompt: "User prompt",
		systemPrompt: "Original system prompt.",
		systemPromptOptions: {} as any,
	};
	const result1 = handler(beforeEvent1);
	const afterFirst = result1!.systemPrompt!;

	const beforeEvent2 = {
		type: "before_agent_start",
		prompt: "User prompt",
		systemPrompt: afterFirst,
		systemPromptOptions: {} as any,
	};
	const result2 = handler(beforeEvent2);
	const afterSecond = result2 ? result2.systemPrompt! : afterFirst;

	assert.equal(
		afterFirst,
		afterSecond,
		"repeated calls should not duplicate instruction (idempotent via marker check)",
	);

	const markerCount = (
		afterSecond.match(
			/<!-- gsd-pi-discussion-arena-research-instruction -->/g,
		) || []
	).length;
	assert.equal(
		markerCount,
		1,
		"research marker should appear exactly once, not twice",
	);
});

test("stderr: logs structured line on research-decision unit_start when forced", () => {
	const api = createApiStub();
	const ctx = createContextStub();
	const { stream, lines } = collectStderr();

	attachResearchDecisionHooks(api as any, ctx as any, FORCED, stream);

	const apiStub = api;
	apiStub.callHook("unit_start", { unitType: "research-decision" });

	assert.ok(
		lines.some((l) =>
			l.includes(
				"[discussion-arena] hook: research-decision forced su unit_start",
			),
		),
		"structured stderr log should be emitted on forced research-decision unit_start",
	);
});

test("stderr: no structured log when decision not forced", () => {
	const api = createApiStub();
	const ctx = createContextStub();
	const { stream, lines } = collectStderr();

	attachResearchDecisionHooks(api as any, ctx as any, AVAILABLE_ONLY, stream);

	const apiStub = api;
	apiStub.callHook("unit_start", { unitType: "research-decision" });

	assert.equal(
		lines.length,
		0,
		"no stderr log should be emitted when decision is not forced",
	);
});

test("registration idempotence: same api+marker registers hooks only once", () => {
	const api = createApiStub();
	const ctx = createContextStub();

	const first = attachResearchDecisionHooks(
		api as any,
		ctx as any,
		FORCED,
	) as boolean;
	const second = attachResearchDecisionHooks(
		api as any,
		ctx as any,
		FORCED,
	) as boolean;

	assert.equal(first, true, "first registration should succeed");
	assert.equal(
		second,
		false,
		"second registration with same api+marker should be a no-op",
	);

	const apiStub = api;
	apiStub.callHook("unit_start", { unitType: "research-decision" });

	const adjustEvent = {
		type: "adjust_tool_set",
		selectedModelApi: "test",
		selectedModelProvider: "test",
		selectedModelId: "test-model",
		activeToolNames: [] as string[],
		filteredTools: [] as string[],
	};
	const handler = (apiStub.hooks as any).get("adjust_tool_set");
	const result = handler(adjustEvent);
	const count = (result?.toolNames || []).filter(
		(t: string) => t === "discussion_arena",
	).length;
	assert.equal(count, 1, "discussion_arena should appear exactly once");
});

// ---------------------------------------------------------------------------
// M010/S02/T03 — NOTA: la coesistenza cross-marker dei 6 gruppi arena è
// testata esaustivamente in `tests/group-eligibility.test.ts` blocco (c).
// Per evitare duplicazione + dipendenza da `require()` runtime (non
// disponibile in ESM), questo file NON duplica i test cross-marker.
// ---------------------------------------------------------------------------