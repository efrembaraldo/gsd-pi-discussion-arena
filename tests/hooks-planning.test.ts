/**
 * Unit tests for hooks-planning.ts
 *
 * Tests the attachDiscussionArenaHooks function which registers three hooks:
 * 1. unit_start — track current phase
 * 2. adjust_tool_set — add discussion_arena to toolNames when phase===planning AND forced
 * 3. before_agent_start — append idempotent instruction to systemPrompt
 *
 * Pure function tests using synthetic API stub (no I/O, no subprocess).
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { attachDiscussionArenaHooks } from "../src/hooks-planning.js";
import type { ResolveTriggerOutput } from "../trigger-resolver.js";
// NOTE: il tsconfig include esclude tests/*; per non dipendere dal mapping
// paths di @gsd/pi-coding-agent (vedi tsconfig "paths"), il test usa tipi
// dichiarati localmente (ExtensionAPIStub / ExtensionContextStub). Il
// runtime ESM rimuove i tipi via ts-esm-loader.

/**
 * Mock ExtensionAPI stub for testing hook registration.
 * Records which hooks were called and their event payloads.
 */
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
					event: JSON.parse(JSON.stringify(event)), // Clone for inspection
					timestamp: Date.now(),
				});
			}
		},
		getHookCalls(eventName: string): HookRecord[] {
			return calls.get(eventName) ?? [];
		},
	};
}

interface ExtensionContextStub {
	cwd: string;
}

function createContextStub(): ExtensionContextStub {
	return {
		cwd: "/tmp/test",
	};
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

test("(1) adjust_tool_set: adds discussion_arena when phase===planning AND forced", () => {
	const api = createApiStub() as unknown as ExtensionAPI;
	const ctx = createContextStub() as unknown as ExtensionContext;

	attachDiscussionArenaHooks(api, ctx, FORCED);

	// Simulate unit_start event for planning phase
	const apiStub = api as any as ExtensionAPIStub;
	apiStub.callHook("unit_start", { unitType: "planning" });

	// Simulate adjust_tool_set event
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
		"discussion_arena should be added when phase===planning AND forced",
	);
});

test("(2) adjust_tool_set: excludes discussion_arena when available-only", () => {
	const api = createApiStub() as unknown as ExtensionAPI;
	const ctx = createContextStub() as unknown as ExtensionContext;

	attachDiscussionArenaHooks(api, ctx, AVAILABLE_ONLY);

	// Simulate unit_start event for planning phase
	const apiStub = api as any as ExtensionAPIStub;
	apiStub.callHook("unit_start", { unitType: "planning" });

	// Simulate adjust_tool_set event
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

test("(3) adjust_tool_set: excludes discussion_arena during execution phase", () => {
	const api = createApiStub() as unknown as ExtensionAPI;
	const ctx = createContextStub() as unknown as ExtensionContext;

	attachDiscussionArenaHooks(api, ctx, FORCED);

	// Simulate unit_start event for execution phase (not planning)
	const apiStub = api as any as ExtensionAPIStub;
	apiStub.callHook("unit_start", { unitType: "execution" });

	// Simulate adjust_tool_set event
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
		"discussion_arena should NOT be added during execution phase, even when forced",
	);
});

test("(3) adjust_tool_set: excludes discussion_arena during verifying phase", () => {
	const api = createApiStub() as unknown as ExtensionAPI;
	const ctx = createContextStub() as unknown as ExtensionContext;

	attachDiscussionArenaHooks(api, ctx, FORCED);

	const apiStub = api as any as ExtensionAPIStub;
	apiStub.callHook("unit_start", { unitType: "verifying" });

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
		"discussion_arena should NOT be added during verifying phase",
	);
});

test("(3) adjust_tool_set: excludes discussion_arena during closeout phase", () => {
	const api = createApiStub() as unknown as ExtensionAPI;
	const ctx = createContextStub() as unknown as ExtensionContext;

	attachDiscussionArenaHooks(api, ctx, FORCED);

	const apiStub = api as any as ExtensionAPIStub;
	apiStub.callHook("unit_start", { unitType: "closeout" });

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
		"discussion_arena should NOT be added during closeout phase",
	);
});

test("(4) before_agent_start: prompt instruction contains marker", () => {
	const api = createApiStub() as unknown as ExtensionAPI;
	const ctx = createContextStub() as unknown as ExtensionContext;

	attachDiscussionArenaHooks(api, ctx, FORCED);

	// Simulate unit_start event for planning phase
	const apiStub = api as any as ExtensionAPIStub;
	apiStub.callHook("unit_start", { unitType: "planning" });

	// Simulate before_agent_start event
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
			"<!-- gsd-pi-discussion-arena-planning-instruction -->",
		),
		"marker should be present in returned systemPrompt",
	);
	assert.ok(
		result?.systemPrompt?.includes("Usa discussion_arena"),
		"instruction text should be present in returned systemPrompt",
	);
});

test("(5) before_agent_start: repeated calls do not duplicate instruction (marker-based)", () => {
	const api = createApiStub() as unknown as ExtensionAPI;
	const ctx = createContextStub() as unknown as ExtensionContext;

	attachDiscussionArenaHooks(api, ctx, FORCED);

	const apiStub = api as any as ExtensionAPIStub;
	apiStub.callHook("unit_start", { unitType: "planning" });

	const handler = (apiStub.hooks as any).get("before_agent_start");

	// First call
	const beforeEvent1 = {
		type: "before_agent_start",
		prompt: "User prompt",
		systemPrompt: "Original system prompt.",
		systemPromptOptions: {} as any,
	};
	const result1 = handler(beforeEvent1);
	const afterFirst = result1!.systemPrompt!;

	// Second call (repeated) — pass the already-modified prompt
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

	// Count occurrences of the marker
	const markerCount = (
		afterSecond.match(/<!-- gsd-pi-discussion-arena-planning-instruction -->/g) || []
	).length;
	assert.equal(
		markerCount,
		1,
		"marker should appear exactly once, not twice",
	);
});

test("before_agent_start: does not append during available-only", () => {
	const api = createApiStub() as unknown as ExtensionAPI;
	const ctx = createContextStub() as unknown as ExtensionContext;

	attachDiscussionArenaHooks(api, ctx, AVAILABLE_ONLY);

	const apiStub = api as any as ExtensionAPIStub;
	apiStub.callHook("unit_start", { unitType: "planning" });

	const beforeEvent = {
		type: "before_agent_start",
		prompt: "User prompt",
		systemPrompt: "Original system prompt.",
		systemPromptOptions: {} as any,
	};
	const handler = (apiStub.hooks as any).get("before_agent_start");
	const result = handler(beforeEvent);

	assert.ok(
		result === undefined,
		"should return undefined (no modification) when available-only",
	);
});

test("before_agent_start: does not append during execution phase", () => {
	const api = createApiStub() as unknown as ExtensionAPI;
	const ctx = createContextStub() as unknown as ExtensionContext;

	attachDiscussionArenaHooks(api, ctx, FORCED);

	const apiStub = api as any as ExtensionAPIStub;
	apiStub.callHook("unit_start", { unitType: "execution" });

	const beforeEvent = {
		type: "before_agent_start",
		prompt: "User prompt",
		systemPrompt: "Original system prompt.",
		systemPromptOptions: {} as any,
	};
	const handler = (apiStub.hooks as any).get("before_agent_start");
	const result = handler(beforeEvent);

	assert.ok(
		result === undefined,
		"should return undefined (no modification) during execution phase",
	);
});

test("adjust_tool_set: does not remove existing tools", () => {
	const api = createApiStub() as unknown as ExtensionAPI;
	const ctx = createContextStub() as unknown as ExtensionContext;

	attachDiscussionArenaHooks(api, ctx, FORCED);

	const apiStub = api as any as ExtensionAPIStub;
	apiStub.callHook("unit_start", { unitType: "planning" });

	const adjustEvent = {
		type: "adjust_tool_set",
		selectedModelApi: "test",
		selectedModelProvider: "test",
		selectedModelId: "test-model",
		activeToolNames: ["existing_tool_1", "existing_tool_2"],
		filteredTools: ["existing_tool_1", "existing_tool_2"],
	};
	const handler = (apiStub.hooks as any).get("adjust_tool_set");
	const result = handler(adjustEvent);

	assert.ok(
		result?.toolNames?.includes("existing_tool_1"),
		"existing_tool_1 should not be removed",
	);
	assert.ok(
		result?.toolNames?.includes("existing_tool_2"),
		"existing_tool_2 should not be removed",
	);
	assert.ok(
		result?.toolNames?.includes("discussion_arena"),
		"discussion_arena should be added",
	);
	assert.equal(
		result?.toolNames?.length,
		3,
		"exactly 3 tools after addition",
	);
});

test("adjust_tool_set: does not add discussion_arena twice", () => {
	const api = createApiStub() as unknown as ExtensionAPI;
	const ctx = createContextStub() as unknown as ExtensionContext;

	attachDiscussionArenaHooks(api, ctx, FORCED);

	const apiStub = api as any as ExtensionAPIStub;
	apiStub.callHook("unit_start", { unitType: "planning" });

	const adjustEvent = {
		type: "adjust_tool_set",
		selectedModelApi: "test",
		selectedModelProvider: "test",
		selectedModelId: "test-model",
		activeToolNames: ["discussion_arena"],
		filteredTools: ["discussion_arena"],
	};
	const handler = (apiStub.hooks as any).get("adjust_tool_set");
	const result = handler(adjustEvent);

	const count = (result?.toolNames || []).filter(
		(t: string) => t === "discussion_arena",
	).length;
	assert.equal(
		count,
		1,
		"discussion_arena should appear exactly once, not duplicated",
	);
});

// ---------------------------------------------------------------------------
// M010/S02/T03 — NOTA: la coesistenza cross-marker dei 6 gruppi arena è
// testata esaustivamente in `tests/group-eligibility.test.ts` blocco (c).
// Per evitare duplicazione + dipendenza da `require()` runtime (non
// disponibile in ESM), questo file NON duplica i test cross-marker.
// ---------------------------------------------------------------------------
