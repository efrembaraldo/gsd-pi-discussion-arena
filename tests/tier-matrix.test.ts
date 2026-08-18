/**
 * Test behaviorali end-to-end (black-box via activate(api)) della tier-matrix
 * su 3 configurazioni mock F/A/D + idempotenza one-shot.
 *
 * Slice S05/M010 — chiude R015 verificando che il wiring
 * `classifyRuntime → activate(api) → attach*Hooks → strumentazione
 * (metrics + stderr NDJSON)` produca, per ciascun tier deterministico:
 *
 *   Tier F (Full):       nessuna stderr DEGRADED, nessun recordDegraded.
 *                        counter forced_total{phase} osservabile quando il
 *                        trigger resolver decide "forced" e unit_start +
 *                        before_agent_start sono emessi.
 *                        counter on_demand_total{phase} osservabile a ogni
 *                        invocazione di tool_call{toolName=discussion_arena}.
 *                        stderr NDJSON: discussionArena.forced +
 *                        discussionArena.on_demand.
 *
 *   Tier A (Available):  stesso surface di F per gli hook supportati; gli
 *                        hook `unit_start` (non supportati) NON scattano il
 *                        forced. Nessuna stderr DEGRADED, nessun
 *                        recordDegraded. tool_call on-demand osservabile.
 *
 *   Tier D (Degraded):   stderr one-shot `[discussion-arena DEGRADED]`
 *                        con prefisso canonico + counter
 *                        discussion_arena_degraded_total{reason=<code>}
 *                        incrementato 1 volta per ogni capability mancante.
 *                        forza gli hook di registrazione in registration
 *                        phase ma i dispatch (mock che rispetta
 *                        `supportedSet`) non li fanno scattare.
 *
 *   Idempotenza:         2 chiamate `activate()` con Tier D → 1 sola riga
 *                        stderr (la chiave `tier:D:first-activate` è
 *                        modulo-scope in `emitDeprecationWarningOnce`,
 *                        S03/M007). Garantisce che il pattern one-shot non
 *                        spammi stderr durante run prolungate.
 *
 * Architettura del mock api (la novità rispetto a `tests/index.test.ts:T07`,
 * che si limitava a throw-on-unsupported senza dispatcher):
 *
 *   1. `api.on(event, handler)` ha DUE fasi distinte tracciate da un
 *      contatore di probe:
 *        - I primi 4 call (probe phase, ordine deterministico da
 *          `runtime-classifier.PROBE_HOOKS`): se l'evento è in `supported`
 *          ritorna undefined (probe riuscito), altrimenti lancia
 *          sincronamente (probe fallito → capability assente).
 *        - I call successivi (registration phase): accumulano il handler in
 *          una Map interna silenziosamente — il runtime reale permette
 *          sempre la registrazione anche per eventi non supportati.
 *
 *   2. `api.emit(event, payload)` è il dispatcher di test (NON presente
 *      sull'ExtensionAPI reale): simula il framework invocando i handler
 *      registrati in ordine di inserimento, MA rispetta `supportedSet`
 *      (mimica il runtime reale che non emette eventi non supportati).
 *
 *   3. `api.registerTool` / `api.registerCommand` sono no-op (non usati
 *      in questi test: lo strumentazione di forced/on_demand vive sugli
 *      hook `before_agent_start` / `tool_call`).
 *
 * Differenze rispetto al mock T07 (`tests/index.test.ts`):
 *   - T07 mock: `api.on` lancia SEMPRE per gli eventi non in `supported`.
 *     Usato per asserire SOLO il side-effect Tier D, NON il dispatch.
 *   - Questo mock: distingue probe (throw se unsupported) da registration
 *     (silent accumulate). Permette di esercitare la catena completa
 *     `activate → resolveTrigger.then → attach*Hooks → dispatch`.
 *
 * Il file rispetta il path imposto dalla roadmap (`tests/tier-matrix.test.ts`
 * ATOP-LO, NON `tests/integration/`): la stessa suite copre i 3 tier + il
 * pattern one-shot senza dipendenze da `tests/integration/*`.
 */

import { beforeEach, test } from "node:test";
import * as assert from "node:assert/strict";
import activate from "../index.js";
import { classifyRuntime } from "../src/runtime-classifier.js";
import { getMetrics, resetMetrics } from "../metrics.js";
import { __resetDeprecationWarnings } from "../src/deprecation.js";

// ─── Scaffolding condiviso ────────────────────────────────────────────────

interface TierRuntimeApi {
	on: (event: string, handler: unknown) => unknown;
	emit: (event: string, payload: unknown) => unknown;
	registerTool: (cfg: unknown) => unknown;
	registerCommand: (name: string, cfg: unknown) => unknown;
}

/** I 4 hook probeati da `runtime-classifier.safeProbe` (ordine deterministico). */
const PROBE_EVENTS: ReadonlySet<string> = new Set([
	"before_agent_start",
	"adjust_tool_set",
	"unit_start",
	"tool_call",
]);

/**
 * Mock api che distingue probe vs registrazione hook + dispatcher.
 *
 * @param opts.supported Elenco eventi supportati dal runtime. `api.on`
 *   lancia sincronamente se l'evento è tra i 4 PROBE_EVENTS e non in
 *   `supported` (probe fail deterministico), altrimenti ritorna undefined.
 *   `milestone_start` deve SEMPRE essere incluso (viene letto da
 *   `attachDiscussionArenaWizard` in modo sincrono dentro activate).
 */
function makeRuntimeApiForTier(opts: {
	supported: readonly string[];
}): TierRuntimeApi {
	const supportedSet = new Set(opts.supported);
	const handlers = new Map<string, Array<(payload: unknown) => unknown>>();
	let probeCount = 0;
	const EXPECTED_PROBES = 4;

	return {
		on: (event: string, handler: unknown): unknown => {
			// Fase 1: probe. I primi 4 `api.on` per eventi in PROBE_EVENTS sono
			// le probe di `runtime-classifier.safeProbe`. Throw sincrono per
			// capability mancanti (mimica il framework reale che rifiuta
			// subscription su eventi non supportati).
			if (PROBE_EVENTS.has(event) && probeCount < EXPECTED_PROBES) {
				probeCount++;
				if (!supportedSet.has(event)) {
					throw new Error(`api.on probe rejected for unsupported event: ${event}`);
				}
				return undefined;
			}
			// Fase 2: registrazione hook. Tutti i call successivi accumulano
			// il handler silenziosamente — il runtime reale permette la
			// registrazione anche per eventi non supportati.
			const list = handlers.get(event) ?? [];
			list.push(handler as (payload: unknown) => unknown);
			handlers.set(event, list);
			return undefined;
		},
		emit: (event: string, payload: unknown): unknown => {
			// Dispatcher di test (NON parte di ExtensionAPI reale). Rispetta
			// `supportedSet`: il runtime reale non emette eventi non
			// supportati, quindi i nostri handler non scattano se il tier
			// non li copre (preserva la differenza osservabile F vs A vs D).
			if (!supportedSet.has(event)) return undefined;
			const list = handlers.get(event) ?? [];
			let lastResult: unknown;
			for (const h of list) {
				const r = h(payload);
				if (r !== undefined) lastResult = r;
			}
			return lastResult;
		},
		registerTool: (_cfg: unknown): unknown => ({}),
		registerCommand: (_name: string, _cfg: unknown): unknown => ({}),
	};
}

/**
 * Drena microtask + macrotask per consentire al chain
 * `activate(api) → resolveTrigger().then() → attach*Hooks(api, ...)` di
 * completare. La catena ha ≥3 await interni (resolveTrigger legge PREFERENCES
 * via `fs.readFile`, classification passa per 4 probe sync ma la registrazione
 * hook è nel .then()). 5× setImmediate è conservativo ma garantisce il
 * quiescenza prima del dispatch degli eventi di test.
 */
async function flushActivate(): Promise<void> {
	for (let i = 0; i < 5; i++) {
		await new Promise<void>((r) => setImmediate(r));
	}
}

/**
 * Cattura `process.stderr.write` durante una `fn` async e lo ripristina
 * sempre (anche su throw). Necessario per osservare sia le stderr scritte
 * sincrone (es. `[discussion-arena DEGRADED]` in Tier D) sia quelle
 * asincrone post-`activate` (NDJSON `discussionArena.forced` /
 * `discussionArena.on_demand` emessi dentro i hook dopo il dispatch).
 */
async function captureStderrAsync<T>(
	fn: () => Promise<T>,
): Promise<{ result: T; lines: string[] }> {
	const lines: string[] = [];
	const original = process.stderr.write.bind(process.stderr);
	process.stderr.write = ((chunk: unknown) => {
		lines.push(String(chunk));
		return true;
	}) as unknown as typeof process.stderr.write;
	try {
		const result = await fn();
		return { result, lines };
	} finally {
		process.stderr.write = original;
	}
}

/** Setta env per la durata di `fn`, ripristina anche su throw. */
async function withEnv<T>(
	env: Readonly<Record<string, string | undefined>>,
	fn: () => Promise<T>,
): Promise<T> {
	const saved: Record<string, string | undefined> = {};
	for (const [k, v] of Object.entries(env)) {
		saved[k] = process.env[k];
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	try {
		return await fn();
	} finally {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

/**
 * Eventi supportati comuni a tutte le tier config: `milestone_start` è
 * letto sincronamente da `attachDiscussionArenaWizard` durante activate —
 * senza supporto la registrazione lancerebbe e `activate()` non
 * raggiungerebbe `api.registerTool`/`registerCommand`. La slice S05 lo
 * include in tutti i mock come contratto del T07 wiring
 * (`tests/index.test.ts:T07`).
 */
const WIZARD_EVENT = "milestone_start";
const TIER_F_SUPPORTED: readonly string[] = [
	"before_agent_start",
	"adjust_tool_set",
	"unit_start",
	"tool_call",
	WIZARD_EVENT,
];

/**
 * Tier A: GSD_VERSION valido + `before_agent_start`, `adjust_tool_set`,
 * `tool_call` in supported. `unit_start` MANCANTE → classification "A" con
 * reasons=["no_unit_start"]. `unit_start` non viene mai dispatchato
 * (mock dispatcher rifiuta per supportedSet mancante) → `currentUnitType`
 * della state machine resta al sentinella `"unknown"` e blocca `isActive()`
 * per TUTTI i 6 marker di `attachUnitAwareHooks` (planning,
 * research-decision, research, discussing, executing, verifying: nessuno ha
 * `"unknown"` nel proprio activeUnitTypes). forzatura NON osservata;
 * tool_call on-demand osservata con phase="unknown".
 */
const TIER_A_SUPPORTED: readonly string[] = [
	"before_agent_start",
	"adjust_tool_set",
	"tool_call",
	WIZARD_EVENT,
];

/**
 * Tier D: nessuno dei 4 probe events in supported + GSD_VERSION non parsato.
 * Short-circuit su `parsedSemver === null` → reasons = ["no_GSD_VERSION"]
 * (i 3 hook reasons NON pushed in questo branch, conformemente al
 * `src/runtime-classifier.ts`). Il trigger resolver fallback a Tier 3 →
 * decision="available-only" → il messaggio stderr DEGRADED include
 * `availability-only` come contratto.
 */
const TIER_D_SUPPORTED: readonly string[] = [WIZARD_EVENT];

// Isolamento del registry metrico singleton + deprecation dedup set
// (pattern identico a `tests/index.test.ts:T07` e `tests/metrics.test.ts`).
beforeEach(() => {
	resetMetrics();
	__resetDeprecationWarnings();
});

// ─── T01 — Test Tier F end-to-end (modello per T02) ────────────────────────

test("Tier F end-to-end (modello): classifyRuntime=F + activate silente + dispatch forced + on_demand osservati", async () => {
	await withEnv({ GSD_VERSION: "1.15.0", GSD_DISCUSSION_ARENA_AUTO: "1" }, async () => {
		// (a) Asserzione PURO sulla classification Tier F. Usa un api separato
		// (`apiProbe`) perché la sequenza classifyRuntime + activate sullo
		// stesso api consumerebbe i 4 probe slots del mock, lasciando
		// classifyRuntime interna ad activate con tutti i probe in fase di
		// registrazione (silenziosamente accettati) — falsificherebbe la
		// classification reale. Due api distinti: uno per il contratto puro,
		// uno per il wiring behaviorale.
		const apiProbe = makeRuntimeApiForTier({ supported: TIER_F_SUPPORTED });
		const classification = classifyRuntime(apiProbe);
		assert.equal(classification.tier, "F", "classifyRuntime puro → Tier F");
		assert.equal(classification.capabilities.size, 4);
		assert.deepEqual(
			[...classification.capabilities].sort(),
			[
				"adjust_tool_set",
				"before_agent_start",
				"tool_call",
				"unit_start",
			],
			"tutte e 4 le capability presenti in ordine lessicografico",
		);
		assert.deepEqual(
			[...classification.reasons],
			[],
			"reasons vuote per Tier F",
		);

		// (b) Wiring behaviorale: activate(api) + drain + dispatch eventi.
		const api = makeRuntimeApiForTier({ supported: TIER_F_SUPPORTED });
		const { lines } = await captureStderrAsync(async () => {
			activate(api as unknown as Parameters<typeof activate>[0]);
			await flushActivate();
			// Sequenza reale del framework: unit_start apre la state machine
			// (currentUnitType = event.unitType per ogni closure di marker),
			// before_agent_start osserva il forced injection SOLO per i marker
			// il cui activeUnitTypes contiene l'unitType corrente.
			// NB: `attachDiscussionArenaHooks` (planning marker) consuma da
			// M010/S02/T01 `ACTIVE_UNIT_TYPES.planning` (frozen Set canonico
			// di 6 unit-type: plan-milestone, plan-slice, refine-slice,
			// replan-slice, replan-task, gate-evaluate). Dispatchando
			// unitType="plan-milestone" SOLO il planning marker ha
			// isActive()=true. Stesso pattern per gli altri 5 marker.
			// tool_call osserva l'on-demand invocation del tool
			// discussion_arena.
			api.emit("unit_start", { unitType: "plan-milestone" });
			api.emit("before_agent_start", { systemPrompt: "Sei un agente di test." });
			api.emit("tool_call", {
				type: "tool_call",
				toolName: "discussion_arena",
			});
		});

		// (c) Nessuna stderr DEGRADED, nessun recordDegraded: il tier non
		// è D (è F) → il ramo Tier D di activate() resta non eseguito.
		const degradedLines = lines.filter((l) =>
			l.includes("[discussion-arena DEGRADED]"),
		);
		assert.equal(
			degradedLines.length,
			0,
			"Tier F: nessuna stderr `[discussion-arena DEGRADED]` emessa",
		);
		assert.equal(
			getMetrics().counters["discussion_arena_degraded_total"],
			undefined,
			"Tier F: nessun recordDegraded chiamato (counter assente)",
		);

		// (d) Counter forced: il marker `planning` ha
		// activeUnitTypes = Set(["planning"]) (literal phase, NON i planning-
		// unitTypes del gruppo ACTIVE_UNIT_TYPES.planning). unitType="planning"
		// ∈ activeUnitTypes → isActive() true → forced injection osservata.
		// Gli altri 5 marker (research-decision, research, discussing,
		// executing, verifying) hanno activeUnitTypes che NON includono
		// "planning" → isActive() false → nessun forced.
		// Risultato netto: 1 singolo increment forced per phase=planning.
		// phase=planning via resolvePhaseLabel("planning"): "planning" è
		// chiave di ACTIVE_UNIT_TYPES (controllo secondario di resolvePhaseLabel
		// dopo unitTypeToArenaGroup).
		const forced = getMetrics().counters["discussion_arena_forced_total"];
		assert.ok(
			forced,
			"counter discussion_arena_forced_total presente dopo before_agent_start",
		);
		assert.equal(
			forced["{phase=planning}"],
			1,
			"esattamente 1 forced per phase=planning (solo marker planning attivo)",
		);

		// (e) Counter on_demand: il listener tool_call è singleton (D107)
		// → una sola increment per invocazione di discussion_arena,
		// indipendentemente dal numero di marker attivi.
		const onDemand = getMetrics().counters["discussion_arena_on_demand_total"];
		assert.ok(
			onDemand,
			"counter discussion_arena_on_demand_total presente dopo tool_call",
		);
		assert.equal(
			onDemand["{phase=planning}"],
			1,
			"esattamente 1 on_demand per phase=planning (listener singleton)",
		);

		// (f) NDJSON stderr: 2 eventi distinti
		//     (discussionArena.forced + discussionArena.on_demand) con
		//     phase=planning e shape canonico `ts,level,event,...`.
		const forcedLines = lines.filter((l) =>
			l.includes("discussionArena.forced"),
		);
		assert.ok(
			forcedLines.length >= 1,
			"stderr NDJSON `discussionArena.forced` emesso",
		);
		const parsedForced = JSON.parse(forcedLines[0]!.trim());
		assert.equal(parsedForced.event, "discussionArena.forced");
		assert.equal(parsedForced.level, "info");
		assert.equal(parsedForced.phase, "planning");
		assert.equal(parsedForced.tier, "F");

		const onDemandLines = lines.filter((l) =>
			l.includes("discussionArena.on_demand"),
		);
		assert.ok(
			onDemandLines.length >= 1,
			"stderr NDJSON `discussionArena.on_demand` emesso",
		);
		const parsedOnDemand = JSON.parse(onDemandLines[0]!.trim());
		assert.equal(parsedOnDemand.event, "discussionArena.on_demand");
		assert.equal(parsedOnDemand.level, "info");
		assert.equal(parsedOnDemand.phase, "planning");
		assert.equal(parsedOnDemand.toolName, "discussion_arena");
	});
});

// ─── T02 — Test Tier A end-to-end ─────────────────────────────────────────

test("Tier A end-to-end: classifyRuntime=A (no_unit_start) + activate silente + dispatch on_demand con phase=unknown (forced mai triggered)", async () => {
	await withEnv({ GSD_VERSION: "1.15.0", GSD_DISCUSSION_ARENA_AUTO: "1" }, async () => {
		// (a) Pure classification: GSD_VERSION valido, semver parsed, solo
		// unit_start mancante → Tier A con reasons=["no_unit_start"].
		const apiProbe = makeRuntimeApiForTier({ supported: TIER_A_SUPPORTED });
		const classification = classifyRuntime(apiProbe);
		assert.equal(classification.tier, "A", "classifyRuntime puro → Tier A");
		assert.equal(classification.capabilities.size, 3);
		assert.deepEqual(
			[...classification.capabilities].sort(),
			["adjust_tool_set", "before_agent_start", "tool_call"],
			"3 capability: tutti i probe TRANNE unit_start in supported",
		);
		assert.deepEqual(
			[...classification.reasons],
			["no_unit_start"],
			"reasons = ['no_unit_start'] (corto circuito Tier A)",
		);

		// (b) Behavioral wiring: activate + drain + dispatch eventi.
		const api = makeRuntimeApiForTier({ supported: TIER_A_SUPPORTED });
		const { lines } = await captureStderrAsync(async () => {
			activate(api as unknown as Parameters<typeof activate>[0]);
			await flushActivate();
			// `unit_start` NON in TIER_A_SUPPORTED → dispatcher rifiuta di
			// fire (no-op) → `currentUnitType` di ogni marker e
			// `stateRef.value` restano sentinella `"unknown"`. Questa è la
			// differenza chiave vs Tier F: senza l'update del `unit_start`
			// la state machine non avanza mai dal sentinella.
			api.emit("unit_start", { unitType: "planning" });
			// `before_agent_start` fires (è in supported). Per ognuno dei 6
			// marker registrati da attachUnitAwareHooks, isActive() controlla
			//   decision === "forced" && activeUnitTypes.has(currentUnitType)
			// → decision="forced" (env) MA activeUnitTypes.has("unknown")
			// è false per TUTTI i 6 marker (planning ha Set(["planning"]);
			// research-decision ha Set(["research-decision"]); research ha
			// Set([...research-*]); discussing/executing/verifying hanno Set
			// con i loro planning-unitTypes letterali). Risultato: forced
			// MAI triggered per intero.
			api.emit("before_agent_start", { systemPrompt: "Sei un agente di test." });
			// `tool_call` fires → listener singleton (D107, gated by
			// toolCallListenerByApi) legge `stateRef.value = "unknown"` →
			// phase = resolvePhaseLabel("unknown") = "unknown" (il guard di
			// resolvePhaseLabel ritorna il literal del sentinella quando
			// unitTypeToArenaGroup e ACTIVE_UNIT_TYPES lookup falliscono
			// entrambi). Registra recordOnDemand("unknown") ed emette
			// NDJSON "discussionArena.on_demand" con phase="unknown".
			api.emit("tool_call", {
				type: "tool_call",
				toolName: "discussion_arena",
			});
		});

		// (c) Nessuna stderr DEGRADED, nessun recordDegraded: tier != "D"
		// → il ramo Tier D di activate() NON esegue.
		const degradedLines = lines.filter((l) =>
			l.includes("[discussion-arena DEGRADED]"),
		);
		assert.equal(
			degradedLines.length,
			0,
			"Tier A: nessuna stderr `[discussion-arena DEGRADED]` emessa",
		);
		assert.equal(
			getMetrics().counters["discussion_arena_degraded_total"],
			undefined,
			"Tier A: nessun recordDegraded chiamato (counter assente)",
		);

		// (d) Forced counter ASSENTE: la differenza osservabile fondamentale
		// vs Tier F. Decision è "forced" (env) MA currentUnitType resta
		// "unknown" → isActive() false per TUTTI i 6 marker → recordForced
		// mai chiamato → il counter per "discussion_arena_forced_total"
		// non viene mai creato (counters Map ha solo le label effettivamente
		// incrementate).
		const forced = getMetrics().counters["discussion_arena_forced_total"];
		assert.equal(
			forced,
			undefined,
			"Tier A: forced counter assente (currentUnitType='unknown' blocca isActive() su TUTTI i 6 marker)",
		);

		// (e) on_demand counter PRESENTE con phase="unknown": il listener
		// tool_call è singleton (gated) → una sola increment per dispatch,
		// indipendentemente dai 6 marker. phase è "unknown" perché stateRef
		// non è mai stato aggiornato da un unit_start (mock dispatcher
		// refused, hook non fire mai).
		const onDemand = getMetrics().counters["discussion_arena_on_demand_total"];
		assert.ok(
			onDemand,
			"Tier A: on_demand counter presente (listener tool_call ha registrato)",
		);
		assert.equal(
			onDemand["{phase=unknown}"],
			1,
			"esattamente 1 on_demand per phase=unknown (stateRef.value non aggiornato da unit_start unsupported)",
		);

		// (f) NDJSON stderr: SOLO on_demand. NO forced (per il motivo in (d)).
		const forcedLines = lines.filter((l) =>
			l.includes("discussionArena.forced"),
		);
		assert.equal(
			forcedLines.length,
			0,
			"Tier A: nessuno stderr NDJSON `discussionArena.forced` (forced mai triggered)",
		);
		const onDemandLines = lines.filter((l) =>
			l.includes("discussionArena.on_demand"),
		);
		assert.ok(
			onDemandLines.length >= 1,
			"Tier A: stderr NDJSON `discussionArena.on_demand` emesso",
		);
		const parsedOnDemand = JSON.parse(onDemandLines[0]!.trim());
		assert.equal(parsedOnDemand.event, "discussionArena.on_demand");
		assert.equal(parsedOnDemand.level, "info");
		assert.equal(
			parsedOnDemand.phase,
			"unknown",
			"phase='unknown' = sentinella (stateRef.value initial)",
		);
		assert.equal(parsedOnDemand.toolName, "discussion_arena");
	});
});

// ─── T02 — Test Tier D end-to-end (avail-only) ────────────────────────────

test("Tier D end-to-end (avail-only): classifyRuntime=D (no_GSD_VERSION) + activate emette stderr one-shot + recordDegraded", async () => {
	// NO GSD_VERSION → parsedSemver=null → corta circuità: tier="D",
	// reasons=["no_GSD_VERSION"]. Gli hook reasons non sono pushed.
	// NO GSD_DISCUSSION_ARENA_AUTO → trigger resolver fallback Tier 3 →
	// decision="available-only", source="fallback" → il messaggio stderr
	// DEGRADED include "availability-only" come marker del fallback contract.
	await withEnv(
		{ GSD_VERSION: undefined, GSD_DISCUSSION_ARENA_AUTO: undefined },
		async () => {
			// (a) Pure classification: pattern identico al Tier F/A ma su
			// TIER_D_SUPPORTED (zero probe events).
			const apiProbe = makeRuntimeApiForTier({ supported: TIER_D_SUPPORTED });
			const classification = classifyRuntime(apiProbe);
			assert.equal(classification.tier, "D", "classifyRuntime puro → Tier D");
			assert.equal(
				classification.capabilities.size,
				0,
				"0 capability (nessun PROBE_EVENTS in supported)",
			);
			assert.deepEqual(
				[...classification.reasons],
				["no_GSD_VERSION"],
				"reasons = ['no_GSD_VERSION'] (short-circuit, hook reasons NON pushed)",
			);

			// (b) Behavioral: cattura stderr durante activate + dispatch.
			// Il dispatch è no-op (eventi non in supportedSet → dispatcher
			// rifiuta) — è la differenza osservabile chiave vs Tier F/A:
			// Tier D è SILENTE sui surface forced/on_demand.
			const api = makeRuntimeApiForTier({ supported: TIER_D_SUPPORTED });
			const { lines } = await captureStderrAsync(async () => {
				activate(api as unknown as Parameters<typeof activate>[0]);
				await flushActivate();
				// Hooks registrati in registration phase (mock accumulation
				// silent) ma dispatcher refuses — niente forced/on_demand.
				api.emit("unit_start", { unitType: "planning" });
				api.emit("before_agent_start", { systemPrompt: "..." });
				api.emit("tool_call", {
					type: "tool_call",
					toolName: "discussion_arena",
				});
			});

			// (c) Stderr one-shot: ESATTAMENTE 1 riga.
			//   - La chiave in `emitDeprecationWarningOnce` è "tier:D:first-activate"
			//     (S03/M007, modulo-scope `emittedOnceKeys` Set).
			//   - Messaggio include prefisso canonico + il motivo canonicalizzato
			//     "reason: no_GSD_VERSION" e il "availability-only" del Tier 3
			//     fallback del trigger resolver (decision="available-only").
			const degradedLines = lines.filter((l) =>
				l.includes("[discussion-arena DEGRADED]"),
			);
			assert.equal(
				degradedLines.length,
				1,
				"Tier D: ESATTAMENTE una stderr line (one-shot modulo-scope in emitDeprecationWarningOnce)",
			);
			assert.ok(
				degradedLines[0]!.includes("reason: no_GSD_VERSION"),
				"contiene 'reason: no_GSD_VERSION' (motivo canonicalizzato short-circuit)",
			);
			assert.ok(
				degradedLines[0]!.includes("availability-only"),
				"contiene 'availability-only' (decision Tier 3 fallback del trigger resolver)",
			);

			// (d) Counter degraded_total: 1 increment per OGNI reason.
			// NB: `recordDegraded` NON passa per `emitDeprecationWarningOnce`,
			// quindi NON è deduppato tra activate calls diverse — counter
			// osserva OGNI invoke. Coperto dal test idempotenza qui sotto.
			const counter = getMetrics().counters["discussion_arena_degraded_total"];
			assert.ok(
				counter,
				"Tier D: counter degraded_total presente",
			);
			assert.equal(
				counter["{reason=no_GSD_VERSION}"],
				1,
				"esattamente 1 increment per reason=no_GSD_VERSION (una sola reason per short-circuit)",
			);

			// (e) NO forced, NO on_demand: Tier D è silente sui surface
			// forced/on_demand. Il dispatcher refuses events non in
			// supportedSet. Questa è la differenza osservabile chiave vs
			// Tier F/A: stderr DEGRADED + counter degraded presenti, ma
			// forced/on_demand counters ASSENTI.
			assert.equal(
				getMetrics().counters["discussion_arena_forced_total"],
				undefined,
				"Tier D: forced counter assente (hooks dispatcher refuses)",
			);
			assert.equal(
				getMetrics().counters["discussion_arena_on_demand_total"],
				undefined,
				"Tier D: on_demand counter assente (hooks dispatcher refuses)",
			);
		},
	);
});

// ─── T02 — Test idempotenza one-shot ──────────────────────────────────────

test("Idempotenza one-shot: 2 chiamate activate() con Tier D → ESATTAMENTE una stderr line, counter incrementato 2 volte", async () => {
	// NO GSD_VERSION → Tier D reasons=["no_GSD_VERSION"]
	// NO GSD_DISCUSSION_ARENA_AUTO → fallback decision="available-only"
	//
	// Stesso api instance per due `activate()` call. Sul SECONDO invoke:
	//   - `classifyRuntime(api)` riapre i 4 probe. Con la mock probe-vs-
	//     registration phase distinction, probeCount=4 GIÀ saturato →
	//     ogni `api.on(probe_event, noop)` cade in REGISTRATION phase →
	//     silent success → tutti i 4 probe riportati come `true`. Tuttavia
	//     GSD_VERSION è null → `parsedSemver === null` short-circuit →
	//     tier="D", reasons=["no_GSD_VERSION"] (gli hook reasons, seppur
	//     fittiziamente tutti "presenti", non vengono pushed perché
	//     semver-null prevale sul ramo probes-mancanti).
	//   - `emitDeprecationWarningOnce("tier:D:first-activate", msg)` →
	//     chiave già nel Set `emittedOnceKeys` modulo-scope di
	//     `src/deprecation.ts` → ritorna false, NO nuova riga stderr.
	//   - `recordDegraded("no_GSD_VERSION")` NON passa per
	//     `emitDeprecationWarningOnce` → NON dedup → counter += 1.
	//
	// Risultato osservabile netto: stderr lines = 1, counter = 2.
	// Validazione della differenza architetturale chiave: stderr deduppato
	// per evitare spam durante run prolungate; counter osserva OGNI
	// invocazione per telemetry/observability.
	await withEnv(
		{ GSD_VERSION: undefined, GSD_DISCUSSION_ARENA_AUTO: undefined },
		async () => {
			const api = makeRuntimeApiForTier({ supported: TIER_D_SUPPORTED });
			const { lines } = await captureStderrAsync(async () => {
				activate(api as unknown as Parameters<typeof activate>[0]);
				await flushActivate();
				activate(api as unknown as Parameters<typeof activate>[0]); // dedup
				await flushActivate();
			});

			// stderr: ESATTAMENTE 1 riga (la seconda chiamata dedupe).
			const degradedLines = lines.filter((l) =>
				l.includes("[discussion-arena DEGRADED]"),
			);
			assert.equal(
				degradedLines.length,
				1,
				"one-shot: solo 1 stderr line dopo 2 activate() con Tier D (la seconda dedupe via Set `emittedOnceKeys` modulo-scope in `src/deprecation.ts`)",
			);
			// La riga emessa è la prima (e unica): contiene reason canonico.
			assert.ok(
				degradedLines[0]!.includes("reason: no_GSD_VERSION"),
				"la stderr line contiene reason: no_GSD_VERSION (motivo canonicalizzato short-circuit)",
			);

			// counter: incrementato 2 volte. La seconda activate CLASSIFICA
			// ancora Tier D (per parsedSemver null, vedi commento sopra) e
			// chiama `recordDegraded` senza dedup.
			const counter = getMetrics().counters["discussion_arena_degraded_total"];
			assert.ok(
				counter,
				"counter degraded_total presente dopo 2 activate() Tier D",
			);
			assert.equal(
				counter["{reason=no_GSD_VERSION}"],
				2,
				"counter incrementato 2 volte — UNA per OGNI activate call (counter NON passa per emitDeprecationWarningOnce, quindi osserva ogni invoke)",
			);
		},
	);
});
