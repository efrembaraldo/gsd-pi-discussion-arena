/**
 * Property-based test combinatorio (S07, D094) sul mapping Phase -> unitType
 * -> gruppo attivo.
 *
 * A differenza dei 13 unit test di fase-mapping (S01) — che fissano dominio
 * totale, immutabilità e round-trip sulle singole identità — questo file
 * esercita TUTTE le combinazioni reali (phase, unit-type) generate dal
 * catalogo `KNOWN_GSD_PI_UNIT_TYPES`, dimostrando a livello combinatorio che:
 *
 *   1. forward sweep: ogni unitType appartenente al set di una fase è mappato
 *      al gruppo di quella fase attiva (mai null);
 *   2. inverse sweep: `unitTypeToArenaGroup` è l'inverso deterministico di
 *      `phaseToUnitTypes` — ogni unitType mappato appartiene a UNA e una sola
 *      fase attiva; ogni unitType del catalogo non mappato appartiene a zero
 *      fasi;
 *   3. iniettività dei gruppi: i Set di `ACTIVE_UNIT_TYPES` sono disgiunti
 *      (nessun unitType in più di un gruppo);
 *   4. snapshot del catalogo: `KNOWN_GSD_PI_UNIT_TYPES` è il catalogo frozen
 *      (24 unitType primary di gsd-pi), la cui cardinalità è un vincolo duro
 *      che blocca la release se un nuovo unitType viene registrato senza
 *      essere mappato in un gruppo.
 *
 * CONTEGGIO "540 vs 432" (D094): la spec nominale di macro-area citava
 * "~30 unit reali" (~540 = 18×30). Il registro reale di gsd-pi
 * (`src/resources/extensions/gsd/unit-registry.ts`) espone esattamente
 * 24 unit-type `kind:"primary"` (+2 `"variant"` esclusi: `discuss-slice`,
 * `execute-task-simple`). Il prodotto reale del dominio è quindi 18 fasi × 24
 * unit = 432. La verifica combinatoria di questo file opera su 432 coppie.
 * `KNOWN_GSD_PI_UNIT_TYPES` è la fonte di verità di questa slice (fixture
 * testuale, tenuta in sync manualmente con le major release di gsd-pi; lo
 * snapshot del catalogo la blocca se il fixture diverge).
 *
 * Modulo target puro (nessun I/O), solo node:test + node:assert/strict
 * (D004): nessuna dipendenza npm, nessun framework property-based.
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
 * Catalogo frozen dei 24 unit-type `kind:"primary"` di gsd-pi.
 *
 * Fonte di verità: gsd-pi `src/resources/extensions/gsd/unit-registry.ts`
 * (`KNOWN_UNIT_TYPES` derivato dal registro, filtrato su `kind:"primary"`;
 * i 2 `variant` — `discuss-slice`, `execute-task-simple` — sono esclusi).
 * Ordinato alfabeticamente e congelato: questa costante È lo snapshot che
 * blocca la release se un nuovo unit-type viene aggiunto a gsd-pi senza
 * essere collegato al mapping (cardinalità bloccata = 24, D094).
 */
const KNOWN_GSD_PI_UNIT_TYPES: readonly string[] = Object.freeze([
	"complete-milestone",
	"complete-slice",
	"discuss-milestone",
	"discuss-project",
	"discuss-requirements",
	"execute-task",
	"gate-evaluate",
	"plan-milestone",
	"plan-slice",
	"quick-task",
	"reactive-execute",
	"reassess-roadmap",
	"refine-slice",
	"replan-slice",
	"replan-task",
	"research-decision",
	"research-milestone",
	"research-project",
	"research-slice",
	"rewrite-docs",
	"run-uat",
	"triage-captures",
	"validate-milestone",
	"workflow-preferences",
]);

/** Le 18 fasi del ciclo GSD, ricavate dal dominio della matrice (chiavi di PHASE_TO_UNIT_TYPES). */
const PHASES = Object.keys(PHASE_TO_UNIT_TYPES) as Phase[];

const PHASE_COUNT = 18;
const PRIMARY_UNIT_COUNT = 24;

/**
 * Deriva, per ogni gruppo di `ACTIVE_UNIT_TYPES`, la fase attiva il cui set
 * coincide (per riferimento) con quello del gruppo. È l'inverso deterministico
 * di `PHASE_TO_UNIT_TYPES`, costruito dalla sola matrice, non hardcoded.
 */
const GROUP_TO_ACTIVE_PHASE: ReadonlyMap<string, Phase> = (() => {
	const map = new Map<string, Phase>();
	for (const [group, groupUnitTypes] of Object.entries(ACTIVE_UNIT_TYPES)) {
		for (const phase of PHASES) {
			if (phaseToUnitTypes(phase) === groupUnitTypes) {
				map.set(group, phase);
				break;
			}
		}
	}
	return map;
})();

test("snapshot catalogo: 24 unit-type PRIMARY di gsd-pi, frozen, ordinato, senza duplicati e coerente coi gruppi", () => {
	// La fixture è lo snapshot: deve essere congelata e già ordinata.
	assert.ok(
		Object.isFrozen(KNOWN_GSD_PI_UNIT_TYPES),
		"il catalogo NON è frozen: lo snapshot deve essere immutabile",
	);
	assert.equal(
		KNOWN_GSD_PI_UNIT_TYPES.length,
		PRIMARY_UNIT_COUNT,
		"cardinalità catalogo: 24 reali (D094), non un valore nominale",
	);
	assert.deepEqual(
		[...KNOWN_GSD_PI_UNIT_TYPES].sort(),
		[...KNOWN_GSD_PI_UNIT_TYPES],
		"il catalogo deve essere già in ordine alfabetico",
	);
	assert.equal(
		new Set(KNOWN_GSD_PI_UNIT_TYPES).size,
		KNOWN_GSD_PI_UNIT_TYPES.length,
		"nessun duplicato nel catalogo",
	);

	// Guardia aggiunta-non-mappata: ogni unitType presente in un gruppo attivo
	// DEVE esistere nel catalogo reale (nessun membro fantasma/orfano).
	for (const phase of PHASES) {
		const phaseSet = phaseToUnitTypes(phase);
		for (const unit of phaseSet) {
			assert.ok(
				KNOWN_GSD_PI_UNIT_TYPES.includes(unit),
				`l'unit '${unit}' è in un gruppo attivo ma non nel catalogo reale (24 primari)`,
			);
		}
	}
});

test("forward sweep: tutte le 432 coppie (18 × 24) — l'unit di una fase attiva è mappato al gruppo giusto", () => {
	assert.equal(PHASES.length, PHASE_COUNT, "la matrice deve avere 18 fasi");
	assert.equal(KNOWN_GSD_PI_UNIT_TYPES.length, PRIMARY_UNIT_COUNT, "il fixture copre 24 unit-type");
	assert.equal(GROUP_TO_ACTIVE_PHASE.size, 2, "esattamente 2 fasi attive mappate ai 2 gruppi");

	let activeMemberships = 0;
	for (const phase of PHASES) {
		const phaseSet = phaseToUnitTypes(phase);
		for (const unit of KNOWN_GSD_PI_UNIT_TYPES) {
			// Valuta la coppia (phase, unit): se l'unit NON è nel set della fase non
			// esegue il corpo; il ciclo continua → tutte e 432 le coppie vengono valutate.
			if (!phaseSet.has(unit)) continue;
			activeMemberships += 1;
			const group = unitTypeToArenaGroup(unit);
			if (group === null) {
				assert.fail(`'${unit}' è nel set della fase '${phase}' ma unitTypeToArenaGroup è null`);
			}
			// La fase attiva che contiene l'unit deve essere ESATTAMENTE quella il
			// cui set è il gruppo di appartenenza dell'unit.
			assert.equal(
				phaseSet,
				ACTIVE_UNIT_TYPES[group],
				`fase '${phase}' non allineata al gruppo di '${unit}'`,
			);
		}
	}
	// Somma dei membri dei 2 gruppi attivi: research-decision(1) + planning(6) = 7.
	assert.equal(
		activeMemberships,
		7,
		"il numero di appartenenze attive (fase -> unit) deve essere 7 (1+6)",
	);
});

test("inverse sweep: ogni unit mappata cade in UNA sola fase attiva; ogni non-mappata in nessuna", () => {
	const allGroups = new Set(Object.keys(ACTIVE_UNIT_TYPES));
	for (const unit of KNOWN_GSD_PI_UNIT_TYPES) {
		const group = unitTypeToArenaGroup(unit);
		if (group !== null) {
			assert.ok(allGroups.has(group), `gruppo inatteso '${group}'`);
			const activePhase = GROUP_TO_ACTIVE_PHASE.get(group);
			assert.ok(activePhase, `gruppo '${group}' senza fase attiva derivata`);
			assert.ok(
				phaseToUnitTypes(activePhase).has(unit),
				`'${unit}' mappata al gruppo '${group}' ma assente nella fase attiva '${activePhase}'`,
			);
		}

		// Conta in quante fasi compare l'unit: una mappata deve stare in 1 sola
		// fase; una non-mappata in 0.
		let phasesContaining = 0;
		for (const phase of PHASES) {
			if (phaseToUnitTypes(phase).has(unit)) phasesContaining += 1;
		}
		const expectedContaining = group === null ? 0 : 1;
		assert.equal(
			phasesContaining,
			expectedContaining,
			`'${unit}' appartiene a ${phasesContaining} fasi, attese ${expectedContaining}`,
		);
	}
});

test("iniettività: i Set di ACTIVE_UNIT_TYPES sono disgiunti (nessun unit in due gruppi)", () => {
	const groupSets = Object.values(ACTIVE_UNIT_TYPES);
	for (let i = 0; i < groupSets.length; i += 1) {
		for (let j = i + 1; j < groupSets.length; j += 1) {
			for (const unit of groupSets[i]) {
				assert.equal(
					groupSets[j].has(unit),
					false,
					`'${unit}' presente in due gruppi (iniettività violata)`,
				);
			}
		}
	}
	// Coerenza a livello di funzione: unitTypeToArenaGroup deve essere in accordo
	// con l'appartenenza negli insiemi (al più un gruppo, mai meno del reale).
	for (const unit of KNOWN_GSD_PI_UNIT_TYPES) {
		let groupCount = 0;
		for (const groupSet of groupSets) if (groupSet.has(unit)) groupCount += 1;
		assert.ok(groupCount <= 1, `'${unit}' presente in ${groupCount} gruppi`);
		const group = unitTypeToArenaGroup(unit);
		assert.equal(
			group !== null,
			groupCount === 1,
			`per '${unit}': unitTypeToArenaGroup (${group}) incoerente col registro (${
				groupCount === 1 ? "nel gruppo" : "fuori da ogni gruppo"
			})`,
		);
	}
});

test("unitTypeToArenaGroup è l'inverso deterministico della matrice fase -> gruppo", () => {
	// Unione dei 2 gruppi attivi = insieme delle unit che DEVONO essere mappate.
	const union = new Set<string>();
	for (const groupUnitTypes of Object.values(ACTIVE_UNIT_TYPES)) {
		for (const unit of groupUnitTypes) union.add(unit);
	}
	// Ogni unit del fixture mappata da unitTypeToArenaGroup è un membro reale di
	// un gruppo attivo (coerenza forward).
	for (const unit of KNOWN_GSD_PI_UNIT_TYPES) {
		const group = unitTypeToArenaGroup(unit);
		if (group !== null) {
			assert.ok(union.has(unit), `'${unit}' mappata ma assente da ogni ACTIVE_UNIT_TYPES`);
		}
	}
	// Ogni membro di un gruppo attivo è riconosciuto da unitTypeToArenaGroup
	// (coerenza inverse: nessun buco di reverse-first).
	for (const unit of union) {
		assert.notEqual(unitTypeToArenaGroup(unit), null, `'${unit}' nel gruppo ma unitTypeToArenaGroup è null`);
	}
	assert.equal(union.size, 7, "unione dei 2 gruppi attivi: 7 (1+6)");
});