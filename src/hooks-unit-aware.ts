/**
 * src/hooks-unit-aware.ts — Helper condiviso per la registrazione idempotente
 * dei tre hook unit-aware di auto-injection di discussion-arena (S08-T01).
 *
 * Centralizza la logica di registrazione estratta da src/hooks-planning.ts:
 *   1. unit_start         — traccia l'unitType corrente (state machine)
 *   2. adjust_tool_set    — aggiunge discussion_arena a result.toolNames
 *                           quando unit_type ∈ activeUnitTypes E forced
 *   3. before_agent_start — appende l'istruzione idempotente (marker-based) al
 *                           systemPrompt quando unit_type attivo E forced
 *
 * Il client fornisce il set di unit types da ascoltare e il marker di
 * istruzione. Il helper applica l'anticondizione di idempotenza di
 * registrazione (WeakMap sull'ExtensionAPI) e l'iniezione idempotente
 * dell'istruzione via marker nel systemPrompt. Pure function — nessun effetto
 * collaterale oltre alla registrazione; esposizione solo per testabilità.
 *
 * ─── S01 conditional forcing (M014/R029, D121, D081) ───────────────────────
 *
 * Il predicato `isActive()` consulta `getRuntimePhaseSync(api)` con 3 rami:
 *   1. NON-GSDExtensionAPI (stub plain, vendor upstream) → legacy path
 *      (decision + activeUnitTypes). Tier A/D baseline: nessun
 *      forced-by-context.
 *   2. GSDExtensionAPI + phase ∈ ACTIVE_PHASES → forced-by-context (Tier F
 *      reale). Il forcing IGNORA `resolveTrigger.decision`: gsd-pi sa che
 *      siamo in una fase attiva e vuole che discussion_arena sia forzata
 *      a prescindere dal tier ambientale.
 *   3. GSDExtensionAPI + phase ∉ ACTIVE_PHASES (incl. null) →
 *      availability-only (Tier G). Il tool resta osservabile ma NON
 *      forzato, anche se `decision = forced`.
 *
 * Matrice 6 fasi attive invariata (D121): `discussing`, `researching`,
 * `planning`, `refining`, `executing`, `verifying`. L'identità del forcing è
 * determinata dalla fase runtime del ciclo GSD, non dal tier ambientale.
 * L'idempotenza del counter `gsd_extension_api_detected_total` è garantita
 * da 2 WeakMap per-api: `gsdeDetectionRecorded` per "detected",
 * `notDetectedRecorded` per "not_detected" (ramo legacy). Zero nuove
 * dipendenze npm (D004), modulo runtime-classifier resta PURO (D085),
 * fingerprint via `process.env.GSD_VERSION` invariato (D082).
 *
 * ─── S04 (M019) I1 dispatch context nativo su before_agent_start ───────────
 *
 * Quando l'host è ≥ 1.21.0 (`hostFeatures.dispatchContext === true`) e
 * `BeforeAgentStartEvent` porta `unitType` (dispatch context #1997, tipi
 * vendored extension-upstream-types.d.ts:506-519), Hook 3 decide il forcing
 * NATIVAMENTE sull'unitType dell'evento (precedenza nativo > snapshot, R1):
 * `unit_start` non è mai richiesto (evento dichiarato ma non emesso a
 * runtime, Tier A). Il ramo nativo riusa la stessa semantica di gating di
 * `isActive()` (parametrizzata additivamente) con la fonte unit/phase
 * derivata dall'evento. Il fallback esplicito allo snapshot avviene SOLO
 * quando `event.unitType` è assente o `dispatchContext === false`
 * (env-assente / host ≤ 1.20) → output byte-per-byte identico a v0.9.2.
 * `hostFeatures` è un campo additivo OPZIONALE di UnitAwareHooksOptions con
 * default env-computato (D084): i 6 wrapper attach*Hooks e index.ts non
 * passano il campo (zero breaking change, nessun tocco alla
 * REFERENCE_TABLE di tests/architecture-refs.test.ts).
 *
 * ─── S04 (M019) I2 delta toolset su adjust_tool_set ────────────────────────
 *
 * Hook 2 (adjust_tool_set) sul ramo attivo ritorna la forma delta
 * `{ addTools: ["discussion_arena"] }` quando `hostFeatures.deltaToolSet ===
 * true` (capability #1998, vendored gsd-extension-types.d.ts:200-206):
 * nessun array-copy dell'activeToolNames, NESSUN removeTools mai (D083).
 * Il gating resta il predicato `isActive()` sullo snapshot (AdjustToolSetEvent
 * non espone unitType/phase — gsd-extension-types.d.ts:191-198 — quindi il
 * dispatch context vale solo su Hook 3). Su env-assente / host ≤ 1.20 il
 * ramo legacy `{ toolNames: [...] }` resta INVARIATO byte-per-byte a v0.9.2.
 * Selezione del ramo loggata dichiarativamente via NDJSON
 * `discussionArena.toolsetDelta` (R3, D160; nessuna verifica delivery-based
 * profonda — fuori scope, MEM386).
 */

import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";
import type { ResolveTriggerOutput } from "../trigger-resolver.js";
import { getRuntimePhaseSync, isGSDExtensionAPI } from "./gsd-api-adapter.js";
import {
	emitStructuredLog,
	recordForced,
	recordGSDExtensionAPIDetected,
	recordOnDemand,
} from "./metrics.js";
import {
	ACTIVE_PHASES,
	ACTIVE_UNIT_TYPES,
	unitTypeToArenaGroup,
} from "./phase-mapping.js";
import {
	computeHostFeatures,
	type HostFeatures,
	parseSemver,
} from "./runtime-classifier.js";
import { LOG_PREFIX } from "./log-prefix.js";

/** Nome costante del tool registrato da index.ts (attivazione). */
const UNIT_AWARE_TOOL_NAME = "discussion_arena";

/** Opzioni di configurazione di attachUnitAwareHooks. */
export interface UnitAwareHooksOptions {
	/** Set di unit types durante cui injectare tool + istruzione. */
	activeUnitTypes: ReadonlySet<string>;
	/** Marker idempotente iniettato nel systemPrompt. */
	instructionMarker: string;
	/** Testo istruzione appeso subito dopo il marker. */
	instructionText: string;
	/** Risultato del trigger resolver (decision/source/...). */
	resolveTrigger: ResolveTriggerOutput;
	/** Sink stderr opzionale per log strutturato. */
	stderr?: NodeJS.WritableStream;
	/**
	 * Feature host v1.21.0 (S04/T1, M019, D084) — campo additivo opzionale.
	 * Se assente viene computato il default env-computato
	 * `computeHostFeatures(parseSemver(process.env.GSD_VERSION))` (helper
	 * puro, sub-millisecondo): su env-assente tutti i flag sono false → il
	 * ramo nativo è morto → output byte-per-byte identico a v0.9.2. I 6
	 * wrapper attach*Hooks e index.ts NON passano il campo (zero breaking
	 * change, detection semver-only come fonte primaria — R066).
	 */
	hostFeatures?: HostFeatures;
}

// Registro di idempotenza di registrazione: associa a ogni ExtensionAPI la
// lista dei marker già registrati. Rileggi grazie alla WeakMap, i riferimenti
// vengono raccolti quando l'api viene garbage collected.
const registeredMarkersByApi = new WeakMap<ExtensionAPI, Set<string>>();

// Singleton per-API per il listener tool_call (S02/T02): lo stesso `currentUnitType`
// deve essere osservato da tutte le (eventuali) registrazioni multiple di
// attachUnitAwareHooks sullo stesso api, e il listener tool_call viene
// registrato una sola volta per api indipendentemente dal numero di marker
// attivi (D107: contatore `discussion_arena_on_demand_total` viene
// incrementato UNA volta per invocazione, non per marker — multi-marker setup
// NON deve produrre over-count).
const currentUnitTypeByApi = new WeakMap<ExtensionAPI, { value: string }>();
const toolCallListenerByApi = new WeakMap<ExtensionAPI, boolean>();

// Singleton per-API per idempotenza del counter `gsd_extension_api_detected_total`
// (S01/M014). Una sola registrazione "detected" o "not_detected" per
// sessione per api, indipendente da quante volte `isActive()` viene
// chiamato dai 3 hook unit-aware (unit_start/adjust_tool_set/before_agent_start)
// e da quanti marker sono registrati (multi-marker setup). Evita over-count
// derivante da registrazioni multiple o invocazioni multiple dello stesso
// hook sullo stesso api.
const gsdeDetectionRecorded = new WeakMap<ExtensionAPI, boolean>();
const notDetectedRecorded = new WeakMap<ExtensionAPI, boolean>();

/**
 * Risolve la label `phase` del counter `discussion_arena_forced_total` (D087).
 *
 * Catena: se `unitType` è membro di un gruppo ACTIVE_UNIT_TYPES → nome del
 * gruppo; altrimenti, se `unitType` è esso stesso chiave di gruppo (caso
 * runtime attuale: gli hook registrano `new Set(["planning"])` con unitType
 * "planning" e `new Set(["research-decision"])` con unitType
 * "research-decision") → il nome stesso; altrimenti il sentinella "unknown".
 *
 * Così il label resta vincolato ai soli nomi di gruppo (nessuna label
 * explosion da unitType arbitrari) mantenendo R021 ({phase=planning} atteso
 * in M010). Pura e deterministica, non altera src/phase-mapping.ts (S01).
 *
 * @param unitType unitType corrente tracciato da unit_start.
 * @returns nome del gruppo discussion-arena, o unitType se è una chiave di gruppo, o "unknown".
 */
export function resolvePhaseLabel(unitType: string): string {
	const group = unitTypeToArenaGroup(unitType);
	if (group != null) {
		return group;
	}
	if (unitType in ACTIVE_UNIT_TYPES) {
		return unitType;
	}
	return "unknown";
}

/**
 * Getter pubblico del unitType corrente osservato dall'ultimo `unit_start`
 * emesso su questo api (S01/M011, T01).
 *
 * Legge il singleton per-API `currentUnitTypeByApi` popolato dal listener
 * `unit_start` registrato da `attachUnitAwareHooks`. Pura, idempotente e
 * zero side-effect: può essere chiamata dal callback `discussion_arena.execute`
 * (registrato in index.ts dentro `activate(api)`) per sapere in quale fase
 * è stata invocata, dato che `ExtensionContext` (vendor upstream) NON
 * espone `phase` né `unitType`.
 *
 * Fail-safe: se l'api non è mai passato per `attachUnitAwareHooks` (es.
 * test isolation, runtime Tier D che non emette `unit_start`, oppure tool
 * chiamato prima di qualsiasi registrazione hook) ritorna la sentinella
 * `"unknown"`. Il caller decide il fallback: tipicamente, in index.ts,
 * `unitTypeToArenaGroup("unknown") === null` → `isResearchDecision === false`
 * → nessuna scrittura pending-research spuria.
 *
 * @param api ExtensionAPI catturata nella closure di `activate(api)`.
 * @returns unitType corrente, oppure `"unknown"` se l'api è sconosciuto o
 *          nessun `unit_start` è ancora arrivato.
 */
export function getCurrentUnitType(api: ExtensionAPI): string {
	const stateRef = currentUnitTypeByApi.get(api);
	if (!stateRef) {
		return "unknown";
	}
	return stateRef.value;
}

/**
 * Registra i tre hook unit-aware in modo idempotente sull'ExtensionAPI.
 *
 * Crea una closure per tracciare l'unit_type corrente tra le invocazioni.
 * Ritorna `true` quando gli hook sono (ri)registrati; `false` se lo stesso
 * marker è già registrato su questo api (no-op, idempotenza di registrazione).
 *
 * @param api ExtensionAPI da activate(api)
 * @param _ctx ExtensionContext (per coerenza API; non usato nella logica)
 * @param options Configurazione unit types + marker + trigger + stderr
 */
export function attachUnitAwareHooks(
	api: ExtensionAPI,
	_ctx: ExtensionContext,
	options: UnitAwareHooksOptions,
): boolean {
	// Idempotenza di registrazione: se questo marker è già registrato su
	// questo api, non rieseguire alcuna registrazione.
	const currentMarkers = registeredMarkersByApi.get(api);
	if (currentMarkers?.has(options.instructionMarker)) {
		return false;
	}

	// S04/T1 (M019, I1, D084): feature host v1.21.0 con default env-computato.
	// Helper puro sub-millisecondo; campo opzionale → zero breaking change:
	// i client esistenti (6 wrapper + index.ts) non lo passano e ottengono la
	// detection semver-only canonica da `process.env.GSD_VERSION`.
	const hostFeatures =
		options.hostFeatures ??
		computeHostFeatures(parseSemver(process.env.GSD_VERSION));

	// unit_type corrente — stato `let` nel closure di activate(). Mirrorato
	// in `stateRef` (per-API singleton) per consentire al listener tool_call
	// S02/T02 di leggere l'unit_type corrente osservato dall'ultimo
	// `unit_start` emesso da QUALSIASI marker registrato sullo stesso api.
	let currentUnitType: string = "unknown";
	let stateRef = currentUnitTypeByApi.get(api);
	if (!stateRef) {
		stateRef = { value: "unknown" };
		currentUnitTypeByApi.set(api, stateRef);
	}

	// Predicato condiviso: 3 rami (S01/M014 conditional forcing, R029/D121/D081).
	//   1. GSDExtensionAPI + phase ∈ ACTIVE_PHASES → forced-by-context
	//      (Tier F reale): ignora `resolveTrigger.decision`. gsd-pi sa che
	//      siamo in una fase attiva e vuole che discussion_arena sia forzata
	//      a prescindere dal tier ambientale.
	//   2. GSDExtensionAPI + phase ∉ ACTIVE_PHASES (incl. null) →
	//      availability-only (Tier G): tool osservabile ma NON forzato,
	//      anche se `decision = forced`.
	//   3. NON-GSDExtensionAPI → legacy path (decision + activeUnitTypes).
	//      Tier A/D baseline: nessun forced-by-context.
	//
	// Idempotenza del counter `gsd_extension_api_detected_total` via 2
	// WeakMap per-api: una sola registrazione "detected" / "not_detected"
	// per sessione per api, indipendente dal numero di invocazioni di
	// `isActive()` (chiamato da 3 hook × N marker sullo stesso api).
	// S04/T1 (M019, I1): parametrizzazione additiva `nativeUnitType?`. Quando
	// il dispatch context (#1997) fornisce l'unitType dall'evento (Hook 3,
	// host ≥ 1.21.0), i rami di gating valutano la membership contro l'unitType
	// NATIVO invece che contro lo snapshot del closure; i 3 rami mantengono
	// la STESSA semantica di gating, con la fonte dell'unitType derivata
	// dall'evento invece che dallo snapshot. Senza argomento il comportamento
	// è byte-per-byte invariato (snapshot, default del closure).
	const isActive = (nativeUnitType?: string): boolean => {
		// Tentativo di leggere la phase via GSDExtensionAPI. Se l'api non
		// è una GSDExtensionAPI (stub plain, vendor upstream) → null.
		// Se GSDExtensionAPI con phase nota → Phase. Se GSDExtensionAPI
		// con phase null o getPhase che lancia → null (D019 fail-loud
		// ma non throw, log strutturato emesso dentro l'adapter).
		const gsdePhase = getRuntimePhaseSync(api);
		if (gsdePhase !== null && ACTIVE_PHASES.has(gsdePhase)) {
			// Ramo 1: GSDExtensionAPI detected + phase ∈ ACTIVE_PHASES →
			// forced-by-context (Tier F reale). Ignora deliberatamente
			// `resolveTrigger.decision`. La fase runtime del ciclo GSD
			// ha priorità assoluta sul tier ambientale (D081).
			if (!gsdeDetectionRecorded.has(api)) {
				gsdeDetectionRecorded.set(api, true);
				recordGSDExtensionAPIDetected("detected");
			}
			return true;
		}
		// A questo punto: phase null, phase fuori da ACTIVE_PHASES, o
		// non-GSDExtensionAPI. Distinguiamo i due casi tramite
		// `isGSDExtensionAPI(api)`:
		if (isGSDExtensionAPI(api)) {
			// Ramo 2: GSDExtensionAPI detected ma phase null o non
			// forzante (es. "paused", "blocked") → availability-only
			// (Tier G). Il tool resta osservabile ma NON forzato anche
			// se `decision = forced` (v. T02-C). Counter "detected"
			// registrato una volta per sessione per api.
			if (!gsdeDetectionRecorded.has(api)) {
				gsdeDetectionRecorded.set(api, true);
				recordGSDExtensionAPIDetected("detected");
			}
			return false;
		}
		// Ramo 3: NON-GSDExtensionAPI (stub plain, vendor upstream).
		// Legacy path: decision forced E unit_type ∈ activeUnitTypes.
		// Tier A/D baseline. Zero forced-by-context. Counter
		// "not_detected" una volta per sessione per api (WeakMap
		// idempotenza). Non blocca mai il flow.
		if (!notDetectedRecorded.has(api)) {
			notDetectedRecorded.set(api, true);
			recordGSDExtensionAPIDetected("not_detected");
		}
		return (
			options.resolveTrigger.decision === "forced" &&
			options.activeUnitTypes.has(nativeUnitType ?? currentUnitType)
		);
	};

	// Hook 1: unit_start — traccia CurrentUnitType.
	api.on("unit_start", (event) => {
		currentUnitType = event.unitType ?? "unknown";
		stateRef.value = currentUnitType;
		if (isActive()) {
			options.stderr?.write(
				`${LOG_PREFIX} hook: ${currentUnitType} forced su unit_start\n`,
			);
		}
	});

	// Hook 2: adjust_tool_set — aggiunge discussion_arena se unit attivo E forced.
	//
	// ─── S04/T2 (M019, I2 delta toolset #1998, R066/R067) ──────────────────
	// Due forme di risultato con gating INVARIATO (il predicato isActive()
	// rimane la sola porta di ingresso): AdjustToolSetEvent NON espone
	// unitType/phase (vendored gsd-extension-types.d.ts:191-198 — nessun
	// dispatch context su questo hook), quindi la decisione resta derivata
	// dallo snapshot currentUnitType via unit_start. Cambia SOLO la forma del
	// ritorno:
	//   - Ramo delta (host ≥ 1.21.0, `hostFeatures.deltaToolSet === true`):
	//     `{ addTools: [UNIT_AWARE_TOOL_NAME] }` — nessun array-copy
	//     dell'activeToolNames; NESSUN removeTools mai (D083: additivo).
	//     L'host applica addTools dopo le rimozioni e deduplica il finale.
	//   - Ramo legacy (env-assente / host ≤ 1.20, `deltaToolSet === false`):
	//     `{ toolNames: [...event.activeToolNames] }` con push guarded —
	//     INVARIATO byte-per-byte a v0.9.2.
	// Log strutturato opzionale sulla selezione del ramo delta (R3:
	// degradation dichiarativa, detection semver-only D160): un solo evento
	// `discussionArena.toolsetDelta` per invocazione delta (l'host deduplica
	// il toolset finale). NON una verifica delivery-based profonda — fuori
	// scope (MEM386).
	api.on("adjust_tool_set", (event) => {
		if (isActive()) {
			if (hostFeatures.deltaToolSet) {
				emitStructuredLog("info", "discussionArena.toolsetDelta", {
					toolName: UNIT_AWARE_TOOL_NAME,
				});
				return { addTools: [UNIT_AWARE_TOOL_NAME] };
			}
			const toolNames = [...event.activeToolNames];
			if (!toolNames.includes(UNIT_AWARE_TOOL_NAME)) {
				toolNames.push(UNIT_AWARE_TOOL_NAME);
			}
			return { toolNames };
		}
	});

	// Helper di iniezione (S04/T1, M019): mutazione marker + counter + log
	// NDJSON, parametrizzata sull'unitType che ha motivato il forcing (nativo
	// dall'evento o snapshot dal closure). Semantica D088 invariata: incremento
	// metrico + log NDJSON SOLO nel ramo di effettiva iniezione del marker, NON
	// nel ramo esterno isActive(): il framework può chiamare before_agent_start
	// più volte sullo stesso prompt già marcato (retry/ri-entrata) e il counter
	// misura "quante volte la discussion-arena è stata forzata nel prompt", in
	// corrispondenza 1:1 con le mutazioni osservabili del systemPrompt.
	const injectInstruction = (
		event: { systemPrompt: string },
		forcingUnitType: string,
	): { systemPrompt: string } | undefined => {
		if (event.systemPrompt.includes(options.instructionMarker)) {
			return undefined;
		}
		const phase = resolvePhaseLabel(forcingUnitType);
		recordForced(phase);
		emitStructuredLog("info", "discussionArena.forced", {
			tier: "F",
			phase,
		});
		const marker = `\n\n${options.instructionMarker}\n${options.instructionText}`;
		return { systemPrompt: event.systemPrompt + marker };
	};

	// Hook 3: before_agent_start — appende istruzione idempotente (via marker).
	//
	// ─── S04/T1 (M019, I1 dispatch context #1997, R066/R1) ─────────────────
	// Due rami con precedenza definita:
	//   - Ramo nativo (host ≥ 1.21.0, `hostFeatures.dispatchContext === true`,
	//     `event.unitType !== undefined`): la decisione di attivazione usa
	//     l'unitType dell'evento (vendored extension-upstream-types.d.ts:506-519)
	//     invece dello snapshot `currentUnitType` — precedenza nativo > snapshot
	//     (R1): `unit_start` non è mai richiesto (evento dichiarato ma non
	//     emesso a runtime, Tier A). Nessun fallback allo snapshot quando la
	//     decisione nativa è presa: l'evento descrive l'unità corrente, lo
	//     snapshot può solo essere stantio. `event.phase` non aggiunge
	//     informazione al gating (biiezione D102 gruppo↔fase: la membership
	//     del gruppo derivata da unitType è equivalente al check di fase).
	//   - Ramo legacy (fallback esplicito R1): `event.unitType` assente
	//     (turno ordinario user-initiated) o `dispatchContext === false`
	//     (env-assente / host ≤ 1.20) → snapshot `currentUnitType`, output
	//     byte-per-byte identico a v0.9.2.
	api.on("before_agent_start", (event) => {
		if (hostFeatures.dispatchContext && event.unitType !== undefined) {
			if (!isActive(event.unitType)) {
				return undefined;
			}
			return injectInstruction(event, event.unitType ?? currentUnitType);
		}
		if (!isActive()) {
			return undefined;
		}
		return injectInstruction(event, currentUnitType);
	});

	// Hook 4 (S02/T02): tool_call observer on-demand. NON è un meccanismo di
	// forzatura: `discussion_arena` è già registrato via `api.registerTool` in
	// index.ts e resta invocabile in ogni fase; il listener serve a
	// OSSERVARE/strumentare l'invocazione on-demand (log NDJSON
	// `discussionArena.on_demand` su stderr + counter
	// `discussion_arena_on_demand_total{phase}`). Viene registrato una sola
	// volta per api — multi-marker setup NON produce duplicati (D107).
	//
	// TypeScript gotcha: `ToolCallEvent` è una union di tutte le *ToolCallEvent;
	// `toolName:string` su `CustomToolCallEvent` non discrimina via literal-property
	// (string overlap su tutti i literal). Usiamo cast narrow
	// `event as unknown as { type?: unknown; toolName?: unknown }` + guard
	// runtime (pattern identico a `runtime-classifier.safeProbe`).
	if (!toolCallListenerByApi.has(api)) {
		toolCallListenerByApi.set(api, true);
		api.on("tool_call", (event) => {
			const e = event as unknown as { type?: unknown; toolName?: unknown };
			if (e?.type !== "tool_call") return;
			if (e?.toolName !== UNIT_AWARE_TOOL_NAME) return;
			// Legge `stateRef.value` (per-api singleton) che tutti gli hook
			// `unit_start` registrati mantengono coerente. La phase label è
			// risolta con la stessa helper `resolvePhaseLabel` usata per il
			// counter `forced`, garantendo cardinalità uniforme delle label.
			const phase = resolvePhaseLabel(stateRef.value);
			recordOnDemand(phase);
			emitStructuredLog("info", "discussionArena.on_demand", {
				toolName: UNIT_AWARE_TOOL_NAME,
				phase,
			});
		});
	}

	if (!currentMarkers) {
		registeredMarkersByApi.set(api, new Set([options.instructionMarker]));
	} else {
		currentMarkers.add(options.instructionMarker);
	}
	return true;
}