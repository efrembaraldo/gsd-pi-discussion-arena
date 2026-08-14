/**
 * Integration test: M007/S02/T03 — round-trip write→read coordination file.
 *
 * Esercita il path completo, dal wizard TUI al trigger-resolver, senza stub di
 * filesystem:
 *
 *     wizard.attachDiscussionArenaWizard
 *       → writePreferences (writer REALE, binding di index.ts:
 *         writeCoordinationActivation)
 *       → coordination file `.gsd/discussion-arena/discussion-arena-coordination.md`
 *       → resolveTrigger (Tier 2 canonico, source=coordination)
 *
 * Casi coperti:
 *   (1) always-on: wizard → coordination file auto-creato con
 *       `activation.enabled: true` → resolveTrigger = forced/coordination.
 *   (2) per-milestone: wizard scrive `activation.milestones.<id>.enabled`
 *       → resolveTrigger(<id>) = forced/coordination; id diverso = fallback.
 *   (3) conflict merge: coordination file esistente con `rounds_default: 3`,
 *       wizard scrive activation → il file risultante preserva rounds_default e
 *       c'è anche il blocco activation. Verifica anche che `loadDiscussionArenaCoordination`
 *       legga entrambi (roundsDefault=3, activation.enabled=true) e che
 *       `resolveTrigger` forzi con source=coordination.
 *   (4) osservabilità: il writer reale emette su stderr il log canonico
 *       `[discussion-arena] wizard wrote activation to path <path>`, e
 *       `resolveTriggerWithLogging` emette
 *       `[discussion-arena] trigger resolved: decision=forced source=coordination`.
 *   (5) idempotenza del round-trip: due invocazioni dello stesso wizard
 *       producono lo stesso coordination file (no duplicazioni di blocco).
 */
import "../ts-esm-loader.mjs";
import * as assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { WizardWriteTarget } from "../../src/tui-wizard.js";
import { resolveTrigger, resolveTriggerWithLogging } from "../../trigger-resolver.js";
import {
	loadDiscussionArenaCoordination,
	DISCUSSION_ARENA_COORDINATION_DIR,
	DISCUSSION_ARENA_COORDINATION_FILENAME,
} from "../../src/discussion-arena-coordination.js";
const { attachDiscussionArenaWizard } = await import("../../src/tui-wizard.js");
const { writeCoordinationActivation } = await import("../../src/preferences-writer.js");

/** Path canonico del coordination file derivato da `cwd` (stesse costanti di
 * `src/discussion-arena-coordination.ts`, usate da index.ts). */
function coordinationPathFromCwd(cwd: string): string {
	return path.join(
		cwd,
		DISCUSSION_ARENA_COORDINATION_DIR,
		DISCUSSION_ARENA_COORDINATION_FILENAME,
	);
}

/**
 * Writer reale con il wiring di produzione (index.ts): deriva il path canonico
 * dal `target.cwd`, scrive via `writeCoordinationActivation`, e logga su stderr
 * quando il file cambia. Ricostruito qui cosí il round-trip di integrazione usa
 * lo stesso codice che gira in produzione, non uno stub.
 */
async function realWrite(target: WizardWriteTarget): Promise<void> {
	const coordPath = coordinationPathFromCwd(target.cwd);
	const res = await writeCoordinationActivation(coordPath, {
		mode: target.mode,
		milestoneId: target.milestoneId,
	});
	if (res.changed) {
		process.stderr.write(
			`[discussion-arena] wizard wrote activation to path ${coordPath}\n`,
		);
	}
}

async function makeTmpCwd(): Promise<string> {
	return await fsp.mkdtemp(path.join(os.tmpdir(), "wizard-roundtrip-"));
}

/** Api stub minimale (stesso contratto di tui-wizard.test.ts). */
interface ApiStub {
	on(eventName: string, handler: (event: any, ctx: any) => any): void;
	milestoneStartHandler: ((event: any, ctx: any) => Promise<any>) | null;
}
function createApiStub(): ApiStub {
	const stub: ApiStub = {
		on: (_eventName, handler) => {
			if (_eventName === "milestone_start") stub.milestoneStartHandler = handler;
		},
		milestoneStartHandler: null,
	};
	return stub;
}

interface UiStub {
	select(
		title: string,
		options: readonly string[],
	): Promise<string | string[] | undefined>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	notify(message: string): Promise<void>;
	selectCalls: number;
	inputCalls: number;
	notifyCalls: string[];
}
function makeUi(result: { select?: string; input?: string }): UiStub {
	return {
		selectCalls: 0,
		inputCalls: 0,
		notifyCalls: [],
		async select(_t, _o) {
			this.selectCalls++;
			return result.select;
		},
		async input(_t, _p) {
			this.inputCalls++;
			return result.input;
		},
		async notify(m) {
			this.notifyCalls.push(m);
		},
	};
}

/** Semplifica l'invocazione del milestone_start handler con un TUI finto. */
async function runMilestoneStart(
	handler: (event: any, ctx: any) => Promise<any>,
	opts: { cwd: string; ui: UiStub; milestoneId?: string },
): Promise<void> {
	const event = {
		type: "milestone_start",
		milestoneId: opts.milestoneId ?? "M002",
		cwd: opts.cwd,
	};
	await handler(event, { cwd: opts.cwd, hasUI: true, ui: opts.ui });
}

/** Esegue `fn` restituendo lo stderr concettato e il valore di ritorno di fn. */
async function withStderr<T>(fn: () => Promise<T>): Promise<{ err: string; out: T }> {
	const stderr = process.stderr as unknown as { write: (c: string) => boolean };
	const original = stderr.write;
	let buf = "";
	stderr.write = (c: string) => {
		buf += String(c);
		return true;
	};
	try {
		const out = await fn();
		return { err: buf, out };
	} finally {
		stderr.write = original;
	}
}

test("round-trip always-on: wizard → coordination file → resolveTrigger forced/coordination", async () => {
	const cwd = await makeTmpCwd();
	try {
		const api = createApiStub();
		attachDiscussionArenaWizard(api as any, { cwd, hasUI: true } as any, realWrite);
		assert.ok(api.milestoneStartHandler, "milestone_start handler registrato");

		await runMilestoneStart(api.milestoneStartHandler!, {
			cwd,
			ui: makeUi({ select: "always-on" }),
		});

		// 1) File creato (auto-create) nel path canonico.
		const coordPath = coordinationPathFromCwd(cwd);
		const content = await fsp.readFile(coordPath, "utf-8");
		assert.match(content, /activation:/);
		assert.match(content, /enabled: true/);
		assert.match(
			content,
			/roles_virtuals:/,
			"auto-create minimo include roles_virtuals",
		);

		// 2) Il trigger-resolver legge lo stesso file → decision attesa.
		const resolved = await resolveTrigger({ cwd, milestoneId: "M002", env: {} });
		assert.strictEqual(resolved.decision, "forced");
		assert.strictEqual(resolved.source, "coordination");
		assert.deepEqual(resolved.parseErrors, []);
	} finally {
		await fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("round-trip per-milestone: id scritto forza; id diverso ricade su fallback", async () => {
	const cwd = await makeTmpCwd();
	try {
		const api = createApiStub();
		attachDiscussionArenaWizard(api as any, { cwd, hasUI: true } as any, realWrite);
		const ui = makeUi({ select: "per-milestone", input: "M007" });
		await runMilestoneStart(api.milestoneStartHandler!, { cwd, ui });
		assert.equal(ui.inputCalls, 1, "prompt per-milestone mostrato");

		// Il file contiene la chiave milestone con flag enabled.
		const content = await fsp.readFile(coordinationPathFromCwd(cwd), "utf-8");
		assert.match(content, /M007:\s*\n\s+enabled: true/);

		const forced = await resolveTrigger({ cwd, milestoneId: "M007", env: {} });
		assert.strictEqual(forced.decision, "forced");
		assert.strictEqual(forced.source, "coordination");

		// Milestone diverso → niente attivazione dedicata → Tier 3 fallback.
		const other = await resolveTrigger({ cwd, milestoneId: "M003", env: {} });
		assert.strictEqual(other.decision, "available-only");
		assert.strictEqual(other.source, "fallback");
	} finally {
		await fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("conflict merge: coordination esistente con rounds_default=3 preserva rounds_default e aggiunge activation", async () => {
	const cwd = await makeTmpCwd();
	try {
		// Pre-esistente: rounds_default=3, model_default. Niente activation.
		const coordPath = coordinationPathFromCwd(cwd);
		await fsp.mkdir(path.dirname(coordPath), { recursive: true });
		const preexisting = `---
rounds_default: 3
model_default: gpt-4o
roles_virtuals:
---
`;
		await fsp.writeFile(coordPath, preexisting, "utf-8");

		// Wizard scrive activation always-on.
		const api = createApiStub();
		attachDiscussionArenaWizard(api as any, { cwd, hasUI: true } as any, realWrite);
		await runMilestoneStart(api.milestoneStartHandler!, {
			cwd,
			ui: makeUi({ select: "always-on" }),
		});

		const final = await fsp.readFile(coordPath, "utf-8");

		// Entrambi i blocchi presenti.
		assert.match(final, /rounds_default: 3/, "rounds_default preservato");
		assert.match(final, /model_default: gpt-4o/, "model_default preservato");
		assert.match(final, /activation:\s*\n\s+enabled: true/, "activation presente");

		// Il loader del coordination file legge entrambe le sezioni.
		const loaded = loadDiscussionArenaCoordination(coordPath);
		assert.strictEqual(loaded.config.roundsDefault, 3, "rounds_default dal loader");
		assert.strictEqual(
			loaded.config.activation?.enabled,
			true,
			"activation.enabled dal loader",
		);
		assert.strictEqual(loaded.config.modelDefault, "gpt-4o");

		// Round-trip completo anche dopo il merge (Tier 2 canonico).
		const resolved = await resolveTrigger({ cwd, milestoneId: "M002", env: {} });
		assert.strictEqual(resolved.decision, "forced");
		assert.strictEqual(resolved.source, "coordination");
	} finally {
		await fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("round-trip idempotente: due invocazioni dello stesso wizard → stesso file, un solo blocco activation", async () => {
	const cwd = await makeTmpCwd();
	try {
		const api = createApiStub();
		attachDiscussionArenaWizard(api as any, { cwd, hasUI: true } as any, realWrite);
		for (let i = 0; i < 2; i++) {
			await runMilestoneStart(api.milestoneStartHandler!, {
				cwd,
				ui: makeUi({ select: "always-on" }),
			});
		}
		const content = await fsp.readFile(coordinationPathFromCwd(cwd), "utf-8");

		// Un solo frontmatter e un solo blocco activation, nessun residuo.
		assert.equal(
			(content.match(/^---$/gm) ?? []).length,
			2,
			"esattamente una coppia di fence --- (frontmatter non duplicato)",
		);
		assert.equal(
			(content.match(/activation:/g) ?? []).length,
			1,
			"un solo blocco activation",
		);
		assert.match(content, /activation:\s*\n {2}enabled: true/);

		const resolved = await resolveTrigger({ cwd, milestoneId: "M002", env: {} });
		assert.strictEqual(resolved.decision, "forced");
		assert.strictEqual(resolved.source, "coordination");
	} finally {
		await fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("osservabilità: stderr log wizard-scritto e trigger-resolved source=coordination", async () => {
	const cwd = await makeTmpCwd();
	try {
		const api = createApiStub();
		attachDiscussionArenaWizard(api as any, { cwd, hasUI: true } as any, realWrite);
		const { err: wizardErr } = await withStderr(async () => {
			await runMilestoneStart(api.milestoneStartHandler!, {
				cwd,
				ui: makeUi({ select: "always-on" }),
			});
		});
		assert.match(
			wizardErr,
			/\[discussion-arena\] wizard wrote activation to path .*discussion-arena-coordination\.md/,
			"stderr contiene il log del writer",
		);

		const { err: triggerErr, out } = await withStderr(async () =>
			resolveTriggerWithLogging({
				cwd,
				milestoneId: "M002",
				env: {},
				stderr: process.stderr,
			}),
		);
		assert.strictEqual(out.decision, "forced");
		assert.strictEqual(out.source, "coordination");
		assert.match(
			triggerErr,
			/\[discussion-arena\] trigger resolved: decision=forced source=coordination/,
			"stderr contiene il log di risoluzione",
		);
	} finally {
		await fs.rmSync(cwd, { recursive: true, force: true });
	}
});