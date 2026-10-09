/**
 * tests/_helpers/adjust-composition.ts — composizione upstream del
 * dispatcher `emitAdjustToolSet` (#1998), replicata dalla SORGENTE REALE
 * del runner host (`@gsd/pi-coding-agent/dist/core/extensions/runner.js:899-933`,
 * spec upstream `packages/pi-coding-agent/src/core/extensions/runner.ts`).
 *
 * Semantica attestata dalla lettura del runner compilato:
 *   - iterazione COMPLETA: ogni listener registrato è invocato (nessun
 *     short-circuit first-wins);
 *   - `toolNames` override: il PRIMO non-undefined vince (semantica legacy
 *     per listener pure-override);
 *   - `removeTools` e `addTools` sono ACCUMULATI da tutti i listener;
 *   - un result senza override né delta (es. `{}`) non blocca i listener
 *     successivi;
 *   - composizione finale: override ?? event.activeToolNames, poi rimozione
 *     dei removeTools, poi append degli addTools, poi dedup (Set, ordine
 *     stabile);
 *   - se nessun listener ha prodotto un result → `undefined`;
 *   - se almeno un result ma nessun override/delta → `{}`.
 *
 * Riusato dagli harness di test che dispatchano manualmente
 * `adjust_tool_set` così che le asserzioni consultino il toolset COMPOSTO
 * dall'host (identico su env legacy e GSD_VERSION=1.21.0), non la forma
 * grezza del singolo listener (che sul ramo delta è `{ addTools }` senza
 * `toolNames`).
 */

/** Forma di risultato di un listener `adjust_tool_set` (#1998). */
export interface AdjustToolSetResult {
	toolNames?: string[];
	addTools?: string[];
	removeTools?: string[];
}

/**
 * Compone i risultati GREZZI di uno o più listener `adjust_tool_set` con la
 * semantica esatta del runner upstream (vedi header). `activeToolNames` è
 * il fallback del toolset base (l'`event.activeToolNames` del payload).
 */
export function composeAdjustToolSetResults(
	handlerResults: unknown[],
	activeToolNames: string[],
): AdjustToolSetResult | undefined {
	let sawResult = false;
	let toolNamesOverride: string[] | undefined;
	const removes: string[] = [];
	const adds: string[] = [];
	for (const raw of handlerResults) {
		const result = raw as AdjustToolSetResult | null | undefined;
		if (result) {
			sawResult = true;
			if (toolNamesOverride === undefined && result.toolNames !== undefined) {
				toolNamesOverride = result.toolNames;
			}
			if (result.removeTools) removes.push(...result.removeTools);
			if (result.addTools) adds.push(...result.addTools);
		}
	}
	if (!sawResult) return undefined;
	if (
		toolNamesOverride === undefined &&
		adds.length === 0 &&
		removes.length === 0
	) {
		return {};
	}
	const base = toolNamesOverride ?? activeToolNames;
	const removed = new Set(removes);
	const composed = [
		...new Set([...base.filter((name) => !removed.has(name)), ...adds]),
	];
	return { toolNames: composed };
}

/**
 * Dispatch upstream a TUTTI gli handler registrati per `adjust_tool_set`
 * (stesso payload, ordine di registrazione) seguito dalla composizione
 * `composeAdjustToolSetResults`. Ritorna il result composto dall'host:
 * `undefined` se nessun listener ha prodotto un result.
 */
export function dispatchAdjustToolSet(
	handlers: Array<(event: Record<string, unknown>) => unknown>,
	event: Record<string, unknown>,
): AdjustToolSetResult | undefined {
	const results = handlers.map((handler) => handler(event));
	const activeToolNames = (event.activeToolNames as string[]) ?? [];
	return composeAdjustToolSetResults(results, activeToolNames);
}
