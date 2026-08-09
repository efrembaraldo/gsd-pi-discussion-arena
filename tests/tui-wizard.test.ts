/**
 * Unit tests for src/tui-wizard.ts
 *
 * Covers the milestone_start TUI wizard decision logic:
 *   (1) wizard shown only when hasUI === true
 *   (6) no-op + stderr diagnostic when hasUI === false (CI/print)
 *   + per-milestone branch collects milestone ID and forwards it,
 *   + always-on / availability-only forward their mode,
 *   + cancellation (select undefined / empty ID) is a no-op + notify.
 *
 * The writer is injected and recorded, so no filesystem is touched.
 */

// Self-sufficiency: this static import registers the ESM hooks (`.js` -> `.ts`
// remap + @gsd/pi-coding-agent stub) so the file also runs under a bare
// `node --test <file>`, without the `--import ./tests/ts-esm-loader.mjs` flag
// that `npm test` normally adds. The src modules are read via dynamic imports
// below (resolved after hooks are registered).
import "./ts-esm-loader.mjs";
import * as assert from "node:assert/strict";
import { test } from "node:test";
import type { WizardWriteTarget } from "../src/tui-wizard.js";
const { attachArenaWizard, ARENA_WIZARD_OPTIONS } = await import(
	"../src/tui-wizard.js",
);

interface ApiStub {
	on(eventName: string, handler: (event: any, ctx: any) => any): void;
	milestoneStartHandler: ((event: any, ctx: any) => Promise<any>) | null;
}

function createApiStub(): ApiStub {
	const stub: ApiStub = {
		on(eventName, handler) {
			if (eventName === "milestone_start") {
				stub.milestoneStartHandler = handler;
			}
		},
		milestoneStartHandler: null,
	};
	return stub;
}

interface UiStub {
	selectCalls: Array<{ title: string; options: string[] }>;
	inputCalls: Array<{ title: string; placeholder: string | undefined }>;
	notifyCalls: string[];
	select(
		title: string,
		options: string[],
	): Promise<string | string[] | undefined>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	notify(message: string): Promise<void>;
}

function makeUi(result: {
	select?: string | string[] | undefined;
	input?: string | undefined;
}): UiStub {
	return {
		selectCalls: [],
		inputCalls: [],
		notifyCalls: [],
		async select(title: string, options: string[]) {
			this.selectCalls.push({ title, options });
			return result.select;
		},
		async input(title: string, placeholder: string | undefined) {
			this.inputCalls.push({ title, placeholder });
			return result.input;
		},
		async notify(message: string) {
			this.notifyCalls.push(message);
		},
	};
}

async function runHandler(
	handler: (event: any, ctx: any) => Promise<any>,
	opts: { hasUI: boolean; cwd?: string; milestoneId?: string; ui: UiStub },
): Promise<void> {
	const event = {
		type: "milestone_start",
		milestoneId: opts.milestoneId ?? "M002",
		cwd: opts.cwd ?? "/repo",
	};
	const ctx = {
		cwd: opts.cwd ?? "/repo",
		hasUI: opts.hasUI,
		ui: opts.ui,
	};
	await handler(event, ctx);
}

/** Capture stderr writes during `fn`; returns concatenated output. */
async function captureStderr(fn: () => Promise<void>): Promise<string> {
	const stderr = process.stderr as unknown as { write: (c: string) => boolean };
	const original = stderr.write;
	let buf = "";
	stderr.write = (c: string) => {
		buf += String(c);
		return true;
	};
	try {
		await fn();
	} finally {
		stderr.write = original;
	}
	return buf;
}

test("(1) installs a milestone_start handler", () => {
	const api = createApiStub();
	attachArenaWizard(api as any, { cwd: "/x", hasUI: true } as any, async () => {});
	assert.ok(api.milestoneStartHandler, "milestone_start handler should be registered");
});

test("(6) hasUI === false: no-op + stderr diagnostic, writer NOT called", async () => {
	const api = createApiStub();
	const writes: WizardWriteTarget[] = [];
	attachArenaWizard(api as any, { cwd: "/repo", hasUI: false } as any, async (t) => {
		writes.push(t);
	});
	const ui = makeUi({});
	const err = await captureStderr(async () => {
		await api.milestoneStartHandler!(
			{ type: "milestone_start", milestoneId: "M002", cwd: "/repo" },
			{ cwd: "/repo", hasUI: false, ui },
		);
	});
	assert.equal(writes.length, 0, "writer must not be called when hasUI=false");
	assert.ok(err.includes("hasUI=false"), "stderr should contain the hasUI=false diagnostic");
});

test("per-milestone: prompts for milestone ID and writes it", async () => {
	const api = createApiStub();
	const writes: WizardWriteTarget[] = [];
	attachArenaWizard(api as any, { cwd: "/repo" } as any, async (t) => {
		writes.push(t);
	});
	const ui = makeUi({ select: "per-milestone", input: "M007" });
	await runHandler(api.milestoneStartHandler!, {
		hasUI: true,
		cwd: "/repo",
		milestoneId: "M002",
		ui,
	});

	assert.equal(ui.selectCalls.length, 1);
	assert.deepEqual(ui.selectCalls[0]!.options, [...ARENA_WIZARD_OPTIONS]);
	assert.equal(ui.inputCalls.length, 1, "per-milestone should prompt for the milestone ID");
	assert.deepEqual(writes, [
		{ cwd: "/repo", mode: "per-milestone", milestoneId: "M007" },
	]);
	assert.ok(ui.notifyCalls.some((n) => n.includes("M007")));
});

test("always-on: no input prompt, writes mode always-on", async () => {
	const api = createApiStub();
	const writes: WizardWriteTarget[] = [];
	attachArenaWizard(api as any, { cwd: "/repo" } as any, async (t) => {
		writes.push(t);
	});
	const ui = makeUi({ select: "always-on", input: undefined });
	await runHandler(api.milestoneStartHandler!, {
		hasUI: true,
		cwd: "/repo",
		ui,
	});
	assert.equal(ui.inputCalls.length, 0, "always-on must not prompt for an ID");
	assert.deepEqual(writes, [
		{ cwd: "/repo", mode: "always-on", milestoneId: undefined },
	]);
});

test("availability-only: no input prompt, writes mode availability-only", async () => {
	const api = createApiStub();
	const writes: WizardWriteTarget[] = [];
	attachArenaWizard(api as any, { cwd: "/repo" } as any, async (t) => {
		writes.push(t);
	});
	const ui = makeUi({ select: "availability-only", input: undefined });
	await runHandler(api.milestoneStartHandler!, {
		hasUI: true,
		cwd: "/repo",
		ui,
	});
	assert.equal(ui.inputCalls.length, 0);
	assert.deepEqual(writes, [
		{ cwd: "/repo", mode: "availability-only", milestoneId: undefined },
	]);
});

test("cancelled select (undefined): no write, notify cancellation", async () => {
	const api = createApiStub();
	const writes: WizardWriteTarget[] = [];
	attachArenaWizard(api as any, { cwd: "/repo" } as any, async (t) => {
		writes.push(t);
	});
	const ui = makeUi({ select: undefined, input: undefined });
	await runHandler(api.milestoneStartHandler!, {
		hasUI: true,
		cwd: "/repo",
		ui,
	});
	assert.equal(writes.length, 0, "cancelled wizard must not write");
	assert.ok(ui.notifyCalls.some((n) => n.includes("annullata")));
});

test("per-milestone with empty ID: no write + notify", async () => {
	const api = createApiStub();
	const writes: WizardWriteTarget[] = [];
	attachArenaWizard(api as any, { cwd: "/repo" } as any, async (t) => {
		writes.push(t);
	});
	const ui = makeUi({ select: "per-milestone", input: "" });
	await runHandler(api.milestoneStartHandler!, {
		hasUI: true,
		cwd: "/repo",
		ui,
	});
	assert.equal(writes.length, 0);
	assert.ok(ui.notifyCalls.some((n) => n.includes("ID milestone mancante")));
});