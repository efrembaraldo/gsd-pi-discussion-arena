/**
 * tests/integration/adjust-tool-set-race.test.ts — Test di integrazione
 * che chiude il contratto R016 (gap G5 della spec §2): attestare la
 * coesistenza e la race condition fra un listener `adjust_tool_set` del
 * CORE di gsd-pi (registrato per primo, ordine di caricamento reale
 * dell'ExtensionAPI) e i 3 wrapper della discussion arena (planning +
 * research-decision + discussing) registrati sullo stesso `ExtensionAPI`.
 *
 * Simula fedelmente il dispatcher `emitAdjustToolSet` di gsd-pi
 * (runner.js:899-933, contratto #1998): itera gli handler registrati
 * nell'ordine di registrazione, passa lo stesso payload a TUTTI (full
 * iteration, nessuno short-circuit first-wins), accumula il toolNames
 * override (PRIMO non-undefined vince — semantica legacy per listener
 * pure-override) e i delta removeTools/addTools, e compone
 * override → remove → add → dedup (Set, ordine stabile). Se nessun
 * handler ritorna un result il toolset resta invariato; un result senza
 * override né delta (es. `{}`) non blocca i listener successivi.
 * M019/S05 T3-closeout: il precedente modello short-circuit (primo
 * truthy vince) NON è più la semantica reale dell'host.
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
 *   G2 — CORE ATTIVO: il listener core ritorna un result con `toolNames`
 *        (active, no conditional-merge). Con la composizione #1998 il
 *        comportamento dipende dal ramo del listener discussion_arena
 *        (M019/S05 T3-closeout):
 *          - ramo LEGACY (env-assente): il listener planning ritorna un
 *            override `{ toolNames }`, ma il PRIMO override non-undefined
 *            vince — quello del core, registrato prima — quindi
 *            `discussion_arena` è assente dal toolset finale. È il
 *            debito residuo D097 sul ramo legacy (priority: 100 del
 *            manifest non letto dal loader), attestato onestamente.
 *          - ramo DELTA (GSD_VERSION=1.21.0): il listener planning
 *            ritorna `{ addTools: [discussion_arena] }` che è ACCUMULATO
 *            dal dispatcher full-iteration e composto DOPO l'override
 *            del core → coesistenza: toolset = base + coreTools +
 *            discussion_arena. Il debito D097 è risolto dal contratto
 *            #1998 sul ramo delta.
 *        In ENTRAMBI i rami il dispatcher full-iteration chiama ENTRAMBI
 *        gli handler (nessuno short-circuit).
 *
 *   G3 — CORE CONDITIONAL MERGE (workaround D097) + catena di payload:
 *        il listener core applica il workaround noto: ritorna PASSIVE
 *        (`undefined`) se i suoi tool sono già nel toolset in ingresso,
 *        altrimenti ritorna `toolNames = [...input, ...CORE_TOOLS]`. La
 *        catena di payload propaga il toolset del previous emit come
 *        `activeToolNames` del successivo (pattern reale del framework
 *        quando il toolset forzato persiste tra adjust_tool_set
 *        consecutivi sullo stesso turn). Risultato atteso dopo 2
 *        emits (full iteration #1998, M019/S05 T3-closeout):
 *          - emit 1 (activeToolNames = base): core ATTIVO (coreTools
 *            assenti) → override core = base + coreTools; il listener
 *            planning è comunque CHIAMATO (nessuno short-circuit): sul
 *            ramo legacy il suo override è oscurato (first-wins), sul
 *            ramo delta il suo addTools è composto → toolset emit 1
 *            dipende dal ramo (senza/con discussion_arena).
 *          - emit 2 (activeToolNames = toolset emit 1, catena): core
 *            PASSIVE (coreTools già presenti) → i due rami CONVERGONO:
 *            toolset = base + coreTools + discussion_arena, cardinalità
 *            1 ciascuno.
 *        `handlersCalled` contiene ENTRAMBI i tag su entrambi gli emits
 *        (full iteration).
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
 * (S03): quel file copre SOLO il namespace della discussion arena. Questo
 * file copre la coesistenza con un listener core ESTERNO e usa la
 * semantica REAL del dispatcher di gsd-pi (full iteration #1998:
 * override first-wins + delta accumulati).
 *
 * NON si sovrappone a `tests/hooks-coexist-multigroup.test.ts` (S06):
 * quel file copre 3 gruppi della discussion arena ma NESSUN listener
 * core esterno.
 *
 * Nessuna metrica nuova, nessuna superficie runtime nuova. Il test NON
 * emette `tool_call` né `before_agent_start` (l'assertion su
 * `adjust_tool_set` è isolata), quindi i counter
 * `discussion_arena_on_demand_total` e `discussion_arena_forced_total`
 * non vengono toccati e non c'è rischio di contaminazione cross-test
 * dello stato metriche globale. L'unica strumentazione aggiunta è
 * interna all'harness (audit log `handlersCalled`) e serve a rendere
 * l'iterazione del dispatcher ispezionabile invece che dedotta dal solo
 * toolset finale.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";

import { composeAdjustToolSetResults } from "../_helpers/adjust-composition.js";
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

/** Unit-type rappresentativi dei 3 gruppi della discussion arena.
 * M010/S02/T02: PLAN_UNIT è ora `plan-milestone` (membro canonico di
 * `ACTIVE_UNIT_TYPES.planning`, frozen Set di 6 unit-type da T01) invece
 * del legacy `planning` che non è più nel gruppo post-T01. */
const PLAN_UNIT = "plan-milestone" as const;
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
 *     — simula un core pure-override il cui override vince per primo sul
 *     ramo legacy (first-wins, debito D097 attestato in G2); sul ramo
 *     delta il suo override coesiste con il delta discussion_arena.
 *   - `"conditional-merge"`: ritorna PASSIVE (`undefined`) se TUTTI i
 *     `CORE_TOOLS` sono già nel toolset in ingresso (merge già applicato
 *     da un emit precedente nella catena di payload), altrimenti ritorna
 *     l'input mergiato con `CORE_TOOLS`. Simula il workaround D097 che
 *     permette la coesistenza tramite la catena di payload (G3, G4).
 */
type CoreBehavior = "passive" | "active" | "conditional-merge";

/**
 * Setta/rimuove `process.env.GSD_VERSION` per la durata di `fn` e ripristina
 * il valore precedente (anche se `fn` lanza). Pattern copiato da
 * tests/runtime-classifier.test.ts e
 * tests/integration/adjust-tool-set-idempotency.test.ts (riferimenti, NON
 * modificati). NB (MEM387): in questo ambiente `GSD_VERSION` può essere
 * impostata dall'host (verification gate) — i rami env-assente DEVONO
 * essere avvolti esplicitamente o il ramo delta è attivo di default.
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
	 *  `emit("adjust_tool_set")`. Con la composizione #1998 TUTTI gli
	 *  handler registrati sono chiamati (full iteration, nessuno
	 *  short-circuit). Reset a ogni emit di `adjust_tool_set`. Per gli
	 *  altri eventi (es. unit_start) è una side-list non resettata
	 *  (vedi `unitStartCalled`). */
	readonly handlersCalled: ReadonlyArray<string>;
	/** `unit_start` tags chiamati dall'ultimo `emit("unit_start")`. */
	readonly unitStartCalled: ReadonlyArray<string>;
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
 * gsd-pi (runner.js:899-933, contratto #1998): ordine di registrazione,
 * iterazione COMPLETA di tutti gli handler (nessuno short-circuit),
 * override toolNames first-wins, delta removeTools/addTools accumulati,
 * composizione override → remove → add → dedup (via
 * `composeAdjustToolSetResults`, la stessa semantica upstream); audit log
 * dei chiamati.
 * M019/S05 T3-closeout: il precedente modello "short-circuit al primo
 * truthy" non è più la semantica reale dell'host.
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
			// Reset audit log per emit (l'audit è per-assertion, non
			// cumulativo tra assert diverse).
			handlersCalled.length = 0;
			// Composizione upstream #1998 (runner.js:899-933): full iteration
			// (TUTTI gli handler chiamati in ordine di registrazione, nessuno
			// short-circuit), override toolNames first-wins, delta accumulati,
			// override → remove → add → dedup.
			const results: unknown[] = [];
			for (const { fn, tag } of taggedHandlers.get(eventName) ?? []) {
				results.push(fn(payload));
				handlersCalled.push(tag);
			}
			const composed = composeAdjustToolSetResults(
				results,
				(payload.activeToolNames as string[]) ?? [],
			);
			lastTools = composed?.toolNames ?? [...(payload.activeToolNames as string[])];
			lastChanged = composed?.toolNames !== undefined;
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

	// (b) Audit log: TUTTI gli handler chiamati in ordine di registrazione
	//     (full iteration #1998: nessuno short-circuit, il core passivo
	//     ritorna undefined ma è comunque chiamato, e il listener planning
	//     dopo di lui pure).
	assert.deepEqual(
		h.handlersCalled,
		["core", "discussion_arena:planning"],
		"G1 handlersCalled = [core, discussion_arena:planning]: dispatcher full-iteration chiama ENTRAMBI in ordine",
	);

	// (c) changed = true (toolset finale ≠ activeToolNames del payload).
	assert.equal(h.lastChanged, true, "G1 lastChanged = true (toolset finale modificato)");

	// (e) Core tools NON sono presenti (core era passivo).
	for (const ct of CORE_TOOLS) {
		assert.ok(
			!h.lastTools.includes(ct),
			`G1 toolset NON contiene tool core '${ct}' (core era passivo)`,
		);
	}
});

// ─── G2 — CORE ATTIVO: override core + delta discussion_arena (#1998) ─────

test("G2: core attivo + 1 discussion_arena planning attivo → coesistenza override+delta su host 1.21.0 (#1998 risolve D097); debito D097 residuo SOLO sul ramo legacy (override core first-wins)", async () => {
	// ── Ramo LEGACY (env-assente): debito D097 attestato onestamente ──
	// Il listener planning ritorna un override `{ toolNames }`, ma il
	// PRIMO override non-undefined vince (#1998 semantica legacy) — quello
	// del core, registrato prima → discussion_arena assente.
	await withGSDVersion(undefined, () => {
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

		assert.deepEqual(
			h.lastTools,
			[...BASE_TOOLS, ...CORE_TOOLS],
			"G2 legacy: toolset = [a, b, core-tool-x, core-tool-y] (override core first-wins, override legacy di planning oscurato — debito D097)",
		);
		assert.equal(
			countOccurrences(h.lastTools, D_DISCUSSION_ARENA),
			0,
			"G2 legacy: cardinalità discussion_arena = 0 (debito residuo D097 attestato onestamente)",
		);
		for (const ct of CORE_TOOLS) {
			assert.ok(
				h.lastTools.includes(ct),
				`G2 legacy: toolset contiene tool core '${ct}' (override core vince)`,
			);
			assert.equal(
				countOccurrences(h.lastTools, ct),
				1,
				`G2 legacy: cardinalità tool core '${ct}' = 1 (dedup Set)`,
			);
		}

		// Full iteration #1998: ENTRAMBI chiamati anche se l'override del
		// core vince (nessuno short-circuit).
		assert.deepEqual(
			h.handlersCalled,
			["core", "discussion_arena:planning"],
			"G2 legacy: handlersCalled = [core, discussion_arena:planning] (full iteration, nessuno short-circuit)",
		);
		assert.equal(h.lastChanged, true, "G2 legacy: lastChanged = true");
	});

	// ── Ramo DELTA (host 1.21.0): il debito D097 è RISOLTO da #1998 ──
	// Il listener planning ritorna `{ addTools: [discussion_arena] }` che
	// è ACCUMULATO dal dispatcher full-iteration e composto DOPO
	// l'override del core → coesistenza.
	await withGSDVersion("1.21.0", () => {
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

		assert.deepEqual(
			h.lastTools,
			[...BASE_TOOLS, ...CORE_TOOLS, D_DISCUSSION_ARENA],
			"G2 delta: toolset = [a, b, core-tool-x, core-tool-y, discussion_arena] (override core + addTools planning composti da #1998)",
		);
		assert.equal(
			countOccurrences(h.lastTools, D_DISCUSSION_ARENA),
			1,
			"G2 delta: cardinalità discussion_arena = 1 (delta coesiste con l'override core, dedup Set)",
		);
		for (const ct of CORE_TOOLS) {
			assert.ok(
				h.lastTools.includes(ct),
				`G2 delta: toolset contiene tool core '${ct}' (override core preservato)`,
			);
			assert.equal(
				countOccurrences(h.lastTools, ct),
				1,
				`G2 delta: cardinalità tool core '${ct}' = 1 (no duplicazione)`,
			);
		}

		assert.deepEqual(
			h.handlersCalled,
			["core", "discussion_arena:planning"],
			"G2 delta: handlersCalled = [core, discussion_arena:planning] (full iteration)",
		);
		assert.equal(h.lastChanged, true, "G2 delta: lastChanged = true");
	});
});

// ─── G3 — CORE CONDITIONAL MERGE (workaround D097) + catena di payload ────

test("G3: core conditional-merge + 1 discussion_arena planning + 2 emits in catena di payload → discussion_arena e tool del core coesistono con cardinalità 1 ciascuno", async () => {
	for (const gsdVersion of [undefined, "1.21.0"] as const) {
		await withGSDVersion(gsdVersion, () => {
			const branch = gsdVersion === undefined ? "legacy" : "delta";
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
			// (conditional-merge: override = input + coreTools). Il listener
			// planning è COMUNQUE chiamato (full iteration #1998): sul ramo
			// legacy il suo override è oscurato (first-wins), sul ramo delta
			// il suo addTools è composto dopo l'override core.
			h.emit("unit_start", { unitType: PLAN_UNIT });
			h.emit("adjust_tool_set", { activeToolNames: [...BASE_TOOLS] });

			assert.deepEqual(
				h.lastTools,
				[...BASE_TOOLS, ...CORE_TOOLS, ...(branch === "delta" ? [D_DISCUSSION_ARENA] : [])],
				`G3 emit 1 (${branch}): legacy → base + core tools (override planning oscurato); delta → base + core tools + discussion_arena (addTools composto)`,
			);
			assert.deepEqual(
				h.handlersCalled,
				["core", "discussion_arena:planning"],
				`G3 emit 1 (${branch}): handlersCalled = [core, discussion_arena:planning] (full iteration, nessuno short-circuit)`,
			);

			// EMIT 2: catena di payload — activeToolNames = toolset del emit
			// precedente. coreTools GIÀ presenti → core PASSIVE
			// (conditional-merge: ritorna undefined). I DUE RAMI CONVERGONO:
			//   legacy: override planning = [..prev, da] (guarded) → toolset
			//   delta: base = prev, addTools [da] → dedup → toolset
			h.emit("adjust_tool_set", { activeToolNames: [...h.lastTools] });

			assert.deepEqual(
				h.lastTools,
				[...BASE_TOOLS, ...CORE_TOOLS, D_DISCUSSION_ARENA],
				`G3 emit 2 (${branch}): toolset = base + core tools + discussion_arena (coesistenza via catena di payload)`,
			);
			assert.equal(
				countOccurrences(h.lastTools, D_DISCUSSION_ARENA),
				1,
				`G3 emit 2 (${branch}): cardinalità discussion_arena = 1 (coesistenza, no duplicazione)`,
			);
			for (const ct of CORE_TOOLS) {
				assert.equal(
					countOccurrences(h.lastTools, ct),
					1,
					`G3 emit 2 (${branch}): cardinalità tool core '${ct}' = 1 (preservato senza duplicazione)`,
				);
			}

			// Audit log emit 2: ENTRAMBI chiamati in ordine (core passive +
			// discussion_arena planning attivo). Questo è il SUCCESS del workaround.
			assert.deepEqual(
				h.handlersCalled,
				["core", "discussion_arena:planning"],
				`G3 emit 2 (${branch}): handlersCalled = [core, discussion_arena:planning] (core passive + discussion_arena planning attivo)`,
			);
			assert.equal(
				h.lastChanged,
				true,
				`G3 emit 2 (${branch}): lastChanged = true`,
			);
		});
	}
});

// ─── G4 — FORCING 3-GRUPPO simultaneo + core conditional-merge ────────────

test("G4: core conditional-merge + 3 gruppi discussion_arena (planning + research-decision + discussing) + 3 emits in catena → cardinalità discussion_arena = 1, tool del core preservati senza duplicazione", async () => {
	for (const gsdVersion of [undefined, "1.21.0"] as const) {
		await withGSDVersion(gsdVersion, () => {
			const branch = gsdVersion === undefined ? "legacy" : "delta";
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
			// sono PASSIVE (return undefined). Full iteration #1998: TUTTI gli
			// handler sono chiamati a ogni emit.

			// EMIT 1 (planning): coreTools assenti → core ATTIVO (override =
			// base + coreTools). discussion_arena:planning attivo: legacy →
			// override oscurato (first-wins); delta → addTools composto.
			h.emit("unit_start", { unitType: PLAN_UNIT });
			h.emit("adjust_tool_set", { activeToolNames: [...BASE_TOOLS] });
			assert.deepEqual(
				h.lastTools,
				[...BASE_TOOLS, ...CORE_TOOLS, ...(branch === "delta" ? [D_DISCUSSION_ARENA] : [])],
				`G4 emit 1 (${branch}): legacy → base + core tools (override planning oscurato); delta → base + core tools + discussion_arena`,
			);
			assert.deepEqual(
				h.handlersCalled,
				["core", "discussion_arena:planning", "discussion_arena:research-decision", "discussion_arena:discussing"],
				`G4 emit 1 (${branch}): handlersCalled = tutti e 4 (full iteration, nessuno short-circuit)`,
			);

			// EMIT 2 (research-decision): catena — activeToolNames = toolset
			// emit 1. coreTools presenti → core PASSIVE. Solo il wrapper
			// research-decision è attivo; i DUE RAMI CONVERGONO:
			//   legacy: override research-decision = [...prev, da] (guarded)
			//   delta: base = prev, addTools [da] → dedup
			h.emit("unit_start", { unitType: RD_UNIT });
			h.emit("adjust_tool_set", { activeToolNames: [...h.lastTools] });

			assert.deepEqual(
				h.lastTools,
				[...BASE_TOOLS, ...CORE_TOOLS, D_DISCUSSION_ARENA],
				`G4 emit 2 (${branch}): toolset = base + core tools + discussion_arena (cardinalità 1, rami convergenti)`,
			);
			assert.equal(
				countOccurrences(h.lastTools, D_DISCUSSION_ARENA),
				1,
				`G4 emit 2 (${branch}): cardinalità discussion_arena = 1`,
			);
			for (const ct of CORE_TOOLS) {
				assert.equal(
					countOccurrences(h.lastTools, ct),
					1,
					`G4 emit 2 (${branch}): cardinalità tool core '${ct}' = 1 (preservato senza duplicazione)`,
				);
			}
			assert.deepEqual(
				h.handlersCalled,
				["core", "discussion_arena:planning", "discussion_arena:research-decision", "discussion_arena:discussing"],
				`G4 emit 2 (${branch}): handlersCalled = tutti e 4 in ordine di registrazione (full iteration)`,
			);

			// EMIT 3 (discussing): catena — activeToolNames = toolset emit 2.
			// core PASSIVE, solo il wrapper discussing è attivo. Idempotenza:
			// legacy → override guarded (da già presente, no push); delta →
			// addTools [da] dedup. Toolset INVARIATO in entrambi i rami.
			h.emit("unit_start", { unitType: DISC_UNIT });
			h.emit("adjust_tool_set", { activeToolNames: [...h.lastTools] });

			assert.deepEqual(
				h.lastTools,
				[...BASE_TOOLS, ...CORE_TOOLS, D_DISCUSSION_ARENA],
				`G4 emit 3 (${branch}): toolset = base + core tools + discussion_arena (idempotente: discussion_arena:discussing non duplica)`,
			);
			assert.equal(
				countOccurrences(h.lastTools, D_DISCUSSION_ARENA),
				1,
				`G4 emit 3 (${branch}): cardinalità discussion_arena RESTA 1 (guardia interna hooks-unit-aware + dedup host)`,
			);
			for (const ct of CORE_TOOLS) {
				assert.equal(
					countOccurrences(h.lastTools, ct),
					1,
					`G4 emit 3 (${branch}): cardinalità tool core '${ct}' RESTA 1 (no duplicazione)`,
				);
			}
			assert.deepEqual(
				h.handlersCalled,
				["core", "discussion_arena:planning", "discussion_arena:research-decision", "discussion_arena:discussing"],
				`G4 emit 3 (${branch}): handlersCalled = tutti e 4 (full iteration; i primi 3 PASSIVE per unitType=discussing)`,
			);
			assert.equal(
				h.lastChanged,
				true,
				`G4 emit 3 (${branch}): lastChanged = true (il wrapper attivo ha prodotto un result)`,
			);
		});
	}
});
