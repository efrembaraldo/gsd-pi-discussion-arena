/**
 * Unit tests per src/phase-mapping.ts (S01, D085).
 *
 * Copre:
 *  - le 18 fasi della union `Phase` come dominio totale di
 *    `PHASE_TO_UNIT_TYPES` (chiavi esatte, senza extra e senza lacune);
 *  - `phaseToUnitTypes` su tutte le 18 fasi (2 mappate ai gruppi attivi,
 *    16 al set vuoto condiviso), incluse le identità di riferimento con
 *    `ACTIVE_UNIT_TYPES`;
 *  - casi negativi: `unitTypeToArenaGroup` → null per unitType sconosciuto,
 *    stringa vuota, chiave-gruppo che non è membro del proprio set, nome
 *    fase non canoniche, e accesso runtime a una fase fuori dominio;
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

test("(4) la fase 'planning' attiva esattamente i 6 unitType di pianificazione", () => {
	assert.deepEqual(
		[...phaseToUnitTypes("planning")].sort(),
		[...PLANNING_UNIT_TYPES].sort(),
		"la fase planning deve attivare esattamente i 6 unitType del gruppo planning",
	);
});

test("(5) le altre 16 fasi restituiscono il set vuoto", () => {
	const nonActive = ALL_PHASES.filter(
		(p) => p !== "researching" && p !== "planning",
	);
	assert.equal(nonActive.length, 16, "attese 16 fasi non attive");
	for (const phase of nonActive) {
		assert.equal(
			phaseToUnitTypes(phase).size,
			0,
			`la fase "${phase}" deve mappare a un set vuoto`,
		);
	}
});

test("(6) identità di riferimento: le fasi attive riusano i set di ACTIVE_UNIT_TYPES", () => {
	assert.equal(
		phaseToUnitTypes("researching"),
		ACTIVE_UNIT_TYPES[RESEARCH_UNIT_TYPE],
		"phaseToUnitTypes('researching') deve essere il riferimento del gruppo",
	);
	assert.equal(
		phaseToUnitTypes("planning"),
		ACTIVE_UNIT_TYPES.planning,
		"phaseToUnitTypes('planning') deve essere il riferimento del gruppo",
	);
});

test("(7) casi negativi: unitTypeToArenaGroup → null fuori dai membri noti", () => {
	assert.equal(unitTypeToArenaGroup("not-a-real-unit-type"), null);
	assert.equal(unitTypeToArenaGroup(""), null);
	assert.equal(unitTypeToArenaGroup("<<garbage>>"), null);
	// La chiave del gruppo 'planning' NON è membro del proprio set: il mapping
	// è unitType -> gruppo, non chiave-gruppo -> gruppo (chiave != membro).
	assert.equal(unitTypeToArenaGroup("planning"), null);
	// Un nome fase (che non è un unitType) non appartiene a nessun gruppo.
	assert.equal(unitTypeToArenaGroup("summarizing"), null);
	assert.equal(unitTypeToArenaGroup("executing"), null);
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