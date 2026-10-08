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
 *   P3) no-regression quando currentUnitType è fuori dai 6 gruppi
 *       discussion_arena (es. `quick-task`): nessun handler inietta → toolset
 *       invariato, `changed = false`. Conferma l'isolamento della state
 *       machine `attachUnitAwareHooks` agli `activeUnitTypes` registrati.
 *
 *   P4) idempotenza di registrazione multi-chiamata stesso marker
 *       (`registeredMarkersByApi` WeakMap): chiamate ripetute di
 *       `attachDiscussionArenaHooks` (wrapper pubblico di
 *       `attachUnitAwareHooks`) con lo stesso `instructionMarker`
 *       registrano ESATTAMENTE 1 handler `adjust_tool_set`; la 1ª chiamata
 *       ritorna `true` e le successive `false`. Il toolset forzato resta
 *       a 1 copia di "discussion_arena" (no duplicazione del tool).
 *
 *   P5) coesistenza multi-gruppo sotto host ≥ 1.21.0 con composizione delta
 *       (S04/T3, I2 #1998): con i 3 gruppi registrati sullo stesso api, SOLO
 *       l'handler del gruppo attivo (planning per plan-milestone) ritorna la
 *       forma delta `{ addTools: ["discussion_arena"] }` (R066/R067); il
 *       dispatcher compone l'union+dedup nel toolset finale esattamente
 *       [a, b, discussion_arena], cardinalità 1.
 *
 *   P6) transcript legacy byte-per-byte su env-assente (S04/T3): l'output di
 *       Hook 2 (shape esatta `{ toolNames: [...] }` array-copy) e Hook 3
 *       (iniezione marker `\n\n<marker>\n<istruzione>` + log NDJSON
 *       `discussionArena.forced` di S02) è identico a v0.9.2 — nessuna forma
 *       nuova (nessun `addTools`, nessun log `discussionArena.toolsetDelta`).
 *
 * Metriche: I1/I2 NON aggiungono counter (slice verification S04) — P6 tocca
 * solo `discussion_arena_forced_total{phase}` preesistente (via
 * before_agent_start) e `resetMetrics()` isola il registry tra test. Il test
 * NON emette mai `tool_call` (counter `discussion_arena_on_demand_total`
 * intatto) e non introduce superficie metrics/health nuova su stub
 * env-absent. I test che dipendono dal fingerprint versione (P5, P6) sono
 * avvolti in `withGSDVersion` per prevenire leakage di
 * `process.env.GSD_VERSION` tra test (pattern
 * tests/runtime-classifier.test.ts, usato come riferimento, NON come file da
 * modificare).
 */

import { beforeEach, test } from "node:test";
import * as assert from "node:assert/strict";
import { Writable } from "node:stream";

import { attachDiscussionArenaHooks } from "../../src/hooks-planning.js";
import { attachResearchDecisionHooks } from "../../src/hooks-research.js";
import { attachDiscussingHooks } from "../../src/hooks-discussing.js";
import { PLANNING_INSTRUCTION_MARKER } from "../../src/markers.js";
import { getMetrics, resetMetrics } from "../../src/metrics.js";
import type { CapabilityName } from "../../src/runtime-classifier.js";
import type { ResolveTriggerOutput } from "../../trigger-resolver.js";

beforeEach(() => {
	resetMetrics();
});

/**
 * Setta/rimuove `process.env.GSD_VERSION` per la durata di `fn` e ripristina
 * il valore precedente (anche se `fn` lancia). Pattern copiato da
 * tests/runtime-classifier.test.ts (riferimento, NON modificato). Ogni test
 * che dipende dal fingerprint versione (P5 host 1.21.0, P6 env-assente) è
 * avvolto per prevenire leakage di `process.env.GSD_VERSION` tra test — i
 * casi env-assente DEVONO essere avvolti esplicitamente perché in questo
 * ambiente `GSD_VERSION` è impostata dall'host (es. 1.21.x-dev).
 */
async function withGSDVersion<T>(
	value: string | undefined,
	fn: () => T | Promise<T>,
): Promise<T> {
	const prev = process.env.GSD_VERSION;
	if (value === undefined) delete process.env.GSD_VERSION;
	else process.env.GSD_VERSION = value;
	try {
		return await fn();
	} finally {
		if (prev === undefined) delete process.env.GSD_VERSION;
		else process.env.GSD_VERSION = prev;
	}
}

/**
 * Variante sincrona di cattura `process.stderr` (emitStructuredLog è
 * sincrono). Necessaria perché, a differenza dei sink Writable passati ai
 * wrapper research-decision/discussing, i log NDJSON del ramo delta
 * (`discussionArena.toolsetDelta`) e del forcing (`discussionArena.forced`)
 * passano direttamente per `process.stderr` (src/metrics.ts).
 */
function captureProcessStderrSync(fn: () => void): string[] {
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
const D_DISCUSSION_ARENA = "discussion_arena" as const;

/**
 * Unit-type rappresentativi per i 3 gruppi di P1 + unit-type fuori dai gruppi
 * discussion_arena per P3. M010/S02/T02: da T01, `attachDiscussionArenaHooks`
 * consuma `ACTIVE_UNIT_TYPES.planning` (frozen Set canonico di 6 unit-type:
 * plan-milestone, plan-slice, refine-slice, replan-slice, replan-task,
 * gate-evaluate) come activeUnitTypes. PLAN_UNIT è ora `plan-milestone`
 * (membro canonico, primo del set). Lo stesso pattern vige in
 * `tests/integration/hooks-coexist.test.ts` e
 * `tests/integration/adjust-tool-set-race.test.ts`. I tre wrapper di
 * interesse quindi si attivano su:
 *   - planning              → unitType ∈ ACTIVE_UNIT_TYPES.planning
 *   - research-decision     → unitType = "research-decision"
 *   - discussing            → unitType ∈ ACTIVE_UNIT_TYPES.discussing
 */
const PLAN_UNIT = "plan-milestone" as const;
const RD_UNIT = "research-decision" as const;
const DISC_UNIT = "discuss-milestone" as const;
const OUT_OF_DISCUSSION_ARENA_UNIT = "quick-task" as const; // fuori dai 6 gruppi discussion_arena (D102)

/** Toolset di base per gli assert (non include "discussion_arena"). */
const BASE_TOOLS = ["a", "b"] as const;

/** Testo istruzione planning (specchio di DISCUSSION_ARENA_INSTRUCTION in src/hooks-planning.ts). */
const PLANNING_INSTRUCTION = "Usa discussion_arena prima di decidere il piano";

interface HarnessState {
	lastTools: string[];
	lastChanged: boolean;
	/** S04/T3 (P5): risultati GREZZI di ciascun handler adjust_tool_set dell'ultimo emit. */
	lastAdjustRawResults: unknown[];
	/** S04/T3 (P6): ultimo risultato before_agent_start non-undefined (iniezione marker). */
	lastBeforeAgentStart: { systemPrompt?: string } | undefined;
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
 * stesso payload; l'ultimo handler che restituisce `toolNames` vince
 * (`finalTools`) e la forma delta `{addTools}` è unita in union+dedup DOPO la
 * composizione toolNames (S04/T3, cardinalità 1 di discussion_arena). Per
 * `unit_start` i risultati sono side-effect-only e vengono ignorati;
 * `before_agent_start` e i risultati grezzi di `adjust_tool_set` sono
 * catturati in `HarnessState` per le asserzioni P5/P6.
 */
function buildHarness(opts: HarnessOptions): Harness {
	const handlers = new Map<
		string,
		((event: Record<string, unknown>) => unknown)[]
	>();
	const state: HarnessState = {
		lastTools: [],
		lastChanged: false,
		lastAdjustRawResults: [],
		lastBeforeAgentStart: undefined,
	};
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
		const addTools: string[] = [];
		// S04/T3 (P5): cattura il RISULTATO GREZZO di ciascun handler
		// adjust_tool_set per asserire chi ha prodotto la forma delta e chi
		// resta muto (coesistenza multi-gruppo).
		if (eventName === "adjust_tool_set") {
			state.lastAdjustRawResults = [];
		}
		for (const handler of handlers.get(eventName) ?? []) {
			const res = handler(payload) as
				| { toolNames?: string[]; addTools?: string[]; systemPrompt?: string }
				| undefined;
			if (eventName === "adjust_tool_set") {
				state.lastAdjustRawResults.push(res);
			}
			if (res && Array.isArray(res.toolNames)) {
				finalTools = res.toolNames;
			}
			if (res && Array.isArray(res.addTools)) {
				// S04/T2 (M019, I2 delta #1998): compone la forma delta {addTools}
				// nel toolset finale (union + dedup) come fa il framework — sotto
				// env host GSD_VERSION >= 1.21.0 il ramo delta ritorna addTools
				// invece dell'array-copy, quindi senza questo merge `finalTools`
				// resterebbe undefined e i test P1-P4 fallirebbero.
				addTools.push(...res.addTools);
			}
			if (eventName === "before_agent_start" && res !== undefined) {
				// S04/T3 (P6): cattura la mutazione del systemPrompt (il transcript
				// legacy è proprio questa forma). Solo risultati non-undefined
				// vincono, come per il framework.
				state.lastBeforeAgentStart = res;
			}
		}
		if (eventName === "adjust_tool_set") {
			// Base: toolNames full-replacement, oppure activeToolNames (ramo delta).
			const base = finalTools ?? [...(payload.activeToolNames as string[])];
			// Composizione addTools (delta): union + dedup, cardinalità 1.
			for (const tool of addTools) {
				if (!base.includes(tool)) base.push(tool);
			}
			state.lastTools = base;
			state.lastChanged = finalTools !== undefined || addTools.length > 0;
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

function discussionArenaCount(tools: ReadonlyArray<string>): number {
	return tools.filter((t) => t === D_DISCUSSION_ARENA).length;
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
			[...BASE_TOOLS, D_DISCUSSION_ARENA],
			`forcing ${unitType}: toolset è esattamente [a, b, discussion_arena]`,
		);
		assert.ok(h.state.lastChanged, `forcing ${unitType}: changed=true`);
		assert.equal(
			discussionArenaCount(h.state.lastTools),
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
			discussionArenaCount(h.state.lastTools),
			1,
			`emit #${i + 1}: cardinalità di discussion_arena è esattamente 1 (catena in ingresso: ${currentActive.join(",")})`,
		);
		assert.ok(h.state.lastChanged, `emit #${i + 1}: changed=true`);
		assert.deepEqual(
			h.state.lastTools,
			[...BASE_TOOLS, D_DISCUSSION_ARENA],
			`emit #${i + 1}: toolset identico a [a, b, discussion_arena]`,
		);
		// Propaga il toolset dell'emits precedente come `activeToolNames`
		// dell'emits successivo (catena di payload) — pattern reale del
		// framework quando il toolset forzato persiste tra adjust_tool_set
		// consecutivi sullo stesso turn.
		currentActive = [...h.state.lastTools];
	}
});

test("P3: no-regression — currentUnitType fuori dai gruppi discussion_arena produce zero forcing", () => {
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

	h.emit("unit_start", { unitType: OUT_OF_DISCUSSION_ARENA_UNIT });
	h.emit("adjust_tool_set", { activeToolNames: [...BASE_TOOLS] });

	assert.equal(
		h.state.lastChanged,
		false,
		`unitType=${OUT_OF_DISCUSSION_ARENA_UNIT} fuori dai 6 gruppi discussion_arena → nessun handler inietta, changed=false`,
	);
	assert.deepEqual(
		h.state.lastTools,
		[...BASE_TOOLS],
		"toolset di default invariato",
	);
	assert.equal(
		discussionArenaCount(h.state.lastTools),
		0,
		"discussion_arena assente nel toolset fuori dai gruppi discussion_arena",
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
		discussionArenaCount(h.state.lastTools),
		1,
		"no duplicazione del tool: discussion_arena appare esattamente 1 volta",
	);
	assert.deepEqual(
		h.state.lastTools,
		[...BASE_TOOLS, D_DISCUSSION_ARENA],
		"toolset forzato è [a, b, discussion_arena]",
	);
});

// ─── S04/T3: coesistenza delta (P5) e transcript legacy byte-per-byte (P6) ──

test("P5 (host 1.21.0): coesistenza multi-gruppo con composizione delta — toolset finale esattamente [a, b, discussion_arena]", async () => {
	await withGSDVersion("1.21.0", () => {
		const h = buildHarness({
			registerPlanning: true,
			registerResearchDecision: true,
			registerDiscussing: true,
		});
		assert.equal(
			h.adjustToolSetHandlers,
			3,
			"3 gruppi registrati sullo stesso api → 3 handler adjust_tool_set",
		);

		h.emit("unit_start", { unitType: PLAN_UNIT });
		const chunks = captureProcessStderrSync(() => {
			h.emit("adjust_tool_set", { activeToolNames: [...BASE_TOOLS] });
		});

		// Coesistenza (R066/R067): i gruppi sono disgiunti per `activeUnitTypes`,
		// quindi SOLO l'handler planning (attivo per plan-milestone) produce la
		// forma delta; gli altri 2 restano muti (undefined, nessun array-copy,
		// nessun cross-group leak). Ordine = ordine di registrazione.
		assert.deepEqual(
			h.state.lastAdjustRawResults,
			[{ addTools: [D_DISCUSSION_ARENA] }, undefined, undefined],
			"ramo delta: solo l'handler planning ritorna {addTools}, gli altri gruppi non producono nulla",
		);
		// Composizione delta attraverso l'harness esteso: base [a, b] + union+dedup.
		assert.deepEqual(
			h.state.lastTools,
			[...BASE_TOOLS, D_DISCUSSION_ARENA],
			"toolset finale (dopo composizione delta) è esattamente [a, b, discussion_arena]",
		);
		assert.equal(
			discussionArenaCount(h.state.lastTools),
			1,
			"cardinalità di discussion_arena è esattamente 1 (merge+dedup delta)",
		);
		assert.ok(h.state.lastChanged, "forcing planning: changed=true");
		// Log strutturato dichiarativo del ramo delta (R3/D160): UNA riga,
		// emessa solo dall'handler delta attivo.
		assert.equal(
			chunks.filter((c) => c.includes("discussionArena.toolsetDelta")).length,
			1,
			"esattamente 1 evento discussionArena.toolsetDelta (un solo handler delta attivo)",
		);
	});
});

test("P6 (env-assente): transcript legacy byte-per-byte a v0.9.2 — Hook2 toolNames array-copy + Hook3 marker injection, nessuna forma nuova", async () => {
	await withGSDVersion(undefined, () => {
		const h = buildHarness({ registerPlanning: true });
		assert.equal(
			h.adjustToolSetHandlers,
			1,
			"un solo gruppo planning → 1 handler adjust_tool_set",
		);

		// ── Hook 2 (adjust_tool_set): forma legacy array-copy, byte-per-byte ──
		h.emit("unit_start", { unitType: PLAN_UNIT });
		const chunks2 = captureProcessStderrSync(() => {
			h.emit("adjust_tool_set", { activeToolNames: [...BASE_TOOLS] });
		});
		// deepEqual strict: shape ESATTA — niente addTools, niente chiavi extra.
		assert.deepEqual(
			h.state.lastAdjustRawResults,
			[{ toolNames: [...BASE_TOOLS, D_DISCUSSION_ARENA] }],
			"env-assente: Hook2 ritorna esattamente {toolNames:[a,b,discussion_arena]} (array-copy v0.9.2)",
		);
		assert.deepEqual(h.state.lastTools, [...BASE_TOOLS, D_DISCUSSION_ARENA]);
		assert.equal(
			chunks2.filter((c) => c.includes("discussionArena.toolsetDelta")).length,
			0,
			"env-assente: nessun log discussionArena.toolsetDelta (ramo delta morto)",
		);

		// ── Hook 3 (before_agent_start): iniezione marker byte-per-byte ──
		const PROMPT = "system prompt di base";
		const expectedPrompt =
			PROMPT +
			"\n\n" +
			PLANNING_INSTRUCTION_MARKER +
			"\n" +
			PLANNING_INSTRUCTION;
		const chunks3 = captureProcessStderrSync(() => {
			h.emit("before_agent_start", { systemPrompt: PROMPT });
		});
		assert.deepEqual(
			h.state.lastBeforeAgentStart,
			{ systemPrompt: expectedPrompt },
			"env-assente: Hook3 muta il systemPrompt esattamente come v0.9.2 (prompt + \\n\\n + marker + \\n + istruzione)",
		);
		// Il log NDJSON discussionArena.forced è parte del transcript v0.9.2
		// (S02/M009): 1 riga, phase=planning — nessun evento nuovo.
		const forcedLines = chunks3.filter((c) =>
			c.includes("discussionArena.forced"),
		);
		assert.equal(
			forcedLines.length,
			1,
			"1 sola riga NDJSON discussionArena.forced",
		);
		const parsed = JSON.parse(forcedLines[0]!) as {
			event: string;
			tier: string;
			phase: string;
		};
		assert.equal(parsed.event, "discussionArena.forced");
		assert.equal(parsed.tier, "F");
		assert.equal(parsed.phase, "planning");
		// I1/I2 non aggiungono counter (slice verification S04): il forcing
		// riusa discussion_arena_forced_total{phase} preesistente.
		assert.equal(
			getMetrics().counters["discussion_arena_forced_total"]?.[
				"{phase=planning}"
			],
			1,
			"counter riusato discussion_arena_forced_total{phase=planning}=1",
		);
	});
});