/**
 * src/phase-mapping.ts — Mapping canonico Phase -> unitType -> gruppo.
 *
 * Modulo puro: nessun I/O, nessun import dal vendored pi-coding-agent,
 * nessun side effect all'import (verificato con rg nel gate T01). È la singola fonte di verità per la
 * matrice di attivazione della discussion arena (Vision v2 §3.2/§6) e viene consumato da
 * S02 (label dei counter forced/degraded), S04 (shape extension-manifest) e
 * S07 (proprietà combinatorie su 540 combinazioni).
 *
 * La union `Phase` (18 valori) è definita LOCALMENTE perché il pacchetto
 * vendored pi-coding-agent espone solo `phase: string`, non l'union.
 * Fonte di verità: gsd-pi `src/resources/extensions/gsd/types.ts`.
 * Limitazione nota: la union è pinnata localmente e va tenuta in sync
 * manualmente con i major release di gsd-pi (Vision §8: la discussion arena dichiara una
 * propria matrice; un nuovo unitType gsd-pi comporta un bump di release —
 * il test S07 snapshot lo guarda).
 */

/**
 * Union delle 18 fasi del ciclo GSD (D085). Definite localmente; da tenere
 * allineate a `Phase` di gsd-pi `src/resources/extensions/gsd/types.ts`.
 */
export type Phase =
	| "pre-planning"
	| "needs-discussion"
	| "discussing"
	| "researching"
	| "planning"
	| "refining"
	| "evaluating-gates"
	| "executing"
	| "verifying"
	| "summarizing"
	| "advancing"
	| "validating-milestone"
	| "completing-milestone"
	| "replanning-slice"
	| "escalating-task"
	| "complete"
	| "paused"
	| "blocked";

/** Set vuoto condiviso per le fasi non mappate (immutabile, riusato). */
const EMPTY_UNIT_TYPES: ReadonlySet<string> = Object.freeze(new Set<string>());

/**
 * Gruppi della discussion arena inizialmente attivi: la chiave è il gruppo, il valore è
 * l'insieme (congelato) degli unitType che appartengono al gruppo.
 *
 * Esattamente 2 gruppi in questa slice — coerenti con gli activeUnitTypes
 * hardcoded in src/hooks-planning.ts:37 (`planning`) e
 * src/hooks-research.ts:38 (`research-decision`). La roadmap estende a 6
 * gruppi nelle slice successive (W2.8).
 */
export const ACTIVE_UNIT_TYPES: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
	"research-decision": Object.freeze(new Set(["research-decision"])),
	planning: Object.freeze(
		new Set([
			"plan-milestone",
			"plan-slice",
			"refine-slice",
			"replan-slice",
			"replan-task",
			"gate-evaluate",
		]),
	),
});

/**
 * Mapping fase -> unitType di gruppo. Le sole 2 fasi attive mappano al
 * gruppo corrispondente; tutte le altre (16) restituiscono il set vuoto.
 * "researching" è la fase che attiva il gruppo "research-decision"
 * (il nome fase della union gsd-pi è "researching", non "research-decision").
 */
export const PHASE_TO_UNIT_TYPES: Readonly<Record<Phase, ReadonlySet<string>>> = Object.freeze({
	"pre-planning": EMPTY_UNIT_TYPES,
	"needs-discussion": EMPTY_UNIT_TYPES,
	"discussing": EMPTY_UNIT_TYPES,
	"researching": ACTIVE_UNIT_TYPES["research-decision"],
	"planning": ACTIVE_UNIT_TYPES.planning,
	"refining": EMPTY_UNIT_TYPES,
	"evaluating-gates": EMPTY_UNIT_TYPES,
	"executing": EMPTY_UNIT_TYPES,
	"verifying": EMPTY_UNIT_TYPES,
	"summarizing": EMPTY_UNIT_TYPES,
	"advancing": EMPTY_UNIT_TYPES,
	"validating-milestone": EMPTY_UNIT_TYPES,
	"completing-milestone": EMPTY_UNIT_TYPES,
	"replanning-slice": EMPTY_UNIT_TYPES,
	"escalating-task": EMPTY_UNIT_TYPES,
	"complete": EMPTY_UNIT_TYPES,
	"paused": EMPTY_UNIT_TYPES,
	"blocked": EMPTY_UNIT_TYPES,
});

/**
 * Restituisce l'insieme congelato degli unitType attivi per la fase data,
 * oppure il set vuoto per le fasi non mappate. Deterministico e puro.
 */
export function phaseToUnitTypes(phase: Phase): ReadonlySet<string> {
	return PHASE_TO_UNIT_TYPES[phase];
}

/**
 * Restituisce il gruppo della discussion arena (key di ACTIVE_UNIT_TYPES) il cui insieme
 * contiene `unitType`, oppure null se il unitType non appartiene a nessun
 * gruppo attivo.
 */
export function unitTypeToArenaGroup(
	unitType: string,
): keyof typeof ACTIVE_UNIT_TYPES | null {
	for (const [group, unitTypes] of Object.entries(ACTIVE_UNIT_TYPES)) {
		if (unitTypes.has(unitType)) {
			return group as keyof typeof ACTIVE_UNIT_TYPES;
		}
	}
	return null;
}