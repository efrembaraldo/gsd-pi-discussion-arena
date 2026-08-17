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
 */

import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";
import type { ResolveTriggerOutput } from "../trigger-resolver.js";
import { emitStructuredLog, recordForced, recordOnDemand } from "../metrics.js";
import { ACTIVE_UNIT_TYPES, unitTypeToArenaGroup } from "./phase-mapping.js";
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

	// Predicato condiviso: decision forced E unit_type attualmente in
	// activeUnitTypes.
	const isActive = (): boolean => {
		return (
			options.resolveTrigger.decision === "forced" &&
			options.activeUnitTypes.has(currentUnitType)
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
	api.on("adjust_tool_set", (event) => {
		if (isActive()) {
			const toolNames = [...event.activeToolNames];
			if (!toolNames.includes(UNIT_AWARE_TOOL_NAME)) {
				toolNames.push(UNIT_AWARE_TOOL_NAME);
			}
			return { toolNames };
		}
	});

	// Hook 3: before_agent_start — appende istruzione idempotente (via marker).
	api.on("before_agent_start", (event) => {
		if (isActive()) {
			if (!event.systemPrompt.includes(options.instructionMarker)) {
				// D088: incremento metrico + log NDJSON SOLO nel ramo di effettiva
				// iniezione del marker, NON nel ramo esterno isActive(): il framework
				// può chiamare before_agent_start più volte sullo stesso prompt già
				// marcato (retry/ri-entrata) e il counter misura "quante volte la
				// discussion-arena è stata forzata nel prompt", in corrispondenza 1:1 con le mutazioni
				// osservabili del systemPrompt.
				const phase = resolvePhaseLabel(currentUnitType);
				recordForced(phase);
				emitStructuredLog("info", "discussionArena.forced", {
					tier: "F",
					phase,
				});
				const marker = `\n\n${options.instructionMarker}\n${options.instructionText}`;
				return { systemPrompt: event.systemPrompt + marker };
			}
		}
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