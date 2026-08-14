/**
 * tests/integration/hooks-coexist.test.ts — Coesistenza di hooks-planning e
 * hooks-research dopo il cablaggio in index.ts (S08/M008, T02).
 *
 * Dimostra che registrare sullo STESSO api sia attachDiscussionArenaHooks
 * (unit_type planning, senza sink stderr) sia attachResearchDecisionHooks
 * (unit_type research-decision, con sink stderr) — esattamente come fa
 * activate() in index.ts dopo la risoluzione del trigger — non produce race
 * né doppia iniezione: ogni closure unit-aware resta attiva SOLO sul proprio
 * unit_type e gli eventi vengono dispatchati a tutti gli hook registrati.
 *
 * Contratto di integrazione verificato (sequenza reale: planning →
 * research-decision → executing):
 *   - planning: discussion_arena nel toolset + istruzione PLANNING (marker
 *     planning), MAI il marker research; nessun log forced (planning non usa
 *     sink stderr);
 *   - research-decision: discussion_arena nel toolset + istruzione RESEARCH
 *     (marker research), MAI il marker planning; log stderr strutturato
 *     forced su unit_start;
 *   - executing (unit estraneo): nessun hook inietta → toolset di default
 *     invariato (discussion_arena assente, `changed === false`).
 *
 * Puro, nessun I/O subprocess: usa uno stub di ExtensionAPI che dispatcha
 * ogni evento a tutti gli handler registrati (comportamento reale dell'api)
 * e compone i valori di ritorno (adjust_tool_set → toolNames,
 * before_agent_start → systemPrompt) come il framework.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { Writable } from "node:stream";
import { attachDiscussionArenaHooks } from "../../src/hooks-planning.js";
import { attachResearchDecisionHooks } from "../../src/hooks-research.js";
import {
	PLANNING_INSTRUCTION_MARKER,
	RESEARCH_INSTRUCTION_MARKER,
} from "../../src/markers.js";
import type { ResolveTriggerOutput } from "../../trigger-resolver.js";

const FORCED: ResolveTriggerOutput = {
	decision: "forced",
	source: "coordination",
	warnings: [],
	parseErrors: [],
};

interface CoexistHarness {
	state: {
		lastTools: string[];
		lastChanged: boolean;
		lastPrompts: string[];
	};
	stderrLines: string[];
	emit: (eventName: string, payload: Record<string, unknown>) => void;
}

/**
 * Registra in parallelo entrambi i moduli su uno stesso api (come activate() in
 * index.ts) e costruisce un dispatcher che inoltra ogni evento a OGNI handler
 * registrato, componendo i risultati come il framework:
 *   - adjust_tool_set  → lastTools/lastChanged (toolNames dell'ultimo handler
 *     che agisce, oppure invariato-se nessuno);
 *   - before_agent_start → ultimo systemPrompt ritornato.
 */
function wireBothHooks(): CoexistHarness {
	const state: CoexistHarness["state"] = {
		lastTools: [],
		lastChanged: false,
		lastPrompts: [],
	};
	const handlers = new Map<
		string,
		((event: Record<string, unknown>) => unknown)[]
	>();
	const stderrLines: string[] = [];
	const stderr = new Writable({
		write(chunk, _enc, cb) {
			stderrLines.push(String(chunk));
			cb();
		},
	});
	const ctx = { cwd: "/tmp/coexist" };

	const api = {
		on(eventName: string, handler: (event: Record<string, unknown>) => unknown) {
			const list = handlers.get(eventName) ?? [];
			list.push(handler);
			handlers.set(eventName, list);
			return {};
		},
	};
	// Stessa sequenza/argomenti di activate() in index.ts: planning senza
	// stderr, research-decision con process.stderr.
	attachDiscussionArenaHooks(api as never, ctx as never, FORCED);
	attachResearchDecisionHooks(api as never, ctx as never, FORCED, stderr);

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
			state.lastTools = finalTools ?? [...(payload.activeToolNames as string[])];
			state.lastChanged = finalTools !== undefined;
		}
		if (eventName === "before_agent_start") {
			state.lastPrompts.push(finalSystemPrompt ?? (payload.systemPrompt as string));
		}
	}

	return { state, stderrLines, emit };
}

const TOOLS_A = ["a", "b"];

test("coesistenza planning→research-decision→executing: toolset e prompt distinti, log solo per research effect", () => {
	const { emit, state, stderrLines } = wireBothHooks();

	// 1) planning: attivo solo l'hook planning.
	emit("unit_start", { unitType: "planning" });
	emit("adjust_tool_set", { activeToolNames: TOOLS_A });
	emit("before_agent_start", { prompt: "p", systemPrompt: "Original.", systemPromptOptions: {} });

	assert.deepEqual(state.lastTools, ["a", "b", "discussion_arena"], "planning aggiunge discussion_arena");
	assert.ok(state.lastChanged, "planning ha modificato il toolset");
	const promptPlan = state.lastPrompts[0] ?? "";
	assert.ok(promptPlan.includes(PLANNING_INSTRUCTION_MARKER), "marker planning nel prompt");
	assert.ok(!promptPlan.includes(RESEARCH_INSTRUCTION_MARKER), "nessun marker research nel prompt planning");
	assert.equal(
		stderrLines.length,
		0,
		"planning non emette log su stderr (attach senza sink)",
	);

	// 2) research-decision: planning dorme, research effect attivo.
	emit("unit_start", { unitType: "research-decision" });
	emit("adjust_tool_set", { activeToolNames: TOOLS_A });
	emit("before_agent_start", {
		prompt: "p",
		systemPrompt: "Original 2.",
		systemPromptOptions: {},
	});

	assert.deepEqual(state.lastTools, ["a", "b", "discussion_arena"], "research-decision aggiunge discussion_arena");
	assert.ok(state.lastChanged, "research-decision ha modificato il toolset");
	const promptResearch = state.lastPrompts[1] ?? "";
	assert.ok(promptResearch.includes(RESEARCH_INSTRUCTION_MARKER), "marker research nel prompt");
	assert.ok(!promptResearch.includes(PLANNING_INSTRUCTION_MARKER), "nessun marker planning nel prompt research");
	assert.ok(
		stderrLines.some((l) =>
			l.includes("[discussion-arena] hook: research-decision forced su unit_start"),
		),
		"log stderr strutturato su research-decision forced unit_start",
	);

	// 3) unit estraneo: nessun hook agisce → toolset di default invariato.
	emit("unit_start", { unitType: "executing" });
	emit("adjust_tool_set", { activeToolNames: TOOLS_A });

	assert.equal(state.lastChanged, false, "nessun hook modifica il toolset fuori dagli unit_type attivi");
	assert.deepEqual(state.lastTools, TOOLS_A, "toolset di default invariato");
	const cnt = state.lastTools.filter((t) => t === "discussion_arena").length;
	assert.equal(cnt, 0, "discussion_arena assente fuori dagli unit_type attivi");

	// L'idempotenza di ciascun hook garantisce discussion_arena ESATTAMENTE
	// una volta nel toolset di ogni unit_type attivo (mai doppio append).
	assert.deepEqual(
		state.lastTools.filter((t) => t === "discussion_arena"),
		[],
		"nel contesto executing nessuna iniezione duplicata",
	);
});