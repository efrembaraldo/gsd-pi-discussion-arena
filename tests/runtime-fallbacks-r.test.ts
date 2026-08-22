/**
 * tests/runtime-fallbacks-r.test.ts — T04/M011/S06.
 *
 * EN — Bilingual guard for the R1, R2, R3, R4, R5 and R7 risk registers
 * in `docs/architecture/runtime-fallbacks.{md,it.md}`. Slice S06 populates
 * these six runtime risks with on-disk mitigations and bounded contracts;
 * R6 has its own dedicated guard (`tests/runtime-fallbacks-r6.test.ts`)
 * because its S01 mitigation uses a distinct lock-primitive vocabulary
 * (`withPendingResearchLock`, `pending-research.lock`) that would
 * interfere with the umbrella R guard.
 *
 * IT — Guardia bilingue per i registri R1, R2, R3, R4, R5 e R7 in
 * `docs/architecture/runtime-fallbacks.{md,it.md}`. La slice S06 popola
 * questi sei rischi runtime con mitigazioni su disco e contratti
 * delimitati; R6 ha la sua guardia dedicata
 * (`tests/runtime-fallbacks-r6.test.ts`) perché la sua mitigazione S01
 * usa un vocabolario distinto di primitive di lock
 * (`withPendingResearchLock`, `pending-research.lock`) che
 * interferirebbe con la guardia ombrello R.
 *
 * La guardia asserisce (per ogni `## Rn` in {R1, R2, R3, R4, R5, R7},
 * in EN e IT):
 *
 *   - (1) EN/IT docs esistono e sono leggibili;
 *   - (2) entrambi hanno sezione `## Rn` non vuota (estratta fino al
 *     prossimo header `## R\d+` o `## W1.\d+`);
 *   - (3) i 5 campi obbligatori del Risk register (`Probability`,
 *     `Impact`, `Mitigation type`, `PR candidacy`, `Upstream issue`)
 *     sono presenti in EN e IT;
 *   - (4) la matrice di termini tecnici canonici specifici per il
 *     rischio compare in modo speculare EN↔IT;
 *   - (5) ogni path `tests/...test.ts` referenziato nelle sezioni
 *     esiste su disco (no link rotti alla documentazione).
 *
 * Struttura: helper `assertRSectionPopulated` chiamato 6 volte (una per
 * R1, R2, R3, R4, R5, R7), 6 test distinct speculari EN↔IT + 2 test
 * riassuntivi presenza sezioni + anti-regressione R6-overlap sulle
 * sezioni R1-R5/R7 (nessuna assorbe la mitigazione pending-research
 * della R6) + validazione on-disk dei path `tests/`.
 *
 * Tutti i test sono statici (lettura file + regex), nessuna dipendenza
 * runtime estesa oltre `node:fs/promises` + `node:path`. La guardia NON
 * legge le directory `.gsd/`, `.planning/`, o `.audits/` — solo i due
 * documenti `docs/architecture/runtime-fallbacks.{md,it.md}` e la
 * verifica dei path `tests/` dichiarati nelle sezioni.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const EN_DOC = path.join(REPO_ROOT, "docs", "architecture", "runtime-fallbacks.md");
const IT_DOC = path.join(REPO_ROOT, "docs", "architecture", "runtime-fallbacks.it.md");

type RSuffix = 1 | 2 | 3 | 4 | 5 | 7;

/**
 * Pattern statici (no interpolazione dinamica) per identificare l'header
 * `## Rn` di ciascuna sezione. Usati al posto di una singola `RegExp`
 * con `${suffix}` per evitare il pattern-flag ReDoS dell'analisi statica.
 */
const R_HEADER_REGEXES: Record<RSuffix, RegExp> = {
	1: /^## R1\s*$/m,
	2: /^## R2\s*$/m,
	3: /^## R3\s*$/m,
	4: /^## R4\s*$/m,
	5: /^## R5\s*$/m,
	7: /^## R7\s*$/m,
};

/**
 * Boundary regex (static, no interpolation): il prossimo header
 * `## R\d+` o `## W1.\d+` marca la fine della sezione corrente.
 * Catturato in una costante per non riallocarlo a ogni chiamata.
 */
const R_BOUNDARY_REGEX = /^## (R\d|W1\.\d)/m;

/**
 * Estrae il contenuto della sezione `## R${suffix}` (header incluso) dal
 * testo del file. Se l'header manca, ritorna `null`. Se l'header esiste
 * ma la sezione è vuota fino al prossimo header R/W1 o EOF, ritorna la
 * stringa fino al boundary.
 */
function extractRSection(text: string, suffix: RSuffix): string | null {
	const headerRe = R_HEADER_REGEXES[suffix];
	const match = headerRe.exec(text);
	if (!match) return null;
	const start = match.index;
	const tail = text.slice(start + match[0].length);
	const next = R_BOUNDARY_REGEX.exec(tail);
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
// (2) Sezioni `## Rn` presenti e non vuote (speculari EN/IT, 6 Rn × 2 lingue).
// =============================================================================

for (const suffix of [1, 2, 3, 4, 5, 7] as const) {
	test(`EN runtime-fallbacks.md contiene una sezione ## R${suffix} non vuota`, async () => {
		const text = await readDoc(EN_DOC);
		const section = extractRSection(text, suffix);
		assert.ok(section !== null, `header ## R${suffix} deve essere presente`);
		assert.ok(
			section !== null && section.trim().length > 50,
			`sezione ## R${suffix} deve essere popolata (>50 caratteri)`,
		);
		assert.ok(
			section !== null && /## R\d+\s*\n[\s\S]+\S/.test(section),
			`## R${suffix} deve avere almeno una riga di contenuto non-blank`,
		);
	});

	test(`IT runtime-fallbacks.it.md contiene una sezione ## R${suffix} non vuota`, async () => {
		const text = await readDoc(IT_DOC);
		const section = extractRSection(text, suffix);
		assert.ok(section !== null, `header ## R${suffix} deve essere presente`);
		assert.ok(
			section !== null && section.trim().length > 50,
			`sezione ## R${suffix} deve essere popolata (>50 caratteri)`,
		);
		assert.ok(
			section !== null && /## R\d+\s*\n[\s\S]+\S/.test(section),
			`## R${suffix} deve avere almeno una riga di contenuto non-blank`,
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
// (4) Termini tecnici canonici per sezione `## Rn`.
// =============================================================================

/**
 * Identificatori canonici per sezione. Sono nomi di simboli, percorsi
 * di file sorgente o path di test referenziati: la lingua della prosa
 * NON li traduce. La guardia asserisce che ciascuno compaia nella
 * sezione `## Rn` corrispondente in EN e IT in modo speculare.
 */
const CANONICAL_TERMS_BY_R: Record<RSuffix, readonly string[]> = {
	// R1 — umbrella meta-risk della strategia zero-PR (D102).
	1: [
		"W1.1",
		"W1.5",
		"D102",
		"src/runtime-classifier.ts",
		"src/phase-mapping.ts",
	],
	// R2 — Phase→UnitType frozen matrix.
	2: [
		"ACTIVE_UNIT_TYPES",
		"PHASE_TO_UNIT_TYPES",
		"phaseToUnitTypes",
		"unitTypeToArenaGroup",
		"src/phase-mapping.ts",
		"tests/phase-mapping.test.ts",
		"tests/property-phase-mapping.test.ts",
	],
	// R3 — Tier F/A/D classifier con closed probe + stderr one-shot + counter.
	3: [
		"classifyRuntime",
		"CapabilityName",
		"emitDeprecationWarningOnce",
		"[discussion-arena DEGRADED]",
		"recordDegraded",
		"discussion_arena_degraded_total",
		"src/runtime-classifier.ts",
	],
	// R4 — CLI triplo-stato in scripts/e2e-real.mjs.
	4: [
		"GSD_E2E_SKIP",
		"findGsd",
		"spawnSync",
		"[e2e-real]",
		"scripts/e2e-real.mjs",
		"SCENARIO_MATRIX",
	],
	// R5 — model_default override via coordination file.
	5: [
		"model_default",
		"modelDefault",
		"loadDiscussionArenaCoordination",
		"src/discussion-arena-coordination.ts",
		"tests/examples-validation.test.ts",
	],
	// R7 — cwdHashShort SHA-256 prefix per transcript disambiguation.
	7: [
		"cwdHashShort",
		"getSessionFilePath",
		"SHA-256",
		"discussion-arena-session.ts",
		"tests/discussion-arena-session.test.ts",
	],
};

/**
 * Helper: asserisce che la sezione `## R${suffix}` sia presente, non
 * vuota, con tutti i 5 campi del Risk register e tutti i termini
 * canonici specifici, speculari tra EN e IT. Chiamato 6 volte (una
 * per Rn ∈ {1, 2, 3, 4, 5, 7}) dal test distinct sottostante.
 */
async function assertRSectionPopulated(suffix: RSuffix): Promise<void> {
	for (const [lang, file] of [
		["en", EN_DOC],
		["it", IT_DOC],
	] as const) {
		const text = await readDoc(file);
		const section = extractRSection(text, suffix);
		assert.ok(
			section !== null,
			`[${lang}] header ## R${suffix} deve essere presente`,
		);
		// Non-vuoto.
		assert.ok(
			section!.trim().length > 50,
			`[${lang}] sezione ## R${suffix} deve essere popolata (>50 caratteri)`,
		);
		// Almeno una riga di contenuto non-blank dopo l'header.
		assert.ok(
			/## R\d+\s*\n[\s\S]+\S/.test(section!),
			`[${lang}] ## R${suffix} deve avere almeno una riga di contenuto non-blank`,
		);
		// 5 campi obbligatori del Risk register.
		for (const field of REQUIRED_FIELDS) {
			assert.ok(
				section!.includes(field),
				`[${lang}] R${suffix}: campo obbligatorio mancante "${field}"`,
			);
		}
		// Termini canonici specifici di R${suffix}.
		for (const term of CANONICAL_TERMS_BY_R[suffix]) {
			assert.ok(
				section!.includes(term),
				`[${lang}] R${suffix}: termine canonico mancante "${term}"`,
			);
		}
	}
}

// =============================================================================
// (3)+(4) Helper `assertRSectionPopulated` chiamato 6 volte: 6 test distinct
// speculari EN↔IT (uno per Rn ∈ {1, 2, 3, 4, 5, 7}). Ciascuno asserisce
// presenza sezione, non-vuoto, 5 campi Risk register, e termini canonici
// specifici in EN+IT.
// =============================================================================

for (const suffix of [1, 2, 3, 4, 5, 7] as const) {
	test(`R${suffix}: sezione speculare EN↔IT con 5 campi Risk register e termini canonici (assertRSectionPopulated)`, async () => {
		await assertRSectionPopulated(suffix);
	});
}

// =============================================================================
// Test riassuntivo presenza sezioni: EN+IT hanno tutti i 6 header
// `## Rn` (R1, R2, R3, R4, R5, R7) attesi dalla guardia, in aggiunta
// alla R6 gestita dalla guardia dedicata.
// =============================================================================

test("EN runtime-fallbacks.md contiene i 6 header ## Rn attesi dalla guardia (R1, R2, R3, R4, R5, R7)", async () => {
	const text = await readDoc(EN_DOC);
	const expected = ["R1", "R2", "R3", "R4", "R5", "R7"];
	const lines = text.split("\n");
	for (const rn of expected) {
		const headerLine = `## ${rn}`;
		const found = lines.some((l) => l.trim() === headerLine);
		assert.ok(found, `header ## ${rn} deve esistere`);
	}
});

test("IT runtime-fallbacks.it.md contiene i 6 header ## Rn attesi dalla guardia (R1, R2, R3, R4, R5, R7)", async () => {
	const text = await readDoc(IT_DOC);
	const expected = ["R1", "R2", "R3", "R4", "R5", "R7"];
	const lines = text.split("\n");
	for (const rn of expected) {
		const headerLine = `## ${rn}`;
		const found = lines.some((l) => l.trim() === headerLine);
		assert.ok(found, `header ## ${rn} deve esistere`);
	}
});

// =============================================================================
// Anti-regressione: nessuna sezione R1-R5/R7 assorbe la mitigazione R6
// (lock pending-research). La R6 ha una guardia dedicata
// (tests/runtime-fallbacks-r6.test.ts) che fissa la sua mitigazione; se
// R1-R5/R7 iniziasse a duplicare quei termini, sarebbe un overlap non
// voluto e la guardia R6 smetterebbe di essere la single source of truth.
// =============================================================================

/**
 * Regex statica (no input dinamico) dei termini unici della mitigazione
 * R6 pending-research, come da piano T04: `pending-research`,
 * `discussion-arena-pending-research.ts`, `withPendingResearchLock`,
 * `pending-research.lock`. NON include la forma broad `discussion-arena`
 * perché il prefisso canonico compare legittimamente in R3
 * (`[discussion-arena DEGRADED]`).
 */
const R6_OVERLAP_REGEX =
	/pending-research|discussion-arena-pending-research\.ts|withPendingResearchLock|pending-research\.lock/;

test("EN runtime-fallbacks.md: sezioni R1-R5/R7 non assorbono la mitigazione R6 (pending-research)", async () => {
	const text = await readDoc(EN_DOC);
	const lines = text.split("\n");
	for (const rn of ["R1", "R2", "R3", "R4", "R5", "R7"]) {
		const headerLine = `## ${rn}`;
		const lineIdx = lines.findIndex((l) => l.trim() === headerLine);
		assert.ok(lineIdx !== -1, `header ## ${rn} deve esistere`);
		// Body = righe dopo l'header fino al prossimo header `## R\d` o
		// `## W1.\d`. Pattern statico (no input dinamico) → non flaggato
		// ReDoS.
		const bodyLines: string[] = [];
		for (let i = lineIdx + 1; i < lines.length; i++) {
			if (/^## (R\d|W1\.\d)/.test(lines[i])) break;
			bodyLines.push(lines[i]);
		}
		const body = bodyLines.join("\n");
		assert.ok(
			!R6_OVERLAP_REGEX.test(body),
			`${rn} non deve contenere contenuti relativi alla mitigazione pending-research di R6 (è gestita da R6)`,
		);
	}
});

test("IT runtime-fallbacks.it.md: sezioni R1-R5/R7 non assorbono la mitigazione R6 (pending-research)", async () => {
	const text = await readDoc(IT_DOC);
	const lines = text.split("\n");
	for (const rn of ["R1", "R2", "R3", "R4", "R5", "R7"]) {
		const headerLine = `## ${rn}`;
		const lineIdx = lines.findIndex((l) => l.trim() === headerLine);
		assert.ok(lineIdx !== -1, `header ## ${rn} deve esistere`);
		const bodyLines: string[] = [];
		for (let i = lineIdx + 1; i < lines.length; i++) {
			if (/^## (R\d|W1\.\d)/.test(lines[i])) break;
			bodyLines.push(lines[i]);
		}
		const body = bodyLines.join("\n");
		assert.ok(
			!R6_OVERLAP_REGEX.test(body),
			`${rn} non deve contenere contenuti relativi alla mitigazione pending-research di R6 (è gestita da R6)`,
		);
	}
});

// =============================================================================
// (5) Path dei file di test referenziati nelle sezioni R1-R5/R7 esistono
// su disco.
// =============================================================================

test("EN runtime-fallbacks.md cita path di file di test che esistono su disco nelle sezioni R1-R5/R7", async () => {
	const text = await readDoc(EN_DOC);
	const allPaths = new Set<string>();
	for (const suffix of [1, 2, 3, 4, 5, 7] as const) {
		const section = extractRSection(text, suffix);
		assert.ok(
			section !== null,
			`precondizione: ## R${suffix} presente in EN`,
		);
		const paths = section!.match(/tests\/[A-Za-z0-9._/-]+\.test\.ts/g) ?? [];
		paths.forEach((p) => allPaths.add(p));
	}
	assert.ok(
		allPaths.size > 0,
		"almeno un path di file di test referenziato nelle sezioni R1-R5/R7 EN",
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

test("IT runtime-fallbacks.it.md cita path di file di test che esistono su disco nelle sezioni R1-R5/R7", async () => {
	const text = await readDoc(IT_DOC);
	const allPaths = new Set<string>();
	for (const suffix of [1, 2, 3, 4, 5, 7] as const) {
		const section = extractRSection(text, suffix);
		assert.ok(
			section !== null,
			`precondizione: ## R${suffix} presente in IT`,
		);
		const paths = section!.match(/tests\/[A-Za-z0-9._/-]+\.test\.ts/g) ?? [];
		paths.forEach((p) => allPaths.add(p));
	}
	assert.ok(
		allPaths.size > 0,
		"almeno un path di file di test referenziato nelle sezioni R1-R5/R7 IT",
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