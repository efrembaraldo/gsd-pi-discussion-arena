/**
 * Unit tests per src/phase-mapping.ts (S01 baseline + S02 estensione a 6 gruppi, D085, D102).
 *
 * Copre:
 *  - le 18 fasi della union `Phase` come dominio totale di
 *    `PHASE_TO_UNIT_TYPES` (chiavi esatte, senza extra e senza lacune);
 *  - `phaseToUnitTypes` su tutte le 18 fasi (6 mappate ai gruppi attivi con
 *    biiezione D102, 12 al set vuoto condiviso), incluse le identità di
 *    riferimento con `ACTIVE_UNIT_TYPES`;
 *  - casi negativi: `unitTypeToArenaGroup` → null per unitType sconosciuto,
 *    stringa vuota, chiave-gruppo che non è membro del proprio set (per
 *    tutti i 6 gruppi), nome fase non canoniche, e accesso runtime a una
 *    fase fuori dominio;
 *  - invarianti di mapping inverso: ogni unitType prodotto da una fase attiva
 *    riconduce al gruppo che lo produce (round-trip) e la chiusura dei
 *    round-trip copre tutti i gruppi di `ACTIVE_UNIT_TYPES`;
 *  - purezza: strutture esportate congelate, set immutabili e riuso dello
 *    stesso set vuoto per le fasi non attive.
 *
 * Modulo target puro (nessun I/O): la suite non richiede stubs né subprocess.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
	ACTIVE_UNIT_TYPES,
	PHASE_TO_UNIT_TYPES,
	phaseToUnitTypes,
	unitTypeToArenaGroup,
} from "../src/phase-mapping.js";
import type { Phase } from "../src/phase-mapping.js";

/**
 * Le 18 fasi del ciclo GSD come dominio canonico (D085). Tenuto in sync con
 * la union `Phase` di src/phase-mapping.ts; il test di totalità fallisce se
 * la sorgente introduce o rimuove una fase senza aggiornare questa lista.
 */
const ALL_PHASES: readonly Phase[] = [
	"pre-planning",
	"needs-discussion",
	"discussing",
	"researching",
	"planning",
	"refining",
	"evaluating-gates",
	"executing",
	"verifying",
	"summarizing",
	"advancing",
	"validating-milestone",
	"completing-milestone",
	"replanning-slice",
	"escalating-task",
	"complete",
	"paused",
	"blocked",
];

/** I 6 unitType del gruppo di pianificazione (src/phase-mapping.ts). */
const PLANNING_UNIT_TYPES: readonly string[] = [
	"plan-milestone",
	"plan-slice",
	"refine-slice",
	"replan-slice",
	"replan-task",
	"gate-evaluate",
];

/** I 3 unitType del gruppo di ricerca (escluso `research-decision`). */
const RESEARCH_UNIT_TYPES: readonly string[] = [
	"research-milestone",
	"research-project",
	"research-slice",
];

/** I 3 unitType del gruppo di discussione (discuss-milestone/project/requirements). */
const DISCUSSING_UNIT_TYPES: readonly string[] = [
	"discuss-milestone",
	"discuss-project",
	"discuss-requirements",
];

/** I 4 unitType del gruppo di esecuzione (execute-task/reactive-execute/run-uat/reassess-roadmap). */
const EXECUTING_UNIT_TYPES: readonly string[] = [
	"execute-task",
	"reactive-execute",
	"run-uat",
	"reassess-roadmap",
];

/** I 3 unitType del gruppo di verifica (validate/complete-milestone/complete-slice). */
const VERIFYING_UNIT_TYPES: readonly string[] = [
	"validate-milestone",
	"complete-milestone",
	"complete-slice",
];

/** Nome-unita e gruppo di research-decision coincidono (un solo membro). */
const RESEARCH_UNIT_TYPE = "research-decision";

test("(1) dominio totale: PHASE_TO_UNIT_TYPES copre esattamente le 18 fasi", () => {
	assert.equal(
		ALL_PHASES.length,
		18,
		"la union Phase deve avere esattamente 18 valori",
	);
	assert.deepEqual(
		Object.keys(PHASE_TO_UNIT_TYPES).sort(),
		[...ALL_PHASES].sort(),
		"le chiavi di PHASE_TO_UNIT_TYPES devono essere proprio i 18 valori Phase",
	);
});

test("(2) phaseToUnitTypes è totale sul dominio: ogni fase restituisce un Set", () => {
	for (const phase of ALL_PHASES) {
		assert.ok(
			phaseToUnitTypes(phase) instanceof Set,
			`phaseToUnitTypes("${phase}") deve restituire un Set (non undefined)`,
		);
	}
});

test("(3) la fase 'researching' attiva il gruppo research-decision", () => {
	assert.ok(
		phaseToUnitTypes("researching").has(RESEARCH_UNIT_TYPE),
		"la fase researching deve attivare il gruppo research-decision",
	);
});

test("(3a) la fase 'refining' attiva il gruppo research (fase grigia per D102)", () => {
	assert.deepEqual(
		[...phaseToUnitTypes("refining")].sort(),
		[...RESEARCH_UNIT_TYPES].sort(),
		"la fase refining deve attivare esattamente i 3 unitType del gruppo research",
	);
});

test("(4) la fase 'planning' attiva esattamente i 6 unitType di pianificazione", () => {
	assert.deepEqual(
		[...phaseToUnitTypes("planning")].sort(),
		[...PLANNING_UNIT_TYPES].sort(),
		"la fase planning deve attivare esattamente i 6 unitType del gruppo planning",
	);
});

test("(4a) la fase 'discussing' attiva esattamente i 3 unitType di discussione", () => {
	assert.deepEqual(
		[...phaseToUnitTypes("discussing")].sort(),
		[...DISCUSSING_UNIT_TYPES].sort(),
		"la fase discussing deve attivare esattamente i 3 unitType del gruppo discussing",
	);
});

test("(4b) la fase 'executing' attiva esattamente i 4 unitType di esecuzione", () => {
	assert.deepEqual(
		[...phaseToUnitTypes("executing")].sort(),
		[...EXECUTING_UNIT_TYPES].sort(),
		"la fase executing deve attivare esattamente i 4 unitType del gruppo executing",
	);
});

test("(4c) la fase 'verifying' attiva esattamente i 3 unitType di verifica", () => {
	assert.deepEqual(
		[...phaseToUnitTypes("verifying")].sort(),
		[...VERIFYING_UNIT_TYPES].sort(),
		"la fase verifying deve attivare esattamente i 3 unitType del gruppo verifying",
	);
});

test("(5) le altre 12 fasi restituiscono il set vuoto (biiezione D102: 6 attive, 12 inattive)", () => {
	const ACTIVE_PHASES: readonly Phase[] = [
		"researching",
		"refining",
		"discussing",
		"planning",
		"executing",
		"verifying",
	];
	const nonActive = ALL_PHASES.filter((p) => !ACTIVE_PHASES.includes(p));
	assert.equal(nonActive.length, 12, "attese 12 fasi non attive (18 - 6)");
	for (const phase of nonActive) {
		assert.equal(
			phaseToUnitTypes(phase).size,
			0,
			`la fase "${phase}" deve mappare a un set vuoto`,
		);
	}
});

test("(6) identità di riferimento: le 6 fasi attive riusano i set di ACTIVE_UNIT_TYPES", () => {
	assert.equal(
		phaseToUnitTypes("researching"),
		ACTIVE_UNIT_TYPES[RESEARCH_UNIT_TYPE],
		"phaseToUnitTypes('researching') deve essere il riferimento del gruppo research-decision",
	);
	assert.equal(
		phaseToUnitTypes("refining"),
		ACTIVE_UNIT_TYPES.research,
		"phaseToUnitTypes('refining') deve essere il riferimento del gruppo research",
	);
	assert.equal(
		phaseToUnitTypes("discussing"),
		ACTIVE_UNIT_TYPES.discussing,
		"phaseToUnitTypes('discussing') deve essere il riferimento del gruppo discussing",
	);
	assert.equal(
		phaseToUnitTypes("planning"),
		ACTIVE_UNIT_TYPES.planning,
		"phaseToUnitTypes('planning') deve essere il riferimento del gruppo planning",
	);
	assert.equal(
		phaseToUnitTypes("executing"),
		ACTIVE_UNIT_TYPES.executing,
		"phaseToUnitTypes('executing') deve essere il riferimento del gruppo executing",
	);
	assert.equal(
		phaseToUnitTypes("verifying"),
		ACTIVE_UNIT_TYPES.verifying,
		"phaseToUnitTypes('verifying') deve essere il riferimento del gruppo verifying",
	);
});

test("(7) casi negativi: unitTypeToArenaGroup → null fuori dai membri noti", () => {
	assert.equal(unitTypeToArenaGroup("not-a-real-unit-type"), null);
	assert.equal(unitTypeToArenaGroup(""), null);
	assert.equal(unitTypeToArenaGroup("<<garbage>>"), null);
	// 5 chiavi-gruppo NON sono membri del proprio set: il mapping è unitType
	// -> gruppo, non chiave-gruppo -> gruppo (chiave != membro in genere).
	assert.equal(unitTypeToArenaGroup("research"), null);
	assert.equal(unitTypeToArenaGroup("discussing"), null);
	assert.equal(unitTypeToArenaGroup("planning"), null);
	assert.equal(unitTypeToArenaGroup("executing"), null);
	assert.equal(unitTypeToArenaGroup("verifying"), null);
	// Eccezione documentata (test (9)): "research-decision" è SIA la chiave
	// SIA l'unico membro del proprio gruppo (singolare unit-type che dà il
	// nome al gruppo). unitTypeToArenaGroup lo riconosce correttamente.
	assert.equal(unitTypeToArenaGroup("research-decision"), "research-decision");
	// Un nome fase (che non è un unitType) non appartiene a nessun gruppo.
	assert.equal(unitTypeToArenaGroup("summarizing"), null);
	assert.equal(unitTypeToArenaGroup("refining"), null);
	assert.equal(unitTypeToArenaGroup("escalating-task"), null);
});

test("(8) casi negativi: accesso runtime a una fase fuori dominio restituisce undefined", () => {
	// La firma restringe il dominio a Phase; a runtime una stringa arbitraria
	// non è una chiave della record totale e deve produrre undefined (nessuna
	// eccezione finta, nessun default creativo).
	const asStringRecord = PHASE_TO_UNIT_TYPES as Record<
		string,
		ReadonlySet<string>
	>;
	assert.equal(asStringRecord["not-a-phase"], undefined);
});

test("(9) il nome del gruppo research-decision non è una fase: i membri-gruppo restano nel mapping unitType->gruppo", () => {
	// La union Phase espon la fase "researching" e NON "research-decision":
	// "research-decision" è un unitType/gruppo, non una fase. Protegge dal
	// rischio che qualcuno confonda le due colonne del mapping.
	assert.ok(
		!(RESEARCH_UNIT_TYPE in PHASE_TO_UNIT_TYPES),
		"'research-decision' non deve essere una chiave di fase",
	);
	assert.equal(unitTypeToArenaGroup(RESEARCH_UNIT_TYPE), RESEARCH_UNIT_TYPE);
});

test("(10) invariante inverso: ogni unitType prodotto da una fase riconduce al gruppo che lo produce", () => {
	for (const phase of ALL_PHASES) {
		for (const unitType of phaseToUnitTypes(phase)) {
			const group = unitTypeToArenaGroup(unitType);
			assert.ok(
				group !== null,
				`l'unitType "${unitType}" (da fase "${phase}") deve avere un gruppo`,
			);
			if (group === null) {
				assert.fail(`round-trip null impossibile per "${unitType}"`);
			}
			assert.ok(
				ACTIVE_UNIT_TYPES[group].has(unitType),
				`il gruppo "${group}" deve contenere l'unitType "${unitType}"`,
			);
		}
	}
});

test("(11) chiusura: i round-trip inversi coprono ogni gruppo attivo", () => {
	const coveredGroups = new Set<string>();
	for (const group of Object.keys(ACTIVE_UNIT_TYPES)) {
		for (const unitType of ACTIVE_UNIT_TYPES[group]) {
			const roundTrip = unitTypeToArenaGroup(unitType);
			assert.ok(
				roundTrip !== null,
				`ogni membro "${unitType}" deve avere un gruppo`,
			);
			if (roundTrip !== null) {
				coveredGroups.add(roundTrip);
			}
		}
	}
	assert.deepEqual(
		[...coveredGroups].sort(),
		Object.keys(ACTIVE_UNIT_TYPES).sort(),
		"ogni gruppo attivo va raggiungibile in round-trip inverso da almeno un unitType",
	);
});

test("(12) purezza e immutabilità: strutture congelate, set readonly", () => {
	assert.ok(Object.isFrozen(ACTIVE_UNIT_TYPES));
	assert.ok(Object.isFrozen(PHASE_TO_UNIT_TYPES));
	for (const set of Object.values(ACTIVE_UNIT_TYPES)) {
		assert.ok(
			Object.isFrozen(set),
			"ogni set di ACTIVE_UNIT_TYPES deve essere congelato",
		);
	}
});

test("(13) identità del vuoto: due fasi non attive condividono lo stesso set vuoto", () => {
	assert.equal(
		phaseToUnitTypes("paused"),
		phaseToUnitTypes("blocked"),
		"fasi non attive devono riusare lo stesso set vuoto congelato",
	);
});