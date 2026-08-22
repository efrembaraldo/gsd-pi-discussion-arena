/**
 * tests/runtime-fallbacks-w1.test.ts — T06/M011/S04.
 *
 * EN — Bilingual guard for the W1.1–W1.5 risk registers in
 * `docs/architecture/runtime-fallbacks.{md,it.md}`. Slice S04 documents
 * five cross-repo PR workarounds (zero-PR strategy D102) for features of
 * gsd-pi that do NOT exist in the current upstream API:
 *
 *   - W1.1 — BeforeAgentStartEvent payload exposes only `phase: string`
 *     (no typed `unitType` union). Mitigation: compile-time matrix in
 *     `src/phase-mapping.ts` (ACTIVE_UNIT_TYPES + PHASE_TO_UNIT_TYPES).
 *   - W1.2 — `api.getCapabilities()` does not exist on `ExtensionAPI`.
 *     Mitigation: 4-hook sequential probe + `parseSemver(process.env.GSD_VERSION)`
 *     version fingerprint in `src/runtime-classifier.ts`.
 *   - W1.3 — Cross-repo PR proposing composable `adjust_tool_set`
 *     (`addTools`/`removeTools` methods on the event payload) was rejected.
 *     Mitigation: idempotent append via `.includes()` guard in
 *     `src/hooks-unit-aware.ts:168-178`.
 *   - W1.4 — `phase_change` event does NOT exist on `ExtensionAPI.on` (D084).
 *     Mitigation: closed `CapabilityName` union excludes do-not-probe hooks;
 *     runtime classifier never probes `phase_change`.
 *   - W1.5 — `api.getState()` does NOT exist on `ExtensionAPI` (D084).
 *     Mitigation: synchronous sub-millisecond `classifyRuntime` that never
 *     queries state.
 *
 * IT — Guardia bilingue per i registri W1.1–W1.5 in
 * `docs/architecture/runtime-fallbacks.{md,it.md}`. La slice S04 documenta
 * i cinque workaround interni (zero-PR strategy D102) per feature di gsd-pi
 * che NON esistono nell'API upstream corrente.
 *
 * La guardia asserisce (per ogni ## W1.x, in EN e IT):
 *
 *   - (1) EN/IT docs esistono e sono leggibili;
 *   - (2) entrambi hanno sezione ## W1.x non vuota;
 *   - (3) i 5 campi obbligatori del Risk register (Probability, Impact,
 *     Mitigation type, PR candidacy, Upstream issue) sono presenti;
 *   - (4) i termini tecnici canonici (path sorgente, simboli esportati,
 *     path di test) compaiono in modo speculare EN↔IT;
 *   - (5) i path dei file di test referenziati nella sezione Tests
 *     esistono su disco (no link rotti).
 *
 * Struttura: helper `assertSectionPopulated` chiamato 5 volte (una per
 * W1.x), 5 test distinct speculari EN↔IT + 1 test riassuntivo conteggio
 * sezioni + anti-regressione R1-R5 speculare al pattern R6.
 *
 * Tutti i test sono statici (lettura file + regex), nessuna dipendenza
 * runtime estesa oltre `node:fs/promises` + `node:path`.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const EN_DOC = path.join(REPO_ROOT, "docs", "architecture", "runtime-fallbacks.md");
const IT_DOC = path.join(REPO_ROOT, "docs", "architecture", "runtime-fallbacks.it.md");

type W1Suffix = 1 | 2 | 3 | 4 | 5;

/**
 * Pattern statici (no interpolazione dinamica) per identificare l'header
 * `## W1.x` di ciascuna sezione. Usati al posto di una singola `RegExp`
 * con `${suffix}` per evitare il pattern-flag ReDoS dell'analisi statica.
 */
const W1_HEADER_REGEXES: Record<W1Suffix, RegExp> = {
	1: /^## W1\.1\s*$/m,
	2: /^## W1\.2\s*$/m,
	3: /^## W1\.3\s*$/m,
	4: /^## W1\.4\s*$/m,
	5: /^## W1\.5\s*$/m,
};

/**
 * Estrae il contenuto della sezione `## W1.${suffix}` (header incluso) dal
 * testo del file. Se l'header manca, ritorna `null`. Se l'header esiste ma
 * la sezione è vuota fino al prossimo `## ` o EOF, ritorna la stringa fino
 * al boundary.
 */
function extractW1Section(text: string, suffix: W1Suffix): string | null {
	const headerRe = W1_HEADER_REGEXES[suffix];
	const match = headerRe.exec(text);
	if (!match) return null;
	const start = match.index;
	const tail = text.slice(start + match[0].length);
	// Prossimo header `## ` dopo W1.x marca il boundary della sezione.
	// Per W1.5 (ultima sezione) tail non matcha nulla → end = EOF.
	const nextHeaderRe = /^## /m;
	const next = nextHeaderRe.exec(tail);
	const end = next ? start + match[0].length + next.index : text.length;
	return text.slice(start, end);
}

async function readDoc(filePath: string): Promise<string> {
	return await fs.readFile(filePath, "utf-8");
}

// =============================================================================
// (1) File esistenza + accessibilità.
// =============================================================================

test("docs EN runtime-fallbacks.md esiste ed è leggibile", async () => {
	const stat = await fs.stat(EN_DOC);
	assert.equal(stat.isFile(), true, `${EN_DOC} deve essere un file`);
	const content = await readDoc(EN_DOC);
	assert.ok(content.length > 0, "contenuto non vuoto");
});

test("docs IT runtime-fallbacks.it.md esiste ed è leggibile", async () => {
	const stat = await fs.stat(IT_DOC);
	assert.equal(stat.isFile(), true, `${IT_DOC} deve essere un file`);
	const content = await readDoc(IT_DOC);
	assert.ok(content.length > 0, "contenuto non vuoto");
});

// =============================================================================
// (2) Sezioni ## W1.x presenti e non vuote (speculari EN/IT, una per W1.x).
// =============================================================================

for (const suffix of [1, 2, 3, 4, 5] as const) {
	test(`EN runtime-fallbacks.md contiene una sezione ## W1.${suffix} non vuota`, async () => {
		const text = await readDoc(EN_DOC);
		const section = extractW1Section(text, suffix);
		assert.ok(section !== null, `header ## W1.${suffix} deve essere presente`);
		assert.ok(
			section !== null && section.trim().length > 50,
			`sezione ## W1.${suffix} deve essere popolata (>50 caratteri)`,
		);
		assert.ok(
			section !== null && /## W1\.\d+\s*\n[\s\S]+\S/.test(section),
			`## W1.${suffix} deve avere almeno una riga di contenuto non-blank`,
		);
	});

	test(`IT runtime-fallbacks.it.md contiene una sezione ## W1.${suffix} non vuota`, async () => {
		const text = await readDoc(IT_DOC);
		const section = extractW1Section(text, suffix);
		assert.ok(section !== null, `header ## W1.${suffix} deve essere presente`);
		assert.ok(
			section !== null && section.trim().length > 50,
			`sezione ## W1.${suffix} deve essere popolata (>50 caratteri)`,
		);
		assert.ok(
			section !== null && /## W1\.\d+\s*\n[\s\S]+\S/.test(section),
			`## W1.${suffix} deve avere almeno una riga di contenuto non-blank`,
		);
	});
}

// =============================================================================
// (3) Campi obbligatori del Risk register (speculari EN ↔ IT, 5 campi).
// =============================================================================

const REQUIRED_FIELDS = [
	"Probability",
	"Impact",
	"Mitigation type",
	"PR candidacy",
	"Upstream issue",
] as const;

// =============================================================================
// (4) Termini tecnici canonici per sezione W1.x.
// =============================================================================

/**
 * Identificatori canonici per sezione. Sono nomi di simboli, percorsi di
 * file sorgente o path di test referenziati: la lingua della prosa NON li
 * traduce. La guardia asserisce che ciascuno compaia nella sezione ## W1.x
 * corrispondente in EN e IT in modo speculare.
 */
const CANONICAL_TERMS_BY_W1: Record<W1Suffix, readonly string[]> = {
	// W1.1 — BeforeAgentStartEvent senza unitType typed.
	1: [
		"BeforeAgentStartEvent",
		"ACTIVE_UNIT_TYPES",
		"PHASE_TO_UNIT_TYPES",
		"src/phase-mapping.ts",
		"phaseToUnitTypes",
		"unitTypeToArenaGroup",
		"tests/phase-mapping.test.ts",
		"tests/property-phase-mapping.test.ts",
	],
	// W1.2 — api.getCapabilities() inesistente.
	2: [
		"api.getCapabilities()",
		"ExtensionAPI",
		"PROBE_HOOKS",
		"safeProbe",
		"classifyRuntime",
		"parseSemver",
		"process.env.GSD_VERSION",
		"src/runtime-classifier.ts",
		"tests/runtime-classifier.test.ts",
	],
	// W1.3 — adjust_tool_set composable (addTools/removeTools) rifiutato.
	3: [
		"adjust_tool_set",
		"addTools",
		"removeTools",
		"activeToolNames",
		"attachUnitAwareHooks",
		"src/hooks-unit-aware.ts",
		"UNIT_AWARE_TOOL_NAME",
		"discussion_arena",
		"extension-manifest.json",
		"isActive()",
		"tests/tier-matrix.test.ts",
		"tests/extension-manifest.test.ts",
	],
	// W1.4 — phase_change non probeato.
	4: [
		"phase_change",
		"ExtensionAPI.on",
		"PROBE_HOOKS",
		"safeProbe",
		"CapabilityName",
		"src/runtime-classifier.ts",
		"parseSemver",
		"tests/runtime-classifier.test.ts",
		"vendor/pi-coding-agent/dist/core/extensions/extension-upstream-types.d.ts",
	],
	// W1.5 — api.getState() inesistente.
	5: [
		"api.getState()",
		"ExtensionAPI",
		"classifyRuntime",
		"parseSemver",
		"safeProbe",
		"process.env.GSD_VERSION",
		"src/runtime-classifier.ts",
		"tests/runtime-classifier.test.ts",
	],
};

/**
 * Helper: asserisce che la sezione ## W1.${suffix} sia presente, non vuota,
 * con tutti i 5 campi del Risk register e tutti i termini canonici specifici,
 * speculari tra EN e IT. Chiamato 5 volte (una per W1.x) dal test distinct
 * sottostante.
 */
async function assertSectionPopulated(suffix: W1Suffix): Promise<void> {
	for (const [lang, file] of [
		["en", EN_DOC],
		["it", IT_DOC],
	] as const) {
		const text = await readDoc(file);
		const section = extractW1Section(text, suffix);
		assert.ok(
			section !== null,
			`[${lang}] header ## W1.${suffix} deve essere presente`,
		);
		// Non-vuoto.
		assert.ok(
			section!.trim().length > 50,
			`[${lang}] sezione ## W1.${suffix} deve essere popolata (>50 caratteri)`,
		);
		// Almeno una riga di contenuto non-blank dopo l'header.
		assert.ok(
			/## W1\.\d+\s*\n[\s\S]+\S/.test(section!),
			`[${lang}] ## W1.${suffix} deve avere almeno una riga di contenuto non-blank`,
		);
		// 5 campi obbligatori del Risk register.
		for (const field of REQUIRED_FIELDS) {
			assert.ok(
				section!.includes(field),
				`[${lang}] W1.${suffix}: campo obbligatorio mancante "${field}"`,
			);
		}
		// Termini canonici specifici di W1.${suffix}.
		for (const term of CANONICAL_TERMS_BY_W1[suffix]) {
			assert.ok(
				section!.includes(term),
				`[${lang}] W1.${suffix}: termine canonico mancante "${term}"`,
			);
		}
	}
}

// =============================================================================
// (3)+(4) Helper `assertSectionPopulated` chiamato 5 volte: 5 test distinct
// speculari EN↔IT (uno per W1.x). Ciascuno asserisce presenza sezione, non
// vuoto, 5 campi Risk register, e termini canonici specifici in EN+IT.
// =============================================================================

for (const suffix of [1, 2, 3, 4, 5] as const) {
	test(`W1.${suffix}: sezione speculare EN↔IT con 5 campi Risk register e termini canonici (assertSectionPopulated)`, async () => {
		await assertSectionPopulated(suffix);
	});
}

// =============================================================================
// Test riassuntivo conteggio sezioni: EN+IT hanno esattamente 5 W1.x.
// =============================================================================

test("EN runtime-fallbacks.md contiene esattamente 5 sezioni ## W1.x (W1.1, W1.2, W1.3, W1.4, W1.5)", async () => {
	const text = await readDoc(EN_DOC);
	const matches = text.match(/^## W1\.\d+\s*$/gm) ?? [];
	assert.equal(
		matches.length,
		5,
		`trovate ${matches.length} sezioni ## W1.x in EN (attese 5)`,
	);
	const suffixes = matches.map((m) => m.match(/W1\.(\d+)/)?.[1]).sort();
	assert.deepEqual(suffixes, ["1", "2", "3", "4", "5"]);
});

test("IT runtime-fallbacks.it.md contiene esattamente 5 sezioni ## W1.x (W1.1, W1.2, W1.3, W1.4, W1.5)", async () => {
	const text = await readDoc(IT_DOC);
	const matches = text.match(/^## W1\.\d+\s*$/gm) ?? [];
	assert.equal(
		matches.length,
		5,
		`trovate ${matches.length} sezioni ## W1.x in IT (attese 5)`,
	);
	const suffixes = matches.map((m) => m.match(/W1\.(\d+)/)?.[1]).sort();
	assert.deepEqual(suffixes, ["1", "2", "3", "4", "5"]);
});

// =============================================================================
// Anti-regressione: R1-R5 mantengono lo stato scheletro (placeholder onesto),
// R6 mantiene la sua mitigazione pending-research, R7 rimane scheletro.
// =============================================================================

/**
 * Termini tecnici che caratterizzano ESCLUSIVAMENTE le mitigazioni W1.x.
 * Se appaiono nel body di R1-R5 (gestiti da milestone distinti, non da S04)
 * significa che c'è stato un overlap non voluto.
 */
const W1_CANONICAL_TERMS_REGEX =
	/phase_change|getCapabilities|getState|BeforeAgentStartEvent|ACTIVE_UNIT_TYPES|PROBE_HOOKS|adjust_tool_set|addTools|removeTools|UNIT_AWARE_TOOL_NAME|CapabilityName|safeProbe|attachUnitAwareHooks|phaseToUnitTypes|unitTypeToArenaGroup|PHASE_TO_UNIT_TYPES/;

test("EN runtime-fallbacks.md: sezioni R1, R2, R3, R4, R5 mantengono lo stato scheletro (placeholder onesto)", async () => {
	const text = await readDoc(EN_DOC);
	const lines = text.split("\n");
	// Header R1-R7 esistenti.
	for (const rn of ["R1", "R2", "R3", "R4", "R5", "R6", "R7"]) {
		const headerLine = `## ${rn}`;
		const found = lines.some((l) => l.trim() === headerLine);
		assert.ok(found, `header ## ${rn} deve esistere`);
	}
	// R1-R5 NON devono contenere contenuti relativi alle mitigazioni W1.x.
	for (const rn of ["R1", "R2", "R3", "R4", "R5"]) {
		const headerLine = `## ${rn}`;
		const lineIdx = lines.findIndex((l) => l.trim() === headerLine);
		if (lineIdx === -1) continue;
		// Body = righe dopo l'header fino al prossimo header `## R\d`.
		// Pattern statico (no input dinamico) → non flaggato ReDoS.
		const bodyLines: string[] = [];
		for (let i = lineIdx + 1; i < lines.length; i++) {
			if (/^## R\d/.test(lines[i])) break;
			bodyLines.push(lines[i]);
		}
		const body = bodyLines.join("\n");
		assert.ok(
			!W1_CANONICAL_TERMS_REGEX.test(body),
			`${rn} non deve contenere contenuti relativi alle mitigazioni W1.x (è gestita da S04)`,
		);
	}
});

test("IT runtime-fallbacks.it.md: sezioni R1, R2, R3, R4, R5 mantengono lo stato scheletro (placeholder onesto)", async () => {
	const text = await readDoc(IT_DOC);
	const lines = text.split("\n");
	for (const rn of ["R1", "R2", "R3", "R4", "R5", "R6", "R7"]) {
		const headerLine = `## ${rn}`;
		const found = lines.some((l) => l.trim() === headerLine);
		assert.ok(found, `header ## ${rn} deve esistere`);
	}
	for (const rn of ["R1", "R2", "R3", "R4", "R5"]) {
		const headerLine = `## ${rn}`;
		const lineIdx = lines.findIndex((l) => l.trim() === headerLine);
		if (lineIdx === -1) continue;
		const bodyLines: string[] = [];
		for (let i = lineIdx + 1; i < lines.length; i++) {
			if (/^## R\d/.test(lines[i])) break;
			bodyLines.push(lines[i]);
		}
		const body = bodyLines.join("\n");
		assert.ok(
			!W1_CANONICAL_TERMS_REGEX.test(body),
			`${rn} non deve contenere contenuti relativi alle mitigazioni W1.x (è gestita da S04)`,
		);
	}
});

// =============================================================================
// (5) Path dei file di test referenziati nelle sezioni W1.x esistono su disco.
// =============================================================================

test("EN runtime-fallbacks.md cita path di file di test che esistono su disco nelle sezioni W1.x", async () => {
	const text = await readDoc(EN_DOC);
	const allPaths = new Set<string>();
	for (const suffix of [1, 2, 3, 4, 5] as const) {
		const section = extractW1Section(text, suffix);
		assert.ok(
			section !== null,
			`precondizione: ## W1.${suffix} presente in EN`,
		);
		const paths = section!.match(/tests\/[A-Za-z0-9._/-]+\.test\.ts/g) ?? [];
		paths.forEach((p) => allPaths.add(p));
	}
	assert.ok(
		allPaths.size > 0,
		"almeno un path di file di test referenziato nelle sezioni W1.x EN",
	);
	for (const relPath of allPaths) {
		const abs = path.join(REPO_ROOT, relPath);
		const stat = await fs.stat(abs).catch(() => null);
		assert.ok(
			stat !== null && stat.isFile(),
			`path di test referenziato ma non esistente: ${relPath}`,
		);
	}
});

test("IT runtime-fallbacks.it.md cita path di file di test che esistono su disco nelle sezioni W1.x", async () => {
	const text = await readDoc(IT_DOC);
	const allPaths = new Set<string>();
	for (const suffix of [1, 2, 3, 4, 5] as const) {
		const section = extractW1Section(text, suffix);
		assert.ok(
			section !== null,
			`precondizione: ## W1.${suffix} presente in IT`,
		);
		const paths = section!.match(/tests\/[A-Za-z0-9._/-]+\.test\.ts/g) ?? [];
		paths.forEach((p) => allPaths.add(p));
	}
	assert.ok(
		allPaths.size > 0,
		"almeno un path di file di test referenziato nelle sezioni W1.x IT",
	);
	for (const relPath of allPaths) {
		const abs = path.join(REPO_ROOT, relPath);
		const stat = await fs.stat(abs).catch(() => null);
		assert.ok(
			stat !== null && stat.isFile(),
			`path di test referenziato ma non esistente: ${relPath}`,
		);
	}
});
