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
 * Gruppi della discussion arena attivi (S02): la chiave è il gruppo, il valore
 * è l'insieme (congelato) degli unitType che appartengono al gruppo.
 *
 * Esattamente 6 gruppi arena, partizione disgiunta dei 24 unit-type `primary`
 * di gsd-pi (D102). Il forwarding dei 6 gruppi consuma 20 unit-type unici;
 * i restanti 4 (`quick-task`, `rewrite-docs`, `triage-captures`,
 * `workflow-preferences`) sono fuori dal forcing della arena per design
 * (variants operativi che non beneficiano del prompt deliberativo).
 *
 * La partizione è documentata in 10-RESEARCH.md §7 (catalogazione
 * `unit-registry.ts` di gsd-pi) e validata come invariante dal test
 * combinatorio `tests/property-phase-mapping.test.ts` (snapshot 24 +
 * iniettività + activeMemberships=20).
 */
export const ACTIVE_UNIT_TYPES: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
	"research-decision": Object.freeze(new Set(["research-decision"])),
	research: Object.freeze(
		new Set([
			"research-milestone",
			"research-project",
			"research-slice",
		]),
	),
	discussing: Object.freeze(
		new Set([
			"discuss-milestone",
			"discuss-project",
			"discuss-requirements",
		]),
	),
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
	executing: Object.freeze(
		new Set([
			"execute-task",
			"reactive-execute",
			"run-uat",
			"reassess-roadmap",
		]),
	),
	verifying: Object.freeze(
		new Set([
			"validate-milestone",
			"complete-milestone",
			"complete-slice",
		]),
	),
});

/**
 * Mapping fase -> unitType di gruppo. Biiezione D102: ogni gruppo arena è
 * referenziato da UNA e una sola fase attiva (6 fasi attive), le altre 12
 * fasi (incluse `paused` e `blocked`) restituiscono il set vuoto condiviso.
 *
 * Scelta delle 6 fasi attive:
 *   - `researching`     → `research-decision` (mantenuto da S01)
 *   - `refining`        → `research`        (fase grigia, no phaseChain canonico)
 *   - `discussing`      → `discussing`
 *   - `planning`        → `planning`        (mantenuto da S01)
 *   - `executing`       → `executing`
 *   - `verifying`       → `verifying`
 *
 * `refining` è designata "grigia" da 10-RESEARCH.md §2 (non ha un
 * phaseChain canonico nel unit-registry di gsd-pi) — viene usata come
 * appoggio per attivare il gruppo `research`, evitando di ri-mappare una
 * fase canonica (es. `researching`) che è già legata a `research-decision`.
 *
 * `unitTypeToArenaGroup` (loop su Object.entries) si estende automaticamente
 * ai 6 nuovi gruppi — i consumer (es. `trigger-resolver.ts`) difendono da
 * `null` per gli unit-type fuori dai gruppi.
 */
export const PHASE_TO_UNIT_TYPES: Readonly<Record<Phase, ReadonlySet<string>>> = Object.freeze({
	"pre-planning": EMPTY_UNIT_TYPES,
	"needs-discussion": EMPTY_UNIT_TYPES,
	"discussing": ACTIVE_UNIT_TYPES.discussing,
	"researching": ACTIVE_UNIT_TYPES["research-decision"],
	"planning": ACTIVE_UNIT_TYPES.planning,
	"refining": ACTIVE_UNIT_TYPES.research,
	"evaluating-gates": EMPTY_UNIT_TYPES,
	"executing": ACTIVE_UNIT_TYPES.executing,
	"verifying": ACTIVE_UNIT_TYPES.verifying,
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