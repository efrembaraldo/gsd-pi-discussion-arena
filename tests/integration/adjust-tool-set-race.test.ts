/**
 * tests/integration/adjust-tool-set-race.test.ts — Test di integrazione
 * che chiude il contratto R016 (gap G5 della spec §2): attestare la
 * coesistenza e la race condition fra un listener `adjust_tool_set` del
 * CORE di gsd-pi (registrato per primo, ordine di caricamento reale
 * dell'ExtensionAPI) e i 3 wrapper della discussion arena (planning +
 * research-decision + discussing) registrati sullo stesso `ExtensionAPI`.
 *
 * Simula fedelmente il dispatcher `emitAdjustToolSet` di gsd-pi
 * (runner.ts:1176-1189): itera gli handler registrati nell'ordine di
 * registrazione, passa lo stesso payload a tutti, e ritorna il PRIMO
 * result che contiene `toolNames` (short-circuit). Se nessuno ritorna,
 * il dispatcher restituisce `undefined` e il toolset resta invariato.
 *
 * Le 4 asserzioni coprono i 4 contratti di composizione G1–G4:
 *
 *   G1 — CORE PASSIVO (path felice, no race): il listener core è
 *        registrato ma NON ritorna un result truthy (passive). Il
 *        dispatcher cade al listener della discussion arena, che
 *        inietta `discussion_arena` senza interferenza. Toolset finale
 *        = base + discussion_arena. `handlersCalled` contiene ENTRAMBI
 *        `core` e `discussion_arena:planning`.
 *
 *   G2 — CORE ATTIVO (debito residuo D097 attestato onestamente): il
 *        listener core ritorna un result con `toolNames` (active, no
 *        conditional-merge). Per il vincolo di short-circuit del
 *        dispatcher, il listener della discussion arena NON viene
 *        chiamato e `discussion_arena` è assente dal toolset finale.
 *        Questo è il debito residuo documentato da D097: la nostra
 *        estensione dichiara `priority: 100` nel manifest v2
 *        (extension-manifest.json v2) ma il loader di gsd-pi non legge
 *        il campo `priority`, quindi il listener core (registrato per
 *        primo dal framework) short-circuita sempre il dispatcher e
 *        oscura la nostra iniezione. L'asserzione attesta il debito
 *        invece di nasconderlo — esattamente come richiesto da D097.
 *
 *   G3 — CORE CONDITIONAL MERGE (workaround D097) + catena di payload:
 *        il listener core applica il workaround noto: ritorna PASSIVE
 *        (`undefined`) se i suoi tool sono già nel toolset in ingresso,
 *        altrimenti ritorna `toolNames = [...input, ...CORE_TOOLS]`. La
 *        catena di payload propaga il toolset del previous emit come
 *        `activeToolNames` del successivo (pattern reale del framework
 *        quando il toolset forzato persiste tra adjust_tool_set
 *        consecutivi sullo stesso turn). Risultato atteso dopo 2
 *        emits:
 *          - emit 1 (activeToolNames = base): core ATTIVO (coreTools
 *            assenti) → short-circuita → toolset = base + coreTools,
 *            discussion_arena wrapper non chiamato.
 *          - emit 2 (activeToolNames = base + coreTools, catena): core
 *            PASSIVE (coreTools già presenti) → dispatcher cade sul
 *            discussion_arena wrapper → toolset = base + coreTools +
 *            discussion_arena, cardinalità 1 ciascuno.
 *        `handlersCalled` contiene [core] sull'emits 1 e
 *        [core, discussion_arena:planning] sull'emits 2.
 *
 *   G4 — FORCING 3-GRUPPO + core merging: tutti e 3 i wrapper della
 *        discussion arena (planning + research-decision + discussing)
 *        registrati sullo stesso api, il listener core applica lo
 *        stesso workaround conditional-merge. Il dispatcher itera 4
 *        handler `adjust_tool_set` (1 core + 3 discussion_arena, registrati in
 *        ordine). Risultato atteso dopo la catena di 3 emits (uno per
 *        gruppo):
 *          - cardinalità `discussion_arena` resta 1 nel toolset
 *            finale (la guardia interna
 *            `if (!toolNames.includes(UNIT_AWARE_TOOL_NAME))` di
 *            `attachUnitAwareHooks` protegge dalla duplicazione anche
 *            se tutti i 3 wrapper discussion_arena fossero chiamati in cascata);
 *          - i tool del core sono preservati senza duplicazione.
 *
 * NON si sovrappone a `tests/integration/adjust-tool-set-idempotency.test.ts`
 * (S03): quel file copre SOLO il namespace della discussion arena con un
 * dispatcher last-handler-wins (tutti gli handler sono chiamati). Questo
 * file copre la coesistenza con un listener core ESTERNO e usa la
 * semantica REAL del dispatcher di gsd-pi (short-circuit al primo
 * truthy).
 *
 * NON si sovrappone a `tests/hooks-coexist-multigroup.test.ts` (S06):
 * quel file copre 3 gruppi della discussion arena ma NESSUN listener
 * core esterno e usa un dispatcher last-handler-wins (tutti gli handler
 * sono chiamati e il toolset dell'ultimo vince).
 *
 * Nessuna metrica nuova, nessuna superficie runtime nuova. Il test NON
 * emette `tool_call` né `before_agent_start` (l'assertion su
 * `adjust_tool_set` è isolata), quindi i counter
 * `discussion_arena_on_demand_total` e `discussion_arena_forced_total`
 * non vengono toccati e non c'è rischio di contaminazione cross-test
 * dello stato metriche globale. L'unica strumentazione aggiunta è
 * interna all'harness (audit log `handlersCalled` / flag `shortCircuit`)
 * e serve a rendere il verdetto del short-circuit ispezionabile invece
 * che dedotto dal solo toolset finale.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";

import { attachDiscussionArenaHooks } from "../../src/hooks-planning.js";
import { attachResearchDecisionHooks } from "../../src/hooks-research.js";
import { attachDiscussingHooks } from "../../src/hooks-discussing.js";
import type { ResolveTriggerOutput } from "../../trigger-resolver.js";

// ─── Fixture condivise ────────────────────────────────────────────────────

/**
 * `resolveTrigger` `forced` valido per ogni gruppo della discussion arena
 * (decision=forced). Tier/capabilities/groupEligibility espliciti per
 * soddisfare i campi richiesti da `ResolveTriggerOutput` v2 (S01/M010).
 */
const FORCED: ResolveTriggerOutput = {
	decision: "forced",
	source: "coordination",
	warnings: [],
	parseErrors: [],
	tier: "F",
	capabilities: new Set(),
	groupEligibility: null,
};

/**
 * Letterale della costante `UNIT_AWARE_TOOL_NAME` di `hooks-unit-aware.ts`
 * (NON esportata). Il test non la legge direttamente per non dipendere da
 * un simbolo non pubblico; usa il literal "discussion_arena" che è la
 * stringa iniettata ed è parte del protocollo runtime.
 */
const D_DISCUSSION_ARENA = "discussion_arena" as const;

/** Unit-type rappresentativi dei 3 gruppi della discussion arena. */
const PLAN_UNIT = "planning" as const;
const RD_UNIT = "research-decision" as const;
const DISC_UNIT = "discuss-milestone" as const;

/** Toolset di base per gli assert (non include `discussion_arena`). */
const BASE_TOOLS = ["a", "b"] as const;

/**
 * Tool "core" iniettati dal listener core fittizio (registrato per primo
 * sullo stesso api, ordine di caricamento reale dell'ExtensionAPI: il
 * framework carica i listener core PRIMA delle estensioni). Sono 2 per
 * poter asserire la cardinalità senza ambiguità.
 */
const CORE_TOOLS = ["core-tool-x", "core-tool-y"] as const;

/**
 * Modalità operative del listener core fittizio.
 *
 *   - `"passive"`: non ritorna mai un result (sempre `undefined`) — simula
 *     un core che per questo phase non ha tool da aggiungere.
 *   - `"active"`: ritorna SEMPRE `{ toolNames: [...input, ...CORE_TOOLS] }`
 *     — simula un core che short-circuita sempre il dispatcher (debito
 *     residuo D097 attestato in G2).
 *   - `"conditional-merge"`: ritorna PASSIVE (`undefined`) se TUTTI i
 *     `CORE_TOOLS` sono già nel toolset in ingresso (merge già applicato
 *     da un emit precedente nella catena di payload), altrimenti ritorna
 *     l'input mergiato con `CORE_TOOLS`. Simula il workaround D097 che
 *     permette la coesistenza tramite la catena di payload (G3, G4).
 */
type CoreBehavior = "passive" | "active" | "conditional-merge";

// ─── Harness ──────────────────────────────────────────────────────────────

/**
 * Plan di tag discussion_arena da assegnare nell'ordine di registrazione,
 * per evento. Rispecchia l'ordine in cui `attach*Hooks` registrano i 4 hook:
 *   - adjust_tool_set: planning → research-decision → discussing
 *   - unit_start:      planning → research-decision → discussing
 *   - before_agent_start: planning → research-decision → discussing
 *   - tool_call: registered UNA volta per api (WeakMap `toolCallListenerByApi`,
 *     D107: NO duplicazione multi-marker). Tag unico "discussion_arena:on-demand".
 */
interface DiscussionArenaTagPlan {
	adjust_tool_set: string[];
	unit_start: string[];
	before_agent_start: string[];
	tool_call: string[];
}

function buildDiscussionArenaTagPlan(opts: {
	registerPlanning?: boolean;
	registerResearchDecision?: boolean;
	registerDiscussing?: boolean;
}): DiscussionArenaTagPlan {
	const adjust: string[] = [];
	const unitStart: string[] = [];
	const beforeAgent: string[] = [];
	if (opts.registerPlanning) {
		adjust.push("discussion_arena:planning");
		unitStart.push("discussion_arena:planning");
		beforeAgent.push("discussion_arena:planning");
	}
	if (opts.registerResearchDecision) {
		adjust.push("discussion_arena:research-decision");
		unitStart.push("discussion_arena:research-decision");
		beforeAgent.push("discussion_arena:research-decision");
	}
	if (opts.registerDiscussing) {
		adjust.push("discussion_arena:discussing");
		unitStart.push("discussion_arena:discussing");
		beforeAgent.push("discussion_arena:discussing");
	}
	// tool_call listener: registrato UNA volta per api (idempotenza D107).
	// NB: la proprietà del piano è `tool_call` (string literal event-name
	// reale del framework), NON una variabile in scope.
	const onDemandTags = ["discussion_arena:on-demand"];
	return {
		adjust_tool_set: adjust,
		unit_start: unitStart,
		before_agent_start: beforeAgent,
		tool_call: onDemandTags,
	};
}

interface RaceHarness {
	/** Audit log dei TAG handler chiamati in ORDINE per l'ultimo
	 *  `emit("adjust_tool_set")`. Il PRIMO elemento è il tag dell'handler
	 *  che ha short-circuitato (se `shortCircuit` è true). Reset a ogni
	 *  emit di `adjust_tool_set`. Per gli altri eventi (es. unit_start)
	 *  è una side-list non resettata (vedi `unitStartCalled`). */
	readonly handlersCalled: ReadonlyArray<string>;
	/** `unit_start` tags chiamati dall'ultimo `emit("unit_start")`. */
	readonly unitStartCalled: ReadonlyArray<string>;
	/** true se l'ultimo `emit("adjust_tool_set")` ha short-circuitato
	 *  (cioè il PRIMO handler ha ritornato un result con `toolNames`). */
	readonly shortCircuit: boolean;
	/** Toolset prodotto dall'ultimo `emit("adjust_tool_set")`. */
	readonly lastTools: ReadonlyArray<string>;
	/** `changed` esposto dal dispatcher: toolset finale è stato
	 *  modificato da almeno un handler? */
	readonly lastChanged: boolean;
	/** Numero di handler `adjust_tool_set` registrati (1 core + N discussion_arena). */
	readonly adjustToolSetHandlerCount: number;
	emit: (eventName: string, payload: Record<string, unknown>) => void;
}

interface RaceHarnessOptions {
	/** Modalità del listener core fittizio. */
	coreBehavior: CoreBehavior;
	/** Abilita la registrazione di `attachDiscussionArenaHooks`. */
	registerPlanning?: boolean;
	/** Abilita la registrazione di `attachResearchDecisionHooks`. */
	registerResearchDecision?: boolean;
	/** Abilita la registrazione di `attachDiscussingHooks`. */
	registerDiscussing?: boolean;
}

/**
 * Costruisce un harness che replica il dispatcher `emitAdjustToolSet` di
 * gsd-pi (runner.ts:1176-1189): ordine di registrazione, short-circuit al
 * PRIMO handler che ritorna un result con `toolNames`, audit log dei
 * chiamati, flag `shortCircuit` ispezionabile.
 *
 * Per gli eventi NON `adjust_tool_set` (es. `unit_start`) la semantica del
 * dispatcher reale è fire-and-forget: i listener possono solo osservare o
 * aggiornare lo stato interno (es. tracciare `currentUnitType`), nessun
 * valore di ritorno viene utilizzato dal framework. L'harness inoltra a
 * TUTTI gli handler registrati senza comporre risultati, identico a S06.
 *
 * Il tag "core" è assegnato al PRIMO handler registrato per evento
 * (registrazione esplicita del core stub PRIMA dei wrapper della
 * discussion arena). I tag "discussion_arena:*" sono assegnati nell'ordine
 * di registrazione dei wrapper, rispettando la sequenza reale di
 * `activate()` in `index.ts` (planning → research-decision → discussing).
 */
function buildRaceHarness(opts: RaceHarnessOptions): RaceHarness {
	const taggedHandlers = new Map<
		string,
		{ fn: (event: Record<string, unknown>) => unknown; tag: string }[]
	>();
	const tagPlan = buildDiscussionArenaTagPlan(opts);
	const tagIndexByEvent = new Map<string, number>();
	const handlersCalled: string[] = [];
	const unitStartCalled: string[] = [];
	let shortCircuit = false;
	let lastTools: string[] = [];
	let lastChanged = false;
	let adjustToolSetHandlerCount = 0;
	const ctx = { cwd: "/tmp/adjust-tool-set-race" };

	/** Assegna il prossimo tag discussion_arena per un dato evento. */
	function nextDiscussionArenaTag(eventName: string): string {
		const i = tagIndexByEvent.get(eventName) ?? 0;
		tagIndexByEvent.set(eventName, i + 1);
		const tags = tagPlan[eventName as keyof DiscussionArenaTagPlan] ?? [];
		return tags[i] ?? `discussion_arena:unknown-${i}`;
	}

	const api = {
		on(eventName: string, handler: (event: Record<string, unknown>) => unknown) {
			const list = taggedHandlers.get(eventName) ?? [];
			const tag =
				list.length === 0 ? "core" : nextDiscussionArenaTag(eventName);
			list.push({ fn: handler, tag });
			taggedHandlers.set(eventName, list);
			if (eventName === "adjust_tool_set") {
				adjustToolSetHandlerCount++;
			}
			return {};
		},
	};

	// 1) CORE stub (registrato per primo, ordine di caricamento reale).
	//    NB: solo per `adjust_tool_set`. Per `unit_start` il core stub non
	//    è necessario (la state machine della discussion arena è già gestita
	//    da `currentUnitType` via `unit_start`).
	api.on("adjust_tool_set", (event) => {
		const activeToolNames = (event.activeToolNames as string[]) ?? [];
		if (opts.coreBehavior === "passive") {
			return undefined;
		}
		if (opts.coreBehavior === "active") {
			return { toolNames: [...activeToolNames, ...CORE_TOOLS] };
		}
		// conditional-merge (workaround D097).
		const allCorePresent = CORE_TOOLS.every((t) =>
			activeToolNames.includes(t),
		);
		if (allCorePresent) {
			return undefined;
		}
		return { toolNames: [...activeToolNames, ...CORE_TOOLS] };
	});

	// 2) Wrapper discussion_arena (registrati dopo il core, ordine reale di activate()).
	if (opts.registerPlanning) {
		attachDiscussionArenaHooks(api as never, ctx as never, FORCED);
	}
	if (opts.registerResearchDecision) {
		attachResearchDecisionHooks(api as never, ctx as never, FORCED);
	}
	if (opts.registerDiscussing) {
		attachDiscussingHooks(api as never, ctx as never, FORCED);
	}

	function emit(eventName: string, payload: Record<string, unknown>): void {
		if (eventName === "adjust_tool_set") {
			// Reset audit log e flag per emit (l'audit è per-assertion, non
			// cumulativo tra assert diverse).
			handlersCalled.length = 0;
			shortCircuit = false;
			let finalTools: string[] | undefined;
			for (const { fn, tag } of taggedHandlers.get(eventName) ?? []) {
				const res = fn(payload) as { toolNames?: string[] } | undefined;
				handlersCalled.push(tag);
				if (res && Array.isArray(res.toolNames)) {
					finalTools = res.toolNames;
					shortCircuit = true;
					break; // SHORT-CIRCUIT: primo handler truthy vince.
				}
			}
			lastTools = finalTools ?? [...(payload.activeToolNames as string[])];
			lastChanged = finalTools !== undefined;
			return;
		}
		if (eventName === "unit_start") {
			unitStartCalled.length = 0;
			for (const { fn, tag } of taggedHandlers.get(eventName) ?? []) {
				fn(payload);
				unitStartCalled.push(tag);
			}
			return;
		}
		// Altri eventi: fire-and-forget.
		for (const { fn } of taggedHandlers.get(eventName) ?? []) {
			fn(payload);
		}
	}

	return {
		emit,
		get handlersCalled() {
			return handlersCalled;
		},
		get unitStartCalled() {
			return unitStartCalled;
		},
		get shortCircuit() {
			return shortCircuit;
		},
		get lastTools() {
			return lastTools;
		},
		get lastChanged() {
			return lastChanged;
		},
		get adjustToolSetHandlerCount() {
			return adjustToolSetHandlerCount;
		},
	};
}

function countOccurrences(tools: ReadonlyArray<string>, name: string): number {
	return tools.filter((t) => t === name).length;
}

// ─── G1 — CORE PASSIVO (path felice, no race) ─────────────────────────────

test("G1: core passivo + 1 discussion_arena planning attivo → discussion_arena iniettato senza interferenza, tutti gli handler chiamati in ordine, nessuno short-circuit", () => {
	const h = buildRaceHarness({
		coreBehavior: "passive",
		registerPlanning: true,
	});

	// Sanity: 2 handler `adjust_tool_set` registrati (1 core + 1 discussion_arena).
	assert.equal(
		h.adjustToolSetHandlerCount,
		2,
		"2 handler adjust_tool_set: 1 core stub + 1 discussion_arena:planning",
	);

	// Posiziona la state machine della discussion arena su planning.
	h.emit("unit_start", { unitType: PLAN_UNIT });
	h.emit("adjust_tool_set", { activeToolNames: [...BASE_TOOLS] });

	// (a) Toolset finale: base + discussion_arena (1 copia).
	assert.deepEqual(
		h.lastTools,
		[...BASE_TOOLS, D_DISCUSSION_ARENA],
		"G1 toolset = [a, b, discussion_arena] (discussion_arena wrapper inietta dopo core passivo)",
	);
	assert.equal(
		countOccurrences(h.lastTools, D_DISCUSSION_ARENA),
		1,
		"G1 cardinalità discussion_arena = 1 (no duplicazione)",
	);

	// (b) Audit log: TUTTI gli handler chiamati in ordine di registrazione.
	//     core è passivo (return undefined) ma viene comunque chiamato dal
	//     dispatcher prima di passare al successivo (short-circuit solo
	//     quando un handler ritorna truthy).
	assert.deepEqual(
		h.handlersCalled,
		["core", "discussion_arena:planning"],
		"G1 handlersCalled = [core, discussion_arena:planning]: dispatcher chiama ENTRAMBI in ordine, core ritorna undefined, discussion_arena:planning ritorna truthy",
	);

	// (c) shortCircuit flag: true perché discussion_arena:planning è stato chiamato
	//     e ha ritornato truthy. Il flag è true anche se il dispatcher
	//     ha continuato dopo un handler passivo.
	assert.equal(
		h.shortCircuit,
		true,
		"G1 shortCircuit = true (discussion_arena:planning ha ritornato truthy → dispatcher termina)",
	);

	// (d) changed = true (toolset finale ≠ activeToolNames del payload).
	assert.equal(h.lastChanged, true, "G1 lastChanged = true (toolset finale modificato)");

	// (e) Core tools NON sono presenti (core era passivo).
	for (const ct of CORE_TOOLS) {
		assert.ok(
			!h.lastTools.includes(ct),
			`G1 toolset NON contiene tool core '${ct}' (core era passivo)`,
		);
	}
});

// ─── G2 — CORE ATTIVO (debito residuo D097 attestato onestamente) ──────────

test("G2: core attivo + 1 discussion_arena planning attivo → short-circuit al core, discussion_arena planning MAI chiamato, discussion_arena assente dal toolset finale (debito residuo D097 attestato)", () => {
	const h = buildRaceHarness({
		coreBehavior: "active",
		registerPlanning: true,
	});

	assert.equal(
		h.adjustToolSetHandlerCount,
		2,
		"2 handler adjust_tool_set: 1 core stub + 1 discussion_arena:planning",
	);

	h.emit("unit_start", { unitType: PLAN_UNIT });
	h.emit("adjust_tool_set", { activeToolNames: [...BASE_TOOLS] });

	// (a) Toolset finale: base + core tools. discussion_arena ASSENTE.
	//     Questo è il debito residuo D097: priority: 100 dichiarato nel
	//     manifest ma NON letto dal loader di gsd-pi, quindi il core
	//     short-circuita sempre e oscura la nostra iniezione. L'assert
	//     attesta il debito invece di nasconderlo.
	assert.deepEqual(
		h.lastTools,
		[...BASE_TOOLS, ...CORE_TOOLS],
		"G2 toolset = [a, b, core-tool-x, core-tool-y]: core active short-circuita, discussion_arena wrapper mai chiamato",
	);
	assert.equal(
		countOccurrences(h.lastTools, D_DISCUSSION_ARENA),
		0,
		"G2 cardinalità discussion_arena = 0 (debito residuo D097 attestato onestamente)",
	);
	for (const ct of CORE_TOOLS) {
		assert.ok(
			h.lastTools.includes(ct),
			`G2 toolset contiene tool core '${ct}' (core active ha mergiato)`,
		);
	}

	// (b) Audit log: SOLO core chiamato. discussion_arena:planning MAI invocato
	//     perché il dispatcher ha short-circuitato al core.
	assert.deepEqual(
		h.handlersCalled,
		["core"],
		"G2 handlersCalled = [core]: dispatcher ha short-circuitato al core, discussion_arena:planning MAI chiamato",
	);

	// (c) shortCircuit = true (il core ha ritornato truthy e il dispatcher
	//     ha terminato l'iterazione).
	assert.equal(h.shortCircuit, true, "G2 shortCircuit = true (core attivo)");

	// (d) changed = true (toolset finale ≠ activeToolNames del payload).
	assert.equal(h.lastChanged, true, "G2 lastChanged = true");
});

// ─── G3 — CORE CONDITIONAL MERGE (workaround D097) + catena di payload ────

test("G3: core conditional-merge + 1 discussion_arena planning + 2 emits in catena di payload → discussion_arena e tool del core coesistono con cardinalità 1 ciascuno", () => {
	const h = buildRaceHarness({
		coreBehavior: "conditional-merge",
		registerPlanning: true,
	});

	assert.equal(
		h.adjustToolSetHandlerCount,
		2,
		"2 handler adjust_tool_set: 1 core stub + 1 discussion_arena:planning",
	);

	// EMIT 1: activeToolNames = base. coreTools assenti → core ATTIVO
	// (conditional-merge: ritorna input + coreTools). Short-circuita al
	// core. discussion_arena:planning MAI chiamato.
	h.emit("unit_start", { unitType: PLAN_UNIT });
	h.emit("adjust_tool_set", { activeToolNames: [...BASE_TOOLS] });

	assert.deepEqual(
		h.lastTools,
		[...BASE_TOOLS, ...CORE_TOOLS],
		"G3 emit 1: toolset = base + core tools (core conditional-merge ha mergiato, discussion_arena wrapper non chiamato)",
	);
	assert.equal(
		countOccurrences(h.lastTools, D_DISCUSSION_ARENA),
		0,
		"G3 emit 1: cardinalità discussion_arena = 0 (discussion_arena wrapper non ancora chiamato)",
	);
	assert.deepEqual(
		h.handlersCalled,
		["core"],
		"G3 emit 1: handlersCalled = [core] (core short-circuita, discussion_arena MAI chiamato)",
	);
	assert.equal(h.shortCircuit, true, "G3 emit 1: shortCircuit = true (core ha ritornato truthy)");

	// EMIT 2: catena di payload — activeToolNames = toolset del emit
	// precedente (= base + core tools). coreTools GIÀ presenti → core
	// PASSIVE (conditional-merge: ritorna undefined). Dispatcher cade
	// sul discussion_arena wrapper, che inietta discussion_arena. Coesistenza!
	h.emit("adjust_tool_set", { activeToolNames: [...h.lastTools] });

	assert.deepEqual(
		h.lastTools,
		[...BASE_TOOLS, ...CORE_TOOLS, D_DISCUSSION_ARENA],
		"G3 emit 2: toolset = base + core tools + discussion_arena (coesistenza via catena di payload)",
	);
	assert.equal(
		countOccurrences(h.lastTools, D_DISCUSSION_ARENA),
		1,
		"G3 emit 2: cardinalità discussion_arena = 1 (coesistenza, no duplicazione)",
	);
	for (const ct of CORE_TOOLS) {
		assert.equal(
			countOccurrences(h.lastTools, ct),
			1,
			`G3 emit 2: cardinalità tool core '${ct}' = 1 (preservato senza duplicazione)`,
		);
	}

	// (a) Audit log emit 2: ENTRAMBI chiamati in ordine (core passive +
	//     discussion_arena wrapper short-circuita dopo). Questo è il SUCCESS del workaround.
	assert.deepEqual(
		h.handlersCalled,
		["core", "discussion_arena:planning"],
		"G3 emit 2: handlersCalled = [core, discussion_arena:planning] (core passive + discussion_arena planning attivo)",
	);
	assert.equal(h.shortCircuit, true, "G3 emit 2: shortCircuit = true (discussion_arena:planning)");
	assert.equal(h.lastChanged, true, "G3 emit 2: lastChanged = true");
});

// ─── G4 — FORCING 3-GRUPPO simultaneo + core conditional-merge ────────────

test("G4: core conditional-merge + 3 gruppi discussion_arena (planning + research-decision + discussing) + 3 emits in catena → cardinalità discussion_arena = 1, tool del core preservati senza duplicazione", () => {
	const h = buildRaceHarness({
		coreBehavior: "conditional-merge",
		registerPlanning: true,
		registerResearchDecision: true,
		registerDiscussing: true,
	});

	// 4 handler `adjust_tool_set`: 1 core + 3 discussion_arena (uno per gruppo).
	assert.equal(
		h.adjustToolSetHandlerCount,
		4,
		"4 handler adjust_tool_set: 1 core + discussion_arena:planning + discussion_arena:research-decision + discussion_arena:discussing",
	);

	// Catena di payload su 3 unitType rappresentativi dei 3 gruppi.
	// Ogni emit: solo 1 dei 3 discussion_arena wrapper è `isActive` per il
	// current unitType (state machine `currentUnitTypeByApi`); gli altri 2
	// sono PASSIVE (return undefined). Il primo handler truthy short-circuita.

	// EMIT 1 (planning): coreTools assenti → core ATTIVO. discussion_arena:planning
	// attivo, ma dispatcher cade su core che è già truthy.
	h.emit("unit_start", { unitType: PLAN_UNIT });
	h.emit("adjust_tool_set", { activeToolNames: [...BASE_TOOLS] });
	assert.deepEqual(
		h.lastTools,
		[...BASE_TOOLS, ...CORE_TOOLS],
		"G4 emit 1 (planning): toolset = base + core tools (core short-circuita)",
	);
	assert.equal(
		countOccurrences(h.lastTools, D_DISCUSSION_ARENA),
		0,
		"G4 emit 1: cardinalità discussion_arena = 0 (discussion_arena wrapper non ancora chiamato)",
	);
	assert.deepEqual(
		h.handlersCalled,
		["core"],
		"G4 emit 1: handlersCalled = [core] (core active, discussion_arena wrapper mai chiamato)",
	);

	// EMIT 2 (research-decision): catena — activeToolNames = toolset emit 1
	// (= base + core tools). coreTools presenti → core PASSIVE.
	// discussion_arena:research-decision attivo, gli altri 2 PASSIVE. Dispatcher cade
	// su discussion_arena:research-decision che inietta discussion_arena.
	h.emit("unit_start", { unitType: RD_UNIT });
	h.emit("adjust_tool_set", { activeToolNames: [...h.lastTools] });

	// Dopo emit 2, il toolset dovrebbe contenere base + core tools +
	// discussion_arena (1 copia).
	assert.deepEqual(
		h.lastTools,
		[...BASE_TOOLS, ...CORE_TOOLS, D_DISCUSSION_ARENA],
		"G4 emit 2 (research-decision): toolset = base + core tools + discussion_arena (discussion_arena:research-decision ha iniettato)",
	);
	assert.equal(
		countOccurrences(h.lastTools, D_DISCUSSION_ARENA),
		1,
		"G4 emit 2: cardinalità discussion_arena = 1 (discussion_arena:research-decision primo truthy dopo core passive)",
	);
	for (const ct of CORE_TOOLS) {
		assert.equal(
			countOccurrences(h.lastTools, ct),
			1,
			`G4 emit 2: cardinalità tool core '${ct}' = 1 (preservato dal core conditional-merge)`,
		);
	}

	// Audit log emit 2: ordine di registrazione = core, discussion_arena:planning,
	// discussion_arena:research-decision, discussion_arena:discussing. Il dispatcher chiama in
	// ordine FINO al primo truthy:
	//   - core: PASSIVE (conditional-merge, coreTools presenti) → undefined
	//   - discussion_arena:planning: PASSIVE (unitType=research-decision ∉ {planning})
	//   - discussion_arena:research-decision: ATTIVO (unitType ∈ group) → truthy, SHORT-CIRCUIT
	// discussion_arena:discussing MAI chiamato perché il dispatcher è terminato
	// sul research-decision handler.
	assert.deepEqual(
		h.handlersCalled,
		["core", "discussion_arena:planning", "discussion_arena:research-decision"],
		"G4 emit 2: handlersCalled = [core, discussion_arena:planning, discussion_arena:research-decision] (core+planning PASSIVE, research-decision short-circuita, discussing MAI chiamato)",
	);
	assert.equal(h.shortCircuit, true, "G4 emit 2: shortCircuit = true (discussion_arena:research-decision)");

	// EMIT 3 (discussing): catena — activeToolNames = toolset emit 2.
	// coreTools ancora presenti → core PASSIVE. discussion_arena:discussing attivo,
	// gli altri 2 PASSIVE. Dispatcher cade su discussion_arena:discussing che inietta
	// (o meglio: la guardia interna `if (!toolNames.includes(...))`
	// protegge dalla duplicazione, quindi toolset invariato).
	h.emit("unit_start", { unitType: DISC_UNIT });
	h.emit("adjust_tool_set", { activeToolNames: [...h.lastTools] });

	assert.deepEqual(
		h.lastTools,
		[...BASE_TOOLS, ...CORE_TOOLS, D_DISCUSSION_ARENA],
		"G4 emit 3 (discussing): toolset = base + core tools + discussion_arena (idempotente: discussion_arena:discussing non duplica)",
	);
	assert.equal(
		countOccurrences(h.lastTools, D_DISCUSSION_ARENA),
		1,
		"G4 emit 3: cardinalità discussion_arena RESTA 1 (guardia interna hooks-unit-aware)",
	);
	for (const ct of CORE_TOOLS) {
		assert.equal(
			countOccurrences(h.lastTools, ct),
			1,
			`G4 emit 3: cardinalità tool core '${ct}' RESTA 1 (no duplicazione)`,
		);
	}

	// Audit log emit 3: core passive chiamato, discussion_arena:planning e
	// discussion_arena:research-decision MAI chiamati (perché il dispatcher
	// ordina per registration order: core, planning, research-decision,
	// discussing). discussion_arena:planning e discussion_arena:research-decision sono PASSIVE
	// (return undefined) per unitType=discussing, MA il dispatcher li
	// chiama comunque prima di arrivare ad discussion_arena:discussing.
	//
	// Ordine di registrazione: core, discussion_arena:planning, discussion_arena:research-decision,
	// discussion_arena:discussing. Per unitType=discussing:
	//   - core: PASSIVE (conditional-merge, coreTools presenti) → undefined
	//   - discussion_arena:planning: PASSIVE (unitType=discussing ∉ {planning}) → undefined
	//   - discussion_arena:research-decision: PASSIVE (unitType=discussing ∉ {research-decision}) → undefined
	//   - discussion_arena:discussing: ATTIVO (unitType=discussing ∈ discussing group)
	assert.deepEqual(
		h.handlersCalled,
		[
			"core",
			"discussion_arena:planning",
			"discussion_arena:research-decision",
			"discussion_arena:discussing",
		],
		"G4 emit 3: handlersCalled = [core, discussion_arena:planning, discussion_arena:research-decision, discussion_arena:discussing] (i primi 3 PASSIVE, discussion_arena:discussing short-circuita)",
	);
	assert.equal(h.shortCircuit, true, "G4 emit 3: shortCircuit = true (discussion_arena:discussing)");
	assert.equal(h.lastChanged, true, "G4 emit 3: lastChanged = true (discussion_arena:discussing ha ritornato truthy)");
});
