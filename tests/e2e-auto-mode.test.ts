/**
 * E2E "auto-mode" integration test — S08-T01.
 *
 * Carica l'estensione REALE (`index.ts` — lo stesso modulo che registra
 * tool/hook nella runtime di gsd-pi) e, tramite uno stub di ExtensionAPI
 * controllato, simula il ciclo auto-mode che gsd-pi esegue su ogni unit:
 *   1. unit_start    con { unitType: "planning" } (e milestoneId "M002-test")
 *   2. adjust_tool_set
 * e asserisce che discussion_arena compaia / non compaia in result.toolNames
 * a seconda del tier di attivazione:
 *
 *   Tier 1 (forced via env)  — GSD_DISCUSSION_ARENA_AUTO=1  → **in** toolNames
 *   Tier 2 (forced via prefs)— PREFERENCES.md milestone     → **in** toolNames
 *   Tier 3 (fallback)        — nessuna delle due             → **NOT** in
 *
 * Non lancia mai un subprocess gsd-pi reale (per D022: costo dei test di
 * integrazione). La dipendenza runtime `@gsd/pi-coding-agent` è coperta dallo
 * stub self-contained tests/fixtures/pi-coding-agent-stub.ts, come il resto
 * della suite. Il cwd di ogni scenario è una tmpdir con la fixture dei
 * partecipanti "echo" (mock, senza rete).
 *
 * Il test è auto-sufficiente: registra il loader ESM (tests/ts-esm-loader.mjs)
 * a inizio modulo così è eseguibile anche come `node --test
 * tests/e2e-auto-mode.test.ts` SENZA il flag `--import`. L'import dell'
 * estensione avviene per via dinamica DOPO la registrazione ed è fatta a
 * directory della repo, prima di ogni chdir, così la risoluzione dello stub
 * (`@gsd/pi-coding-agent` → tests/fixtures/pi-coding-agent-stub.ts) resta
 * valida e non dipende dal tmpdir corrente.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

// ─── 1. Registrazione del loader ESM (idempotente sotto npm test / --import,
//      necessario per la run standalone) ────────────────────────────────────
const __projectRoot = process.cwd();
const loaderUrl = pathToFileURL(path.join(__projectRoot, "tests", "ts-esm-loader.mjs")).href;
try {
	register(loaderUrl, { parentURL: pathToFileURL(__projectRoot + "/").href });
} catch (err) {
	// Se il loader è già attivo (npm test via --import ts-esm-loader.mjs),
	// la re-registrazione può fallire: in quel caso continuiamo comunque
	// perché gli hook di risoluzione sono già presenti.
	const msg = err instanceof Error ? err.message : String(err);
	if (!/already|registered|duplicate/i.test(msg)) {
		throw err;
	}
}

// Import dell'estensione reale, PRIMA di ogni chdir, in modo che lo stub
// `@gsd/pi-coding-agent` venga risolto rispetto alla root della repo.
const extensionUrl = pathToFileURL(path.join(__projectRoot, "index.ts")).href;
const mod = await import(extensionUrl);
const activate = (mod as unknown as { default: (api: unknown) => void }).default;

// ─── 2. Stub di ExtensionAPI ───────────────────────────────────────────────
interface HookRegistry {
	on: (eventName: string, handler: (event: any) => unknown) => void;
}

/** Stub di ExtensionAPI: registra hook/tool/command e permette di invocarli. */
function makeApi() {
	const hooks = new Map<string, Array<(event: any) => unknown>>();
	const tools: string[] = [];
	const commands: string[] = [];
	const api: HookRegistry & Record<string, unknown> = {
		on: (eventName, handler) => {
			const list = hooks.get(eventName) ?? [];
			list.push(handler);
			hooks.set(eventName, list);
		},
		registerTool: (cfg: { name?: string }) => {
			if (cfg?.name) tools.push(cfg.name);
			return {};
		},
		registerCommand: (name: string) => {
			commands.push(name);
			return {};
		},
	};
	return { api, hooks, tools, commands };
}

type Api = ReturnType<typeof makeApi>;

async function waitForHook(api: Api, eventName: string, timeoutMs = 3000): Promise<void> {
	const { hooks } = api;
	const t0 = Date.now();
	while (!hooks.has(eventName)) {
		if (Date.now() - t0 > timeoutMs) {
			throw new Error(`hook "${eventName}" non registrato entro ${timeoutMs}ms`);
		}
		// activate() registra gli hook in modo asincrono (resolveTrigger è
		// async). Polling leggero fino a quando d.on non viene chiamato.
		await new Promise((r) => setTimeout(r, 5));
	}
	return;
}

/** Simula unit_start + adjust_tool_set e restituisce result.toolNames. */
function simulatePlanningAdjustToolSet(api: Api): string[] | null {
	const { hooks } = api;
	// Dispatch a TUTTI gli hook registrati (come l'api reale, che inoltra ogni
	// evento a ogni listener): sia l'hook planning sia quello research-decision
	// (S08/T02) tracciano il proprio unit_type corrente.
	for (const unitStart of hooks.get("unit_start") ?? []) {
		unitStart({ unitType: "planning", milestoneId: "M002-test" });
	}

	const adjusts = hooks.get("adjust_tool_set") ?? [];
	if (adjusts.length === 0) {
		throw new Error("hook adjust_tool_set non registrato");
	}
	// Compone il result come il framework: toolNames dell'ultimo handler che
	// ritorna toolNames (gli hook non attivi ritornano undefined e non agiscono).
	let finalTools: string[] | undefined;
	for (const adjust of adjusts) {
		const result = adjust({
			selectedModelApi: "test",
			selectedModelProvider: "test",
			selectedModelId: "test-model",
			activeToolNames: ["read", "bash"],
			filteredTools: ["read", "bash"],
		}) as { toolNames?: string[] } | undefined;
		if (result && Array.isArray(result.toolNames)) finalTools = result.toolNames;
	}
	return finalTools ?? null;
}

/** Temp dir con la fixture dei partecipanti echo nel layout di progetto. */
function makeScenarioDir(): { dir: string; cleanup: () => void } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "discussion-arena-e2e-"));
	const partDir = path.join(dir, ".gsd", "discussion-arena", "participants");
	fs.mkdirSync(partDir, { recursive: true });
	fs.copyFileSync(
		path.join(__projectRoot, "tests", "fixtures", "echo-participants.md"),
		path.join(partDir, "echo-participants.md"),
	);
	return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Riporta cwd + env di discussion-arena a uno stato pulito. */
function resetEnv(cwd: string): void {
	process.chdir(cwd);
	delete process.env.GSD_DISCUSSION_ARENA_AUTO;
	delete process.env.GSD_MILESTONE_ID;
}

// ─── 3. Scenari ────────────────────────────────────────────────────────────

test("Tier 1 — GSD_DISCUSSION_ARENA_AUTO=1 drivers: discussion_arena in toolNames", async () => {
	const orig = process.cwd();
	const { dir, cleanup } = makeScenarioDir();
	try {
		process.env.GSD_DISCUSSION_ARENA_AUTO = "1";
		process.env.GSD_MILESTONE_ID = "M002-test";
		process.chdir(dir);

		const app = makeApi();
		activate(app.api);
		await waitForHook(app, "unit_start");

		const tools = simulatePlanningAdjustToolSet(app);
		assert.ok(tools, "adjust_tool_set deve ritornare toolNames");
		assert.ok(
			tools!.includes("discussion_arena"),
			"Tier 1 forced: discussion_arena deve essere in toolNames",
		);
		assert.ok(tools!.includes("read"), "gli altri tool non devono sparire");
	} finally {
		resetEnv(orig);
		cleanup();
	}
});

test("Tier 2 PREFERENCES: milestone abilitato in PREFERENCES.md → in toolNames", async () => {
	const orig = process.cwd();
	const { dir, cleanup } = makeScenarioDir();
	try {
		// Nessuna env var di forced: il tier decide da PREFERENCES.md.
		delete process.env.GSD_DISCUSSION_ARENA_AUTO;
		process.env.GSD_MILESTONE_ID = "M002-test";
		// PREFERENCES.md con il milestone M002-test abilitato
		const prefsDir = path.join(dir, ".gsd");
		fs.mkdirSync(prefsDir, { recursive: true });
		fs.writeFileSync(
			path.join(prefsDir, "PREFERENCES.md"),
			[
				"---",
				"discussion_arena:",
				"  milestones:",
				"    M002-test:",
				"      enabled: true",
				"---",
				"",
			].join("\n"),
		);
		process.chdir(dir);

		const app = makeApi();
		activate(app.api);
		await waitForHook(app, "unit_start");

		const tools = simulatePlanningAdjustToolSet(app);
		assert.ok(
			tools!.includes("discussion_arena"),
			"Tier 2 (PREFERENCES): discussion_arena deve essere in toolNames",
		);
	} finally {
		resetEnv(orig);
		cleanup();
	}
});

test("Tier 3 fallback (né env né PREFERENCES): discussion_arena NON in toolNames", async () => {
	const orig = process.cwd();
	const { dir, cleanup } = makeScenarioDir();
	try {
		delete process.env.GSD_DISCUSSION_ARENA_AUTO;
		process.env.GSD_MILESTONE_ID = "M002-test";
		// nessun .gsd/PREFERENCES.md
		process.chdir(dir);

		const app = makeApi();
		activate(app.api);
		await waitForHook(app, "unit_start");

		const tools = simulatePlanningAdjustToolSet(app);
		// resolveTrigger → "available-only". discussione non forzata: il tool NON
		// viene aggiunto ad activeToolNames. E quest'ancora i tool originali.
		assert.equal(tools, null, "fallback: adjust_tool_set non deve forzare toolNames");
	} finally {
		resetEnv(orig);
		cleanup();
	}
});