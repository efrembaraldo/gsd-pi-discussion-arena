/**
 * tests/unit/runtime-profiles.test.ts — T01/M011/S02.
 *
 * Test unitario della tabella dichiarativa `src/runtime-profiles.ts`.
 *
 * Contratto verificato (coerente con il piano S02):
 *   - `RUNTIME_PROFILES` espone ESATTAMENTE 6 voci, una per ciascuno dei
 *     nomi dichiarati: `full`, `no_unit_start`, `no_before_agent_start`,
 *     `no_adjust_tool_set`, `no_GSD_VERSION`, `partial`. Aggiungere un
 *     nuovo profilo o rimuoverne uno è una regressione del boundary
 *     contract della slice S02.
 *   - Ogni profilo dichiara correttamente `gsdVersion` (string|null),
 *     `capabilities` (ReadonlySet), `expectedTier` (F/A/D) e
 *     `expectedReasons` (readonly array di TierReasonCode).
 *   - `ACTIVE_PHASES` contiene ESATTAMENTE 6 fasi (derivate da
 *     `PHASE_TO_UNIT_TYPES` — fasi il cui insieme non è vuoto). Le 6
 *     fasi canoniche: researching, refining, discussing, planning,
 *     executing, verifying.
 *   - `SCENARIO_MATRIX` contiene ESATTAMENTE 36 celle (6 × 6), una per
 *     ogni coppia (profilo, fase attiva), senza duplicati né buchi.
 *   - Ogni cella eredita `expectedTier`/`expectedReasons` dal proprio
 *     profilo (la fase non altera la classificazione del classifier).
 *   - `getScenario(profile, phase)` ritorna la cella corretta o
 *     `undefined` per combinazioni non presenti.
 *   - INTEGRAZIONE: per ogni profilo, costruendo un `ExtensionAPI` stub
 *     le cui `api.on(event, noop)` ritornano `undefined` solo per gli
 *     eventi in `profile.capabilities` e lanciano sincronamente per gli
 *     altri (try/catch interno di `safeProbe` degrada il probe a
 *     `false`), ed impostando `process.env.GSD_VERSION` al valore di
 *     `profile.gsdVersion` (o rimuovendolo se null), la funzione pura
 *     `classifyRuntime(api)` ritorna ESATTAMENTE `expectedTier` con
 *     `expectedReasons` uguale (ordine incluso).
 *
 * Puro, nessun I/O subprocess, nessuna rete. Usa lo stesso pattern di
 * stub di `tests/runtime-classifier.test.ts` (throws-on-unsupported) e
 * il pattern di env-wrapping di `tests/tier-matrix.test.ts:withEnv`.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
	RUNTIME_PROFILES,
	ACTIVE_PHASES,
	SCENARIO_MATRIX,
	getScenario,
	buildApiStubFromProfile,
	withGSDVersion,
	type RuntimeProfileName,
} from "../../src/runtime-profiles.js";
import { classifyRuntime } from "../../src/runtime-classifier.js";
import type { Phase } from "../../src/phase-mapping.js";

// ════════════════════════════════════════════════════════════════════════════
// SEZIONE 1 — Forma della tabella RUNTIME_PROFILES
// ════════════════════════════════════════════════════════════════════════════

const EXPECTED_PROFILE_NAMES: readonly RuntimeProfileName[] = Object.freeze([
	"full",
	"no_unit_start",
	"no_before_agent_start",
	"no_adjust_tool_set",
	"no_GSD_VERSION",
	"partial",
] as const);

test("RUNTIME_PROFILES: contiene esattamente i 6 profili dichiarati (no mancanze, no extra)", () => {
	assert.equal(
		Object.keys(RUNTIME_PROFILES).length,
		6,
		"esattamente 6 profili nella tabella (S02 boundary contract)",
	);
	const actual = Object.keys(RUNTIME_PROFILES).sort();
	const expected = [...EXPECTED_PROFILE_NAMES].sort();
	assert.deepEqual(
		actual,
		expected,
		"i nomi dei profili devono corrispondere esattamente alla dichiarazione",
	);
});

test("RUNTIME_PROFILES: ogni profilo ha name, description, gsdVersion, capabilities, expectedTier, expectedReasons", () => {
	for (const name of EXPECTED_PROFILE_NAMES) {
		const profile = RUNTIME_PROFILES[name];
		assert.ok(profile !== undefined, `profilo ${name} presente`);
		assert.equal(profile.name, name, `name coerente per ${name}`);
		assert.equal(
			typeof profile.description,
			"string",
			`description string per ${name}`,
		);
		assert.ok(
			profile.description.length > 0,
			`description non vuota per ${name}`,
		);
		// gsdVersion: string | null (null solo per no_GSD_VERSION)
		if (name === "no_GSD_VERSION") {
			assert.equal(
				profile.gsdVersion,
				null,
				`no_GSD_VERSION: gsdVersion=null (env unset)`,
			);
		} else {
			assert.equal(
				typeof profile.gsdVersion,
				"string",
				`${name}: gsdVersion è string`,
			);
			assert.ok(
				(profile.gsdVersion ?? "").length > 0,
				`${name}: gsdVersion non vuoto`,
			);
		}
		// capabilities: ReadonlySet<CapabilityName>
		assert.ok(
			profile.capabilities instanceof Set,
			`${name}: capabilities è un Set`,
		);
		// expectedTier: "F" | "A" | "D"
		assert.ok(
			["F", "A", "D"].includes(profile.expectedTier),
			`${name}: expectedTier ∈ {F/A/D}`,
		);
		// expectedReasons: readonly array
		assert.ok(
			Array.isArray(profile.expectedReasons),
			`${name}: expectedReasons è array`,
		);
	}
});

test("RUNTIME_PROFILES: full ha tutti i 4 capability + expectedTier=F + reasons=[]", () => {
	const profile = RUNTIME_PROFILES.full;
	assert.deepEqual(
		[...profile.capabilities].sort(),
		["adjust_tool_set", "before_agent_start", "tool_call", "unit_start"],
		"full: tutti i 4 capability presenti",
	);
	assert.equal(profile.expectedTier, "F", "full → F");
	assert.deepEqual(
		[...profile.expectedReasons],
		[],
		"full: reasons vuote (nessuna capability mancante)",
	);
	assert.equal(profile.gsdVersion, "1.15.0", "full: GSD_VERSION valido");
});

test("RUNTIME_PROFILES: no_unit_start ha before_agent_start+adjust_tool_set+tool_call + expectedTier=A", () => {
	const profile = RUNTIME_PROFILES.no_unit_start;
	assert.equal(
		profile.capabilities.has("unit_start"),
		false,
		"no_unit_start: unit_start mancante",
	);
	assert.equal(
		profile.capabilities.has("before_agent_start"),
		true,
		"no_unit_start: before_agent_start presente",
	);
	assert.equal(
		profile.capabilities.has("adjust_tool_set"),
		true,
		"no_unit_start: adjust_tool_set presente",
	);
	assert.equal(profile.expectedTier, "A", "no_unit_start → A");
	assert.deepEqual(
		[...profile.expectedReasons],
		["no_unit_start"],
		"no_unit_start: reasons = [no_unit_start]",
	);
	assert.equal(profile.gsdVersion, "1.15.0");
});

test("RUNTIME_PROFILES: no_before_agent_start ha adjust_tool_set+unit_start+tool_call + expectedTier=D", () => {
	const profile = RUNTIME_PROFILES.no_before_agent_start;
	assert.equal(
		profile.capabilities.has("before_agent_start"),
		false,
		"no_before_agent_start: before_agent_start mancante",
	);
	assert.equal(profile.expectedTier, "D", "no_before_agent_start → D");
	assert.deepEqual(
		[...profile.expectedReasons],
		["no_before_agent_start"],
		"no_before_agent_start: reasons = [no_before_agent_start]",
	);
	assert.equal(profile.gsdVersion, "1.15.0");
});

test("RUNTIME_PROFILES: no_adjust_tool_set ha before_agent_start+unit_start+tool_call + expectedTier=D", () => {
	const profile = RUNTIME_PROFILES.no_adjust_tool_set;
	assert.equal(
		profile.capabilities.has("adjust_tool_set"),
		false,
		"no_adjust_tool_set: adjust_tool_set mancante",
	);
	assert.equal(profile.expectedTier, "D", "no_adjust_tool_set → D");
	assert.deepEqual(
		[...profile.expectedReasons],
		["no_adjust_tool_set"],
		"no_adjust_tool_set: reasons = [no_adjust_tool_set]",
	);
	assert.equal(profile.gsdVersion, "1.15.0");
});

test("RUNTIME_PROFILES: no_GSD_VERSION ha tutti i 4 capability ma gsdVersion=null + expectedTier=D", () => {
	const profile = RUNTIME_PROFILES.no_GSD_VERSION;
	assert.equal(profile.gsdVersion, null, "no_GSD_VERSION: gsdVersion=null");
	assert.equal(
		profile.capabilities.size,
		4,
		"no_GSD_VERSION: tutti i 4 hook capability presenti",
	);
	assert.equal(profile.expectedTier, "D", "no_GSD_VERSION → D");
	assert.deepEqual(
		[...profile.expectedReasons],
		["no_GSD_VERSION"],
		"no_GSD_VERSION: reasons = [no_GSD_VERSION]",
	);
});

test("RUNTIME_PROFILES: partial ha before_agent_start+tool_call + expectedTier=D con reasons multiple", () => {
	const profile = RUNTIME_PROFILES.partial;
	assert.deepEqual(
		[...profile.capabilities].sort(),
		["before_agent_start", "tool_call"],
		"partial: solo before_agent_start + tool_call",
	);
	assert.equal(profile.expectedTier, "D", "partial → D");
	assert.deepEqual(
		[...profile.expectedReasons],
		["no_adjust_tool_set", "no_unit_start"],
		"partial: reasons = [no_adjust_tool_set, no_unit_start] (ordine canonico di push dal classifier)",
	);
	assert.equal(profile.gsdVersion, "1.15.0");
});

// ════════════════════════════════════════════════════════════════════════════
// SEZIONE 2 — ACTIVE_PHASES (6 fasi attive della discussion arena)
// ════════════════════════════════════════════════════════════════════════════

const EXPECTED_ACTIVE_PHASES: readonly Phase[] = Object.freeze([
	"discussing",
	"researching",
	"refining",
	"planning",
	"executing",
	"verifying",
] as Phase[]);

test("ACTIVE_PHASES: contiene esattamente 6 fasi (derivato da PHASE_TO_UNIT_TYPES)", () => {
	assert.equal(
		ACTIVE_PHASES.length,
		6,
		"esattamente 6 fasi attive (S02 boundary contract 6×6)",
	);
});

test("ACTIVE_PHASES: contiene esattamente le 6 fasi attive canoniche", () => {
	const actual = [...ACTIVE_PHASES].sort();
	const expected = [...EXPECTED_ACTIVE_PHASES].sort();
	assert.deepEqual(
		actual,
		expected,
		"ACTIVE_PHASES corrisponde alle 6 fasi con PHASE_TO_UNIT_TYPES non vuoto",
	);
});

// ════════════════════════════════════════════════════════════════════════════
// SEZIONE 3 — SCENARIO_MATRIX (36 celle, nessuna duplicazione, copertura totale)
// ════════════════════════════════════════════════════════════════════════════

test("SCENARIO_MATRIX: contiene esattamente 36 celle (6 profili × 6 fasi)", () => {
	assert.equal(
		SCENARIO_MATRIX.length,
		36,
		"matrice 6×6 = 36 celle (S02 must-have #1)",
	);
});

test("SCENARIO_MATRIX: ogni cella è univoca per coppia (profile, phase)", () => {
	const seen = new Set<string>();
	for (const cell of SCENARIO_MATRIX) {
		const key = `${cell.profile}/${cell.phase}`;
		assert.equal(
			seen.has(key),
			false,
			`coppia duplicata: ${key}`,
		);
		seen.add(key);
	}
	assert.equal(
		seen.size,
		36,
		"36 coppie univoche — copertura totale di 6 profili × 6 fasi",
	);
});

test("SCENARIO_MATRIX: per ogni profilo × fase attiva esiste una cella", () => {
	for (const profileName of EXPECTED_PROFILE_NAMES) {
		for (const phase of ACTIVE_PHASES) {
			const found = SCENARIO_MATRIX.find(
				(c) => c.profile === profileName && c.phase === phase,
			);
			assert.ok(
				found !== undefined,
				`cella mancante per (${profileName}, ${phase})`,
			);
		}
	}
});

test("SCENARIO_MATRIX: ogni cella eredita expectedTier + expectedReasons dal profilo", () => {
	for (const cell of SCENARIO_MATRIX) {
		const profile = RUNTIME_PROFILES[cell.profile];
		assert.equal(
			cell.expectedTier,
			profile.expectedTier,
			`${cell.profile}/${cell.phase}: expectedTier coerente col profilo`,
		);
		assert.deepEqual(
			[...cell.expectedReasons],
			[...profile.expectedReasons],
			`${cell.profile}/${cell.phase}: expectedReasons coerente col profilo`,
		);
	}
});

// ════════════════════════════════════════════════════════════════════════════
// SEZIONE 4 — getScenario (lookup accessor)
// ════════════════════════════════════════════════════════════════════════════

test("getScenario: ritorna la cella corretta per una coppia (profile, phase) valida", () => {
	const cell = getScenario("full", "researching");
	assert.ok(cell !== undefined, "cella presente");
	assert.equal(cell!.profile, "full");
	assert.equal(cell!.phase, "researching");
	assert.equal(cell!.expectedTier, "F");
});

test("getScenario: ritorna undefined per combinazioni non presenti in matrice", () => {
	const cell = getScenario("full", "pre-planning");
	assert.equal(
		cell,
		undefined,
		"fase non attiva (`pre-planning`) → cella assente",
	);
});

// ════════════════════════════════════════════════════════════════════════════
// SEZIONE 5 — Integrazione classifier: tabella ≡ runtime-classifier
// ════════════════════════════════════════════════════════════════════════════

test("INTEGRAZIONE: classifyRuntime su stub del profilo restituisce ESATTAMENTE expectedTier + expectedReasons (per ogni profilo)", async () => {
	for (const name of EXPECTED_PROFILE_NAMES) {
		const profile = RUNTIME_PROFILES[name];
		const api = buildApiStubFromProfile(profile);
		const result = await withGSDVersion(profile.gsdVersion, () =>
			classifyRuntime(api),
		);
		assert.equal(
			result.tier,
			profile.expectedTier,
			`${name}: classifyRuntime ritorna tier=${profile.expectedTier}`,
		);
		assert.deepEqual(
			[...result.reasons],
			[...profile.expectedReasons],
			`${name}: classifyRuntime ritorna reasons=${JSON.stringify(profile.expectedReasons)}`,
		);
		// Capabilities osservate corrispondono al set dichiarato del profilo.
		assert.deepEqual(
			[...result.capabilities].sort(),
			[...profile.capabilities].sort(),
			`${name}: capabilities osservate ≡ dichiarate`,
		);
	}
});

test("INTEGRAZIONE: profilo `full` produce classification Tier F puro (no reasons)", () => {
	const api = buildApiStubFromProfile(RUNTIME_PROFILES.full);
	return withGSDVersion("1.15.0", () => {
		const result = classifyRuntime(api);
		assert.equal(result.tier, "F");
		assert.deepEqual([...result.reasons], []);
	});
});

test("INTEGRAZIONE: profilo `no_unit_start` produce Tier A con esattamente [no_unit_start]", () => {
	const api = buildApiStubFromProfile(RUNTIME_PROFILES.no_unit_start);
	return withGSDVersion("1.15.0", () => {
		const result = classifyRuntime(api);
		assert.equal(result.tier, "A");
		assert.deepEqual([...result.reasons], ["no_unit_start"]);
	});
});

test("INTEGRAZIONE: profilo `no_GSD_VERSION` produce Tier D con [no_GSD_VERSION] (short-circuit, hook reasons NON pushed)", () => {
	const api = buildApiStubFromProfile(RUNTIME_PROFILES.no_GSD_VERSION);
	return withGSDVersion(null, () => {
		// GSD_VERSION rimosso: il classifier deve cortocircuitare su
		// `parsedSemver === null` → tier=D, reasons=[no_GSD_VERSION].
		// Anche se TUTTI i probe ritornano true (stub `buildApiStubFromProfile`
		// ritorna `undefined` per tutti i 4 hook), il ramo `parsedSemver ===
		// null` precede il check sulle probe e gli hook reasons NON sono
		// pushed.
		const result = classifyRuntime(api);
		assert.equal(result.tier, "D");
		assert.deepEqual([...result.reasons], ["no_GSD_VERSION"]);
	});
});

test("INTEGRAZIONE: profilo `partial` produce reasons multiple cumulative nell'ordine di push del classifier", () => {
	const api = buildApiStubFromProfile(RUNTIME_PROFILES.partial);
	return withGSDVersion("1.15.0", () => {
		const result = classifyRuntime(api);
		assert.equal(result.tier, "D");
		// Ordine canonico di push del classifier: no_adjust_tool_set
		// (controllato prima di unit_start) → no_unit_start.
		assert.deepEqual(
			[...result.reasons],
			["no_adjust_tool_set", "no_unit_start"],
		);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// SEZIONE 6 — Anti-regressione: tabella frozen (ReadonlySet/Record/array)
// ════════════════════════════════════════════════════════════════════════════

test("RUNTIME_PROFILES: la tabella e ogni profilo sono congelati (no mutazione runtime)", () => {
	assert.equal(
		Object.isFrozen(RUNTIME_PROFILES),
		true,
		"RUNTIME_PROFILES è Object.frozen",
	);
	for (const name of EXPECTED_PROFILE_NAMES) {
		const profile = RUNTIME_PROFILES[name];
		assert.equal(
			Object.isFrozen(profile),
			true,
			`profilo ${name} è Object.frozen`,
		);
		assert.equal(
			Object.isFrozen(profile.capabilities),
			true,
			`capabilities di ${name} è Object.frozen (ReadonlySet)`,
		);
		assert.equal(
			Object.isFrozen(profile.expectedReasons),
			true,
			`expectedReasons di ${name} è Object.frozen (readonly array)`,
		);
	}
});

test("SCENARIO_MATRIX: la matrice è congelata e non può essere mutata a runtime", () => {
	assert.equal(
		Object.isFrozen(SCENARIO_MATRIX),
		true,
		"SCENARIO_MATRIX è Object.frozen",
	);
	for (const cell of SCENARIO_MATRIX) {
		assert.equal(
			Object.isFrozen(cell),
			true,
			`cella ${cell.profile}/${cell.phase} è Object.frozen`,
		);
	}
});