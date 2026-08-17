/**
 * tests/hooks-coexist-multigroup.test.ts — Forcing simultaneo dei 3 gruppi
 * `planning` + `research-decision` + `discussing` sullo stesso ExtensionAPI
 * (M010/S06/T01).
 *
 * Chiude il contratto di coesistenza behavioral dei 6 gruppi discussion-arena
 * (introdotto in M010/S02) con il caso peggiore di forcing 3-gruppo
 * simultaneo: planning + research-decision + discussing, esercitando
 * end-to-end TUTTI e 4 gli hook che `attachUnitAwareHooks` registra
 * (`src/hooks-unit-aware.ts`):
 *
 *   1. `unit_start`         — traccia currentUnitType (state machine per-api
 *                             singleton via WeakMap `currentUnitTypeByApi`).
 *   2. `adjust_tool_set`    — aggiunge `discussion_arena` al toolset se
 *                             `isActive()` (decision=forced E
 *                             currentUnitType ∈ activeUnitTypes).
 *   3. `before_agent_start` — appende l'istruzione marker-based al
 *                             systemPrompt, idempotente via marker check;
 *                             emette `discussionArena.forced` NDJSON +
 *                             incrementa `discussion_arena_forced_total{phase}`
 *                             (D087, D088).
 *   4. `tool_call`          — osservatore on-demand, registrato UNA sola
 *                             volta per api (WeakMap
 *                             `toolCallListenerByApi`, D107: NO over-count
 *                             multi-marker); emette `discussionArena.on_demand`
 *                             NDJSON + incrementa
 *                             `discussion_arena_on_demand_total{phase}`.
 *
 * Quattro assertion verdi, una per hook (A1–A4), ciascuna in un
 * `test()` dedicato per failure diagnostics più nitidi. Tutti i test
 * condividono lo stesso pattern di wire-up (3 wrapper pubblici
 * `attachDiscussionArenaHooks` + `attachResearchDecisionHooks` +
 * `attachDiscussingHooks` sullo stesso `api` con `decision=forced`,
 * esattamente come `activate()` in `index.ts`) e lo stesso dispatcher
 * (inoltro a TUTTI gli handler, overwrite-last-wins su
 * `toolNames`/`systemPrompt`, identico a `tests/hooks-unit-aware.test.ts`).
 *
 * NON si sovrappone a `tests/integration/adjust-tool-set-idempotency.test.ts`
 * (M010/S03): quel file copre SOLO l'hook `adjust_tool_set` con
 * P1 (union 3-gruppo), P2 (idempotenza inject su N emits), P3
 * (no-regression fuori dai 6 gruppi), P4 (idempotenza registrazione stesso
 * marker). Questo file copre i restanti 3 hook (`unit_start`,
 * `before_agent_start`, `tool_call`) più l'integrazione end-to-end
 * 4 hook × 3 gruppi, che è esattamente la matrice di copertura che
 * S03/T02 ha lasciato scoperta.
 */

import { beforeEach, test } from "node:test";
import * as assert from "node:assert/strict";

import { attachDiscussionArenaHooks } from "../src/hooks-planning.js";
import { attachResearchDecisionHooks } from "../src/hooks-research.js";
import { attachDiscussingHooks } from "../src/hooks-discussing.js";
import {
	DISCUSSING_INSTRUCTION_MARKER,
	PLANNING_INSTRUCTION_MARKER,
	RESEARCH_INSTRUCTION_MARKER,
} from "../src/markers.js";
import { getMetrics, resetMetrics } from "../metrics.js";
import type { ResolveTriggerOutput } from "../trigger-resolver.js";

// ─── Fixture condivise ───────────────────────────────────────────────────

/**
 * `resolveTrigger` valido per ogni gruppo della discussion arena (decisione
 * forced). Tier/capabilities/groupEligibility espliciti per soddisfare i
 * campi richiesti da `ResolveTriggerOutput` v2 (S01/M010).
 */
const FORCED: ResolveTriggerOutput = {
	decision: "forced",
	source: "env",
	warnings: [],
	parseErrors: [],
	tier: "A",
	capabilities: new Set(),
	groupEligibility: null,
};

/** Toolset di base per gli assert (non contiene `discussion_arena`). */
const BASE_TOOLS = ["a", "b"] as const;

/** Letterale della costante `UNIT_AWARE_TOOL_NAME` di `hooks-unit-aware.ts`. */
const D_DISCUSSION_ARENA = "discussion_arena" as const;

/** Unit-type rappresentativi per i 3 gruppi di forcing simultaneo. */
const PLAN_UNIT = "planning" as const;
const RD_UNIT = "research-decision" as const;
const DISC_UNIT = "discuss-milestone" as const;

/**
 * Cattura `process.stderr.write` per la durata di `fn`. `emitStructuredLog` è
 * sincrono, quindi la cattura copre TUTTE le righe NDJSON emesse durante
 * `fn`. Restituisce i chunk come stringhe (alcuni chunk possono contenere
 * più righe concatenate; per il filtro NDJSON basta un `String#includes`).
 */
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

interface MultiGroupHarness {
	state: {
		lastTools: string[];
		lastChanged: boolean;
		lastPrompts: string[];
	};
	/** Conteggio degli handler registrati per ogni evento. */
	handlerCount: Record<string, number>;
	emit: (eventName: string, payload: Record<string, unknown>) => void;
}

/**
 * Registra i 3 wrapper pubblici sullo stesso `api` (planning +
 * research-decision + discussing, decisione forced), come fa `activate()`
 * in `index.ts`. Costruisce un dispatcher che:
 *   - inoltra ogni evento a TUTTI gli handler registrati;
 *   - per `adjust_tool_set` compone i toolNames dall'ultimo handler che
 *     agisce (overwrite-last-wins — identico al pattern di
 *     `tests/hooks-unit-aware.test.ts`);
 *   - per `before_agent_start` compone i systemPrompt dall'ultimo handler
 *     che agisce (idem);
 *   - tiene traccia del numero di handler registrati per ogni evento
 *     (per asserire la cardinalità listener `tool_call` = 1 e i 3
 *     listener per i 3 hook unit-aware).
 *
 * NOTA — il listener `tool_call` viene registrato UNA sola volta per api
 * (`WeakMap` `toolCallListenerByApi` in `attachUnitAwareHooks`), quindi
 * dopo i 3 wrapper risulta esattamente 1 handler `tool_call`.
 */
function wireThreeGroups(): MultiGroupHarness {
	const handlers = new Map<
		string,
		((event: Record<string, unknown>) => unknown)[]
	>();
	const state: MultiGroupHarness["state"] = {
		lastTools: [],
		lastChanged: false,
		lastPrompts: [],
	};
	const handlerCount: Record<string, number> = {};
	const ctx = { cwd: "/tmp/multigroup" };

	const api = {
		on(eventName: string, handler: (event: Record<string, unknown>) => unknown) {
			const list = handlers.get(eventName) ?? [];
			list.push(handler);
			handlers.set(eventName, list);
			handlerCount[eventName] = list.length;
			return {};
		},
	};

	// Sequenza reale di activate() in index.ts: planning (no stderr),
	// research-decision (stderr opzionale), discussing (stderr opzionale).
	attachDiscussionArenaHooks(api as never, ctx as never, FORCED);
	attachResearchDecisionHooks(api as never, ctx as never, FORCED);
	attachDiscussingHooks(api as never, ctx as never, FORCED);

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
			state.lastPrompts.push(
				finalSystemPrompt ?? (payload.systemPrompt as string),
			);
		}
	}

	return { state, handlerCount, emit };
}

// Reset metriche singleton per isolare lo stato tra test (pattern standard
// prom-client, identico a `tests/hooks-unit-aware.test.ts`).
beforeEach(() => {
	resetMetrics();
});

// ─── A1 — unit_start × 3-gruppo: state machine per-api ─────────────────────

test("A1 unit_start × 3-gruppo (planning + research-decision + discussing): state machine per-api attiva correttamente il wrapper giusto per ogni unitType", () => {
	const { emit, state, handlerCount } = wireThreeGroups();

	// Sanity: 3 wrapper pubblici registrati → 3 handler `unit_start` sullo
	// stesso api (uno per marker distinto, idempotenza per-marker NON
	// scatta perché i 3 marker sono distinti: planning-instruction,
	// research-instruction, discussing-instruction).
	assert.equal(
		handlerCount["unit_start"],
		3,
		"3 handler unit_start registrati (uno per wrapper di gruppo, marker distinti)",
	);

	// Per ogni unitType rappresentativo del proprio gruppo, la state
	// machine `attachUnitAwareHooks` deve attivare il wrapper
	// corrispondente e produrre un toolset forzato con `discussion_arena`.
	// I 3 gruppi sono disgiunti per `activeUnitTypes`, quindi un solo
	// wrapper è `isActive` per unitType (vedi anche P1 di
	// `tests/integration/adjust-tool-set-idempotency.test.ts`).

	// (1) planning → wrapper planning attivo.
	emit("unit_start", { unitType: PLAN_UNIT });
	emit("adjust_tool_set", { activeToolNames: [...BASE_TOOLS] });
	assert.deepEqual(
		state.lastTools,
		[...BASE_TOOLS, D_DISCUSSION_ARENA],
		"planning: toolset forzato = base + discussion_arena (wrapper planning attivo)",
	);

	// (2) research-decision → wrapper research-decision attivo.
	emit("unit_start", { unitType: RD_UNIT });
	emit("adjust_tool_set", { activeToolNames: [...BASE_TOOLS] });
	assert.deepEqual(
		state.lastTools,
		[...BASE_TOOLS, D_DISCUSSION_ARENA],
		"research-decision: toolset forzato = base + discussion_arena (wrapper research-decision attivo)",
	);

	// (3) discuss-milestone → wrapper discussing attivo (uno dei 3 unitType
	// del gruppo discussing: discuss-milestone, discuss-project,
	// discuss-requirements).
	emit("unit_start", { unitType: DISC_UNIT });
	emit("adjust_tool_set", { activeToolNames: [...BASE_TOOLS] });
	assert.deepEqual(
		state.lastTools,
		[...BASE_TOOLS, D_DISCUSSION_ARENA],
		"discussing: toolset forzato = base + discussion_arena (wrapper discussing attivo)",
	);
});

// ─── A2 — adjust_tool_set × 3-gruppo: cardinalità discussion_arena = 1 ────

test("A2 adjust_tool_set × 3-gruppo (planning + research-decision + discussing): discussion_arena presente ESATTAMENTE 1 volta nel toolset finale (no over-count da cascata handler)", () => {
	const { emit, state, handlerCount } = wireThreeGroups();

	// Tutti e 3 i wrapper pubblici sono registrati sullo stesso api.
	// Per qualsiasi unitType al massimo 1 wrapper è `isActive` (i 3
	// `activeUnitTypes` sono disgiunti per costruzione), quindi
	// esattamente 1 handler restituisce toolNames non-undefined. La
	// guardia interna `if (!toolNames.includes(UNIT_AWARE_TOOL_NAME))` in
	// `attachUnitAwareHooks` mantiene cardinalità 1 anche se più handler
	// fossero attivi contemporaneamente (futuro-proofing).
	assert.equal(
		handlerCount["adjust_tool_set"],
		3,
		"3 handler adjust_tool_set registrati (uno per wrapper di gruppo)",
	);

	// Caso peggiore di forcing: tutti e 3 i wrapper sullo stesso api,
	// unitType di planning attivo. Verifica cardinalità = 1 del tool.
	emit("unit_start", { unitType: PLAN_UNIT });
	emit("adjust_tool_set", { activeToolNames: ["only-base"] });

	const daCount = state.lastTools.filter((t) => t === D_DISCUSSION_ARENA).length;
	assert.equal(
		daCount,
		1,
		"discussion_arena presente esattamente 1 volta nel toolset finale (cardinalità 1, no duplicato da cascata handler)",
	);
	assert.deepEqual(
		state.lastTools,
		["only-base", D_DISCUSSION_ARENA],
		"toolset finale = base + singolo discussion_arena (nessuna copia extra)",
	);
});

// ─── A3 — tool_call × 3-gruppo: no over-count multi-marker D107 ───────────

test("A3 tool_call × 3-gruppo (planning + research-decision + discussing): discussion_arena_on_demand_total incrementato ESATTAMENTE 1 volta (D107, no over-count multi-marker)", () => {
	const { emit, handlerCount } = wireThreeGroups();

	// Il listener `tool_call` è registrato UNA sola volta per api
	// (`WeakMap` `toolCallListenerByApi` in `attachUnitAwareHooks`),
	// indipendentemente dal numero di marker attivi. Quindi, dopo i 3
	// wrapper pubblici, il dispatcher ha esattamente 1 handler `tool_call`
	// — non 3.
	assert.equal(
		handlerCount["tool_call"],
		1,
		"ESATTAMENTE 1 handler tool_call nel dispatcher (idempotenza per-api, multi-marker no duplicati D107)",
	);

	// Prima invocazione di `discussion_arena`: counter incrementato di 1
	// (NON di 3, anche se 3 marker sono attivi).
	emit("unit_start", { unitType: PLAN_UNIT });
	captureStderrChunksSync(() => {
		emit("tool_call", {
			type: "tool_call",
			toolName: "discussion_arena",
			toolCallId: "tc-multigroup-1",
			input: {},
		});
	});

	const onDemand = getMetrics().counters["discussion_arena_on_demand_total"] ?? {};
	assert.equal(
		onDemand["{phase=planning}"],
		1,
		"discussion_arena_on_demand_total{phase=planning} = 1 dopo la 1ª invocazione (no over-count multi-marker, D107)",
	);

	// Il listener on-demand NON incrementa `discussion_arena_forced_total`
	// (hook `before_agent_start` indipendente da `tool_call`).
	assert.equal(
		getMetrics().counters["discussion_arena_forced_total"],
		undefined,
		"tool_call listener non incrementa discussion_arena_forced_total (osservatore puro)",
	);

	// Seconda invocazione: counter += 1 (totale = 2), confermando che
	// ogni call incrementa ESATTAMENTE di 1 — mai di 3.
	emit("tool_call", {
		type: "tool_call",
		toolName: "discussion_arena",
		toolCallId: "tc-multigroup-2",
		input: {},
	});
	assert.equal(
		getMetrics().counters["discussion_arena_on_demand_total"]?.["{phase=planning}"],
		2,
		"seconda invocazione: counter incrementato a 2 (UNA unit di increment per call, mai 3)",
	);
});

// ─── A4 — before_agent_start × 3-gruppo: forced counter + NDJSON stderr ───

test("A4 before_agent_start × 3-gruppo (planning + research-decision + discussing): discussion_arena_forced_total cardinalità label phase ≤ 7, 3 marker distinti iniettati, NDJSON discussionArena.forced emesso su stderr", () => {
	const { emit, state, handlerCount } = wireThreeGroups();

	assert.equal(
		handlerCount["before_agent_start"],
		3,
		"3 handler before_agent_start registrati (uno per wrapper di gruppo)",
	);

	// Sequenza di forcing simultaneo: 3 `before_agent_start` su 3 unitType
	// distinti (planning, research-decision, discuss-milestone), ciascuno
	// preceduto dal proprio `unit_start` per posizionare la state machine.
	// Risultato atteso:
	//   - 3 distinct `phase` labels nel counter `discussion_arena_forced_total`
	//     (planning, research-decision, discussing);
	//   - cardinalità label ≤ 7 (6 gruppi discussion_arena + sentinella `unknown`, D087);
	//   - 3 distinct marker iniettati (uno per gruppo);
	//   - 3 righe NDJSON `discussionArena.forced` emesse su stderr (una per
	//     forcing, D088: solo nel ramo di effettiva iniezione del marker).

	emit("unit_start", { unitType: PLAN_UNIT });
	captureStderrChunksSync(() => {
		emit("before_agent_start", {
			prompt: "p1",
			systemPrompt: "Orig-1.",
			systemPromptOptions: {},
		});
	});

	emit("unit_start", { unitType: RD_UNIT });
	captureStderrChunksSync(() => {
		emit("before_agent_start", {
			prompt: "p2",
			systemPrompt: "Orig-2.",
			systemPromptOptions: {},
		});
	});

	emit("unit_start", { unitType: DISC_UNIT });
	const chunks = captureStderrChunksSync(() => {
		emit("before_agent_start", {
			prompt: "p3",
			systemPrompt: "Orig-3.",
			systemPromptOptions: {},
		});
	});

	// (a) Cardinalità label `phase` di `discussion_arena_forced_total`:
	// esattamente 3 (planning + research-decision + discussing) e ≤ 7
	// (D087: 6 gruppi discussion_arena + sentinella unknown).
	const forced = getMetrics().counters["discussion_arena_forced_total"] ?? {};
	assert.equal(
		Object.keys(forced).length,
		3,
		"cardinalità label phase forced = 3 (planning + research-decision + discussing)",
	);
	assert.ok(
		Object.keys(forced).length <= 7,
		"cardinalità label phase forced <= 7 (D087: 6 gruppi discussion_arena + sentinella unknown)",
	);

	// (b) Counter per ogni gruppo = 1.
	assert.equal(
		forced["{phase=planning}"],
		1,
		"discussion_arena_forced_total{phase=planning} = 1",
	);
	assert.equal(
		forced["{phase=research-decision}"],
		1,
		"discussion_arena_forced_total{phase=research-decision} = 1",
	);
	assert.equal(
		forced["{phase=discussing}"],
		1,
		"discussion_arena_forced_total{phase=discussing} = 1",
	);

	// (c) 3 marker distinti nei 3 prompt (uno per gruppo).
	assert.ok(
		state.lastPrompts[0]?.includes(PLANNING_INSTRUCTION_MARKER),
		"prompt 1 (planning) contiene PLANNING_INSTRUCTION_MARKER",
	);
	assert.ok(
		state.lastPrompts[1]?.includes(RESEARCH_INSTRUCTION_MARKER),
		"prompt 2 (research-decision) contiene RESEARCH_INSTRUCTION_MARKER",
	);
	assert.ok(
		state.lastPrompts[2]?.includes(DISCUSSING_INSTRUCTION_MARKER),
		"prompt 3 (discussing) contiene DISCUSSING_INSTRUCTION_MARKER",
	);

	// (d) NDJSON `discussionArena.forced` emesso su stderr per ogni
	// forcing. La cattura finale copre solo il 3° forcing (le 2
	// precedenti sono già uscite dai chunk delle catture precedenti):
	// 1 riga NDJSON per la cattura finale, con i campi attesi.
	const forcedLogs = chunks.filter((c) =>
		c.includes('"event":"discussionArena.forced"'),
	);
	assert.equal(
		forcedLogs.length,
		1,
		"1 riga NDJSON discussionArena.forced emessa su stderr per l'ultimo forcing (3° gruppo)",
	);
	const parsed = JSON.parse(forcedLogs[0]!);
	assert.equal(parsed.level, "info", "NDJSON level=info");
	assert.equal(parsed.tier, "F", "NDJSON tier=F (forced)");
	assert.equal(parsed.phase, "discussing", "NDJSON phase=discussing per l'ultimo forcing");
});
