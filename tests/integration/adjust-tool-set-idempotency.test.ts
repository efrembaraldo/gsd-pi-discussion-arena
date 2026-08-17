/**
 * tests/integration/adjust-tool-set-idempotency.test.ts — Proprietà
 * contrattuali sull'hook "adjust_tool_set" della composizione multi-gruppo
 * della discussion arena (D083, MEM221, M010/S03).
 *
 * Attesta quattro proprietà sull'hook "adjust_tool_set" gestito da
 * `attachUnitAwareHooks` (src/hooks-unit-aware.ts):
 *
 *   P1) union additiva di discussion_arena per forcing 3-gruppo simultaneo
 *       (planning + research-decision + discussing): con tutti e tre i gruppi
 *       registrati sullo stesso api, per ogni unit_type rappresentativo di
 *       gruppo il toolset forzato contiene ESATTAMENTE una copia di
 *       "discussion_arena". I 3 gruppi sono disgiunti per `activeUnitTypes`
 *       (vedi src/phase-mapping.ts), quindi un solo handler è attivo per
 *       unit_type; la guardia `if (!toolNames.includes(UNIT_AWARE_TOOL_NAME))`
 *       mantiene cardinalità 1 anche se più handler fossero attivi.
 *
 *   P2) idempotenza di inject su N emits consecutivi di "adjust_tool_set"
 *       propagando il toolset dell'emits precedente nell'activeToolNames del
 *       successivo ("catena di payload"): la guardia
 *       `if (!toolNames.includes(UNIT_AWARE_TOOL_NAME))` in
 *       src/hooks-unit-aware.ts garantisce che la cardinalità di
 *       "discussion_arena" resti 1 indipendentemente dal numero di emits.
 *
 *   P3) no-regression quando currentUnitType è fuori dai 6 gruppi arena
 *       (es. `quick-task`): nessun handler inietta → toolset invariato,
 *       `changed = false`. Conferma l'isolamento della state machine
 *       `attachUnitAwareHooks` agli `activeUnitTypes` registrati.
 *
 *   P4) idempotenza di registrazione multi-chiamata stesso marker
 *       (`registeredMarkersByApi` WeakMap): chiamate ripetute di
 *       `attachDiscussionArenaHooks` (wrapper pubblico di
 *       `attachUnitAwareHooks`) con lo stesso `instructionMarker`
 *       registrano ESATTAMENTE 1 handler `adjust_tool_set`; la 1ª chiamata
 *       ritorna `true` e le successive `false`. Il toolset forzato resta
 *       a 1 copia di "discussion_arena" (no duplicazione del tool).
 *
 * Nessuna metrica nuova: il test NON emette `tool_call` (quindi il counter
 * `discussion_arena_on_demand_total` resta intatto) né `before_agent_start`
 * (quindi né `discussion_arena_forced_total` né il log strutturato
 * `discussionArena.forced` vengono toccati). Il test si limita strettamente
 * al contratto del solo hook "adjust_tool_set".
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { Writable } from "node:stream";

import { attachDiscussionArenaHooks } from "../../src/hooks-planning.js";
import { attachResearchDecisionHooks } from "../../src/hooks-research.js";
import { attachDiscussingHooks } from "../../src/hooks-discussing.js";
import type { CapabilityName } from "../../src/runtime-classifier.js";
import type { ResolveTriggerOutput } from "../../trigger-resolver.js";

/** `resolveTrigger` `forced` valido per ogni gruppo (decision=forced). */
const FORCED: ResolveTriggerOutput = {
	decision: "forced",
	source: "coordination",
	warnings: [],
	parseErrors: [],
	tier: "F",
	capabilities: Object.freeze(new Set<CapabilityName>()),
	groupEligibility: null,
};

/**
 * Valore letterale della costante `UNIT_AWARE_TOOL_NAME` definita in
 * src/hooks-unit-aware.ts (NON esportata). Il test non la legge direttamente
 * per non dipendere da un simbolo non pubblico; usa il literal "discussion_arena"
 * che è la stringa iniettata ed è parte del protocollo runtime.
 */
const D_ARENA = "discussion_arena" as const;

/**
 * Unit-type rappresentativi per i 3 gruppi di P1 + unit-type fuori arena per
 * P3. ATTENZIONE — il wrapper `attachDiscussionArenaHooks` (legacy S05) si
 * registra su `Set(["planning"])` (singolo unit_type "planning", NON i 6
 * unit_type del gruppo `planning` in `src/phase-mapping.ts`). Lo stesso
 * pattern vige in `tests/integration/hooks-coexist.test.ts`. I tre wrapper
 * di interesse quindi si attivano su:
 *   - planning              → unitType = "planning"
 *   - research-decision     → unitType = "research-decision"
 *   - discussing            → unitType ∈ {discuss-milestone, discuss-project,
 *                                        discuss-requirements}
 */
const PLAN_UNIT = "planning" as const;
const RD_UNIT = "research-decision" as const;
const DISC_UNIT = "discuss-milestone" as const;
const OUT_OF_ARENA_UNIT = "quick-task" as const; // fuori dai 6 gruppi arena (D102)

/** Toolset di base per gli assert (non include "discussion_arena"). */
const BASE_TOOLS = ["a", "b"] as const;

interface HarnessState {
	lastTools: string[];
	lastChanged: boolean;
}

interface Harness {
	state: HarnessState;
	emit: (eventName: string, payload: Record<string, unknown>) => void;
	/** Numero di handler registrati per "adjust_tool_set" sullo stesso api. */
	readonly adjustToolSetHandlers: number;
	/** Returns delle chiamate `attach*Hooks` in ordine (per P4). */
	readonly registrationReturns: ReadonlyArray<{ caller: string; ret: boolean }>;
}

interface HarnessOptions {
	/** Registra `attachDiscussionArenaHooks` esattamente `reRegisterPlanning + 1` volte. */
	registerPlanning?: boolean;
	reRegisterPlanning?: number;
	registerResearchDecision?: boolean;
	registerDiscussing?: boolean;
}

/**
 * Costruisce un harness che registra 0..N gruppi della discussion arena sullo
 * stesso `api`. Il dispatcher compone i toolset ritornati in stile "framework":
 * tutti gli handler registrati per l'evento sono chiamati in sequenza con lo
 * stesso payload; l'ultimo handler che restituisce `toolNames` vince (`finalTools`).
 * Per `unit_start` e `before_agent_start` i risultati sono side-effect-only
 * (non componibili) e vengono ignorati dall'harness.
 */
function buildHarness(opts: HarnessOptions): Harness {
	const handlers = new Map<
		string,
		((event: Record<string, unknown>) => unknown)[]
	>();
	const state: HarnessState = { lastTools: [], lastChanged: false };
	const stderrLines: string[] = [];
	const stderr = new Writable({
		write(chunk, _enc, cb) {
			stderrLines.push(String(chunk));
			cb();
		},
	});
	const ctx = { cwd: "/tmp/adjust-tool-set-idempotency" };
	const registrationReturns: { caller: string; ret: boolean }[] = [];

	const api = {
		on(eventName: string, handler: (event: Record<string, unknown>) => unknown) {
			const list = handlers.get(eventName) ?? [];
			list.push(handler);
			handlers.set(eventName, list);
			return {};
		},
	};

	if (opts.registerPlanning) {
		const totalCalls = (opts.reRegisterPlanning ?? 0) + 1;
		for (let i = 0; i < totalCalls; i++) {
			const ret = attachDiscussionArenaHooks(api as never, ctx as never, FORCED);
			registrationReturns.push({
				caller: i === 0 ? "planning#1" : `planning#${i + 1}`,
				ret,
			});
		}
	}
	if (opts.registerResearchDecision) {
		const ret = attachResearchDecisionHooks(
			api as never,
			ctx as never,
			FORCED,
			stderr,
		);
		registrationReturns.push({ caller: "research-decision#1", ret });
	}
	if (opts.registerDiscussing) {
		const ret = attachDiscussingHooks(api as never, ctx as never, FORCED, stderr);
		registrationReturns.push({ caller: "discussing#1", ret });
	}

	function emit(eventName: string, payload: Record<string, unknown>): void {
		let finalTools: string[] | undefined;
		for (const handler of handlers.get(eventName) ?? []) {
			const res = handler(payload) as
				| { toolNames?: string[]; systemPrompt?: string }
				| undefined;
			if (res && Array.isArray(res.toolNames)) {
				finalTools = res.toolNames;
			}
		}
		if (eventName === "adjust_tool_set") {
			state.lastTools = finalTools ?? (payload.activeToolNames as string[]);
			state.lastChanged = finalTools !== undefined;
		}
	}

	return {
		state,
		emit,
		get adjustToolSetHandlers() {
			return (handlers.get("adjust_tool_set") ?? []).length;
		},
		registrationReturns,
	};
}

function dArenaCount(tools: ReadonlyArray<string>): number {
	return tools.filter((t) => t === D_ARENA).length;
}

test("P1: union additiva — planning + research-decision + discussing simultanei su stesso api producono UNA copia di discussion_arena", () => {
	const h = buildHarness({
		registerPlanning: true,
		registerResearchDecision: true,
		registerDiscussing: true,
	});
	assert.equal(
		h.adjustToolSetHandlers,
		3,
		"3 gruppi registrati sullo stesso api → 3 handler adjust_tool_set (uno per marker distinto)",
	);
	assert.equal(
		h.registrationReturns.length,
		3,
		"3 chiamate di attach*Hooks: una per gruppo",
	);
	assert.deepEqual(
		h.registrationReturns.map((r) => r.ret),
		[true, true, true],
		"prima registrazione di ciascun marker ritorna true",
	);

	for (const unitType of [PLAN_UNIT, RD_UNIT, DISC_UNIT]) {
		h.emit("unit_start", { unitType });
		h.emit("adjust_tool_set", { activeToolNames: [...BASE_TOOLS] });

		assert.deepEqual(
			h.state.lastTools,
			[...BASE_TOOLS, D_ARENA],
			`forcing ${unitType}: toolset è esattamente [a, b, discussion_arena]`,
		);
		assert.ok(h.state.lastChanged, `forcing ${unitType}: changed=true`);
		assert.equal(
			dArenaCount(h.state.lastTools),
			1,
			`forcing ${unitType}: cardinalità di discussion_arena è esattamente 1 (nessuna duplicazione)`,
		);
	}
});

test("P2: idempotenza di inject su N emits consecutivi con catena di payload (solo planning)", () => {
	const h = buildHarness({ registerPlanning: true });
	assert.equal(
		h.adjustToolSetHandlers,
		1,
		"con un solo gruppo planning → 1 handler adjust_tool_set",
	);

	h.emit("unit_start", { unitType: PLAN_UNIT });

	const N = 5;
	let currentActive: string[] = [...BASE_TOOLS];
	for (let i = 0; i < N; i++) {
		h.emit("adjust_tool_set", { activeToolNames: currentActive });

		assert.equal(
			dArenaCount(h.state.lastTools),
			1,
			`emit #${i + 1}: cardinalità di discussion_arena è esattamente 1 (catena in ingresso: ${currentActive.join(",")})`,
		);
		assert.ok(h.state.lastChanged, `emit #${i + 1}: changed=true`);
		assert.deepEqual(
			h.state.lastTools,
			[...BASE_TOOLS, D_ARENA],
			`emit #${i + 1}: toolset identico a [a, b, discussion_arena]`,
		);
		// Propaga il toolset dell'emits precedente come `activeToolNames`
		// dell'emits successivo (catena di payload) — pattern reale del
		// framework quando il toolset forzato persiste tra adjust_tool_set
		// consecutivi sullo stesso turn.
		currentActive = [...h.state.lastTools];
	}
});

test("P3: no-regression — currentUnitType fuori dai gruppi arena produce zero forcing", () => {
	const h = buildHarness({
		registerPlanning: true,
		registerResearchDecision: true,
		registerDiscussing: true,
	});
	assert.equal(
		h.adjustToolSetHandlers,
		3,
		"3 gruppi registrati, ma nessuno copre quick-task",
	);

	h.emit("unit_start", { unitType: OUT_OF_ARENA_UNIT });
	h.emit("adjust_tool_set", { activeToolNames: [...BASE_TOOLS] });

	assert.equal(
		h.state.lastChanged,
		false,
		`unitType=${OUT_OF_ARENA_UNIT} fuori dai 6 gruppi arena → nessun handler inietta, changed=false`,
	);
	assert.deepEqual(
		h.state.lastTools,
		[...BASE_TOOLS],
		"toolset di default invariato",
	);
	assert.equal(
		dArenaCount(h.state.lastTools),
		0,
		"discussion_arena assente nel toolset fuori dai gruppi arena",
	);
});

test("P4: idempotenza di registrazione multi-chiamata stesso marker (WeakMap registeredMarkersByApi)", () => {
	const N = 4;
	const h = buildHarness({ registerPlanning: true, reRegisterPlanning: N - 1 });

	assert.equal(
		h.registrationReturns.length,
		N,
		`N=${N} chiamate di attachDiscussionArenaHooks sullo stesso api`,
	);
	assert.deepEqual(
		h.registrationReturns.map((r) => r.ret),
		[true, false, false, false],
		"1ª registrazione ritorna true; le successive (stesso marker) ritornano false (idempotenza)",
	);
	assert.equal(
		h.adjustToolSetHandlers,
		1,
		`esattamente 1 handler adjust_tool_set dopo N=${N} chiamate con stesso marker`,
	);

	h.emit("unit_start", { unitType: PLAN_UNIT });
	h.emit("adjust_tool_set", { activeToolNames: [...BASE_TOOLS] });

	assert.equal(
		dArenaCount(h.state.lastTools),
		1,
		"no duplicazione del tool: discussion_arena appare esattamente 1 volta",
	);
	assert.deepEqual(
		h.state.lastTools,
		[...BASE_TOOLS, D_ARENA],
		"toolset forzato è [a, b, discussion_arena]",
	);
});
