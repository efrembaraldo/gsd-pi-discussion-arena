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

	// unit_type corrente — stato `let` nel closure di activate().
	let currentUnitType: string = "unknown";

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
				const marker = `\n\n${options.instructionMarker}\n${options.instructionText}`;
				return { systemPrompt: event.systemPrompt + marker };
			}
		}
	});

	if (!currentMarkers) {
		registeredMarkersByApi.set(api, new Set([options.instructionMarker]));
	} else {
		currentMarkers.add(options.instructionMarker);
	}
	return true;
}