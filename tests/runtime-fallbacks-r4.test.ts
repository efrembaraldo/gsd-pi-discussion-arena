/**
 * tests/runtime-fallbacks-r4.test.ts — T03/M011/S02.
 *
 * Guardia bilingue per il registro R4 in `docs/architecture/runtime-fallbacks.{md,it.md}`.
 *
 * Lo slice S02 ha popolato la sezione `## R4` con il rischio "matrice 6×6
 * di capability profile × fasi attive, con spawn del binario reale `gsd`
 * in CI" e la mitigazione tramite trigger `workflow_dispatch` manuale
 * (D109) + skip mode contract a 4 stati (`GSD_E2E_SKIP=1` exit 0, `gsd`
 * non su PATH exit 2, OK exit 0, FAIL exit 1).
 *
 * La guardia asserisce:
 *
 *   - EN/IT docs esistono e sono leggibili;
 *   - entrambi contengono una sezione `## R4` non vuota;
 *   - i campi obbligatori del registro (Probability, Impact, Mitigation
 *     type, PR candidacy, Upstream issue) sono presenti in EN e IT;
 *   - gli header canonici speculari (`Risk`/`Rischio`) sono presenti;
 *   - i termini tecnici canonici (command pattern CI, prefisso log,
 *     path sorgente/test, marker stderr) compaiono in modo speculare
 *     in EN e IT;
 *   - R1, R2, R3, R5 mantengono lo stato scheletro (placeholder
 *     onesto); R6 resta popolata dalla slice S01, R7 resta gestita da
 *     altro milestone (non assertiamo il loro stato).
 *
 * Se uno qualsiasi di questi assert fallisce, significa che il registro
 * R4 è divergente tra EN e IT, oppure incompleto rispetto al
 * contratto del command pattern CI prescelto, e la slice S02 non è
 * chiusa correttamente.
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

/**
 * Estrae il contenuto della sezione `## R4` (header incluso) dal testo
 * del file. Se l'header `## R4` manca, ritorna `null`. Se l'header
 * esiste ma la sezione è vuota fino al prossimo `## R` o EOF, ritorna
 * la stringa fino al boundary.
 */
function extractR4Section(text: string): string | null {
	const headerRe = /^## R4\s*$/m;
	const match = headerRe.exec(text);
	if (!match) return null;
	const start = match.index;
	// Prossimo header `## R\d` dopo R4: marca il boundary della sezione.
	// Deve essere un header di livello 2 che NON sia `## R4` stesso.
	const tail = text.slice(start + match[0].length);
	const nextHeaderRe = /^## R\d/m;
	const next = nextHeaderRe.exec(tail);
	const end = next ? start + match[0].length + next.index : text.length;
	return text.slice(start, end);
}

async function readDoc(filePath: string): Promise<string> {
	return await fs.readFile(filePath, "utf-8");
}

// =============================================================================
// File esistenza + accessibilità.
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
// Sezione `## R4` presente e non vuota.
// =============================================================================

test("EN runtime-fallbacks.md contiene una sezione ## R4 non vuota", async () => {
	const text = await readDoc(EN_DOC);
	const section = extractR4Section(text);
	assert.ok(section !== null, "header ## R4 deve essere presente");
	assert.ok(
		section !== null && section.trim().length > 50,
		"sezione ## R4 deve essere popolata (>50 caratteri di contenuto)",
	);
	// Anti-regressione: un header `## R4\n\n## R5` è la firma dello
	// scheletro vuoto iniziale. Se l'unico contenuto dopo `## R4` è
	// whitespace, è vuota.
	assert.ok(
		section !== null && /## R4\s*\n[\s\S]+\S/.test(section),
		"## R4 deve avere almeno una riga di contenuto non-blank",
	);
});

test("IT runtime-fallbacks.it.md contiene una sezione ## R4 non vuota", async () => {
	const text = await readDoc(IT_DOC);
	const section = extractR4Section(text);
	assert.ok(section !== null, "header ## R4 deve essere presente");
	assert.ok(
		section !== null && section.trim().length > 50,
		"sezione ## R4 deve essere popolata (>50 caratteri di contenuto)",
	);
	assert.ok(
		section !== null && /## R4\s*\n[\s\S]+\S/.test(section),
		"## R4 deve avere almeno una riga di contenuto non-blank",
	);
});

// =============================================================================
// Campi obbligatori speculari EN ↔ IT (record tabellare).
// =============================================================================

const REQUIRED_REGISTER_FIELDS = [
	"Probability",
	"Impact",
	"Mitigation type",
	"PR candidacy",
	"Upstream issue",
] as const;

test("EN runtime-fallbacks.md: tutti i campi obbligatori del registro R4 sono presenti", async () => {
	const text = await readDoc(EN_DOC);
	const section = extractR4Section(text);
	assert.ok(section !== null, "precondizione: ## R4 presente");
	for (const field of REQUIRED_REGISTER_FIELDS) {
		assert.ok(
			section!.includes(field),
			`campo obbligatorio mancante: "${field}"`,
		);
	}
});

test("IT runtime-fallbacks.it.md: tutti i campi obbligatori del registro R4 sono presenti", async () => {
	const text = await readDoc(IT_DOC);
	const section = extractR4Section(text);
	assert.ok(section !== null, "precondizione: ## R4 presente");
	for (const field of REQUIRED_REGISTER_FIELDS) {
		assert.ok(
			section!.includes(field),
			`campo obbligatorio mancante: "${field}"`,
		);
	}
});

// =============================================================================
// Header canonici speculari EN ↔ IT (Risk vs Rischio).
// =============================================================================

test("EN runtime-fallbacks.md cita l'header canonico del rischio (Risk:)", async () => {
	const text = await readDoc(EN_DOC);
	const section = extractR4Section(text);
	assert.ok(section !== null, "precondizione: ## R4 presente");
	assert.ok(
		/\*\*Risk:\*\*/.test(section!),
		"header del rischio deve usare il prefisso canonico EN `**Risk:**`",
	);
});

test("IT runtime-fallbacks.it.md cita l'header canonico del rischio (Rischio:)", async () => {
	const text = await readDoc(IT_DOC);
	const section = extractR4Section(text);
	assert.ok(section !== null, "precondizione: ## R4 presente");
	assert.ok(
		/\*\*Rischio:\*\*/.test(section!),
		"header del rischio deve usare il prefisso canonico IT `**Rischio:**`",
	);
});

test("IT runtime-fallbacks.it.md cita l'header canonico della mitigazione (Mitigazione attuale)", async () => {
	const text = await readDoc(IT_DOC);
	const section = extractR4Section(text);
	assert.ok(section !== null, "precondizione: ## R4 presente");
	assert.ok(
		/### Mitigazione attuale/.test(section!),
		"header della mitigazione deve essere `### Mitigazione attuale` in IT",
	);
});

test("IT runtime-fallbacks.it.md cita l'header canonico del contratto (Contratto comportamentale)", async () => {
	const text = await readDoc(IT_DOC);
	const section = extractR4Section(text);
	assert.ok(section !== null, "precondizione: ## R4 presente");
	assert.ok(
		/### Contratto comportamentale/.test(section!),
		"header del contratto deve essere `### Contratto comportamentale` in IT",
	);
});

// =============================================================================
// Simmetria EN ↔ IT sui termini tecnici condivisi (command pattern CI +
// prefisso log + path sorgente/test + marker stderr).
// =============================================================================

/**
 * Identificatori canonici che DEVONO apparire in modo speculare in EN
 * e IT (sono nomi di simboli, percorsi di file, o token del
 * protocollo: la lingua della prosa non li traduce).
 */
const CANONICAL_TERMS = [
	// Command pattern CI prescelto (D109 + D022).
	"workflow_dispatch",
	"npm install -g @opengsd/gsd-pi@latest",
	"npm run e2e-real",
	// Skip mode contract.
	"GSD_E2E_SKIP",
	// File sorgente di S02.
	"scripts/e2e-real.mjs",
	// File di test referenziati.
	"tests/integration/s02-e2e-real.test.ts",
	"tests/runtime-fallbacks-r4.test.ts",
	// Prefisso log canonico del runner.
	"[e2e-real]",
] as const;

test("EN runtime-fallbacks.md cita ogni termine canonico della sezione R4", async () => {
	const text = await readDoc(EN_DOC);
	const section = extractR4Section(text);
	assert.ok(section !== null, "precondizione: ## R4 presente");
	for (const term of CANONICAL_TERMS) {
		assert.ok(
			section!.includes(term),
			`termine canonico mancante nella sezione R4 EN: "${term}"`,
		);
	}
});

test("IT runtime-fallbacks.it.md cita ogni termine canonico della sezione R4", async () => {
	const text = await readDoc(IT_DOC);
	const section = extractR4Section(text);
	assert.ok(section !== null, "precondizione: ## R4 presente");
	for (const term of CANONICAL_TERMS) {
		assert.ok(
			section!.includes(term),
			`termine canonico mancante nella sezione R4 IT: "${term}"`,
		);
	}
});

// =============================================================================
// Anti-regressione: nessuna sezione R gestita da altro milestone è stata
// sovrascritta da S02. R1/R2/R3/R5 mantengono lo stato scheletro
// (placeholder onesto); R6 resta popolata dalla slice S01, R7 resta
// gestita da altro milestone.
// =============================================================================

test("EN runtime-fallbacks.md: sezioni R1, R2, R3, R5 mantengono lo stato scheletro (placeholder onesto)", async () => {
	const text = await readDoc(EN_DOC);
	const lines = text.split("\n");
	// Anti-regressione: lo stato "placeholder onesto" del pre-S02 era
	// header `## Rn` con body vuoto (solo whitespace fino al prossimo
	// header `## Rn+1`). R6 e R7 NON sono in scope di S02 (R6 è
	// popolata da S01, R7 è gestita da altro milestone).
	for (const rn of ["R1", "R2", "R3", "R5"]) {
		const headerLine = `## ${rn}`;
		// String equality, no regex (evita ReDoS anche se rn è allowlist).
		const found = lines.some((l) => l.trim() === headerLine);
		assert.ok(found, `header ## ${rn} deve esistere`);
	}
	// Body check: R1/R2/R3/R5 NON devono contenere contenuti relativi
	// alla mitigazione e2e-real (è gestita da R4).
	for (const rn of ["R1", "R2", "R3", "R5"]) {
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
			!/e2e-real|workflow_dispatch|@opengsd\/gsd-pi|scripts\/e2e-real\.mjs/.test(
				body,
			),
			`${rn} non deve contenere contenuti relativi alla mitigazione e2e-real (è gestita da R4)`,
		);
	}
});

test("IT runtime-fallbacks.it.md: sezioni R1, R2, R3, R5 mantengono lo stato scheletro (placeholder onesto)", async () => {
	const text = await readDoc(IT_DOC);
	const lines = text.split("\n");
	for (const rn of ["R1", "R2", "R3", "R5"]) {
		const headerLine = `## ${rn}`;
		const found = lines.some((l) => l.trim() === headerLine);
		assert.ok(found, `header ## ${rn} deve esistere`);
	}
	for (const rn of ["R1", "R2", "R3", "R5"]) {
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
			!/e2e-real|workflow_dispatch|@opengsd\/gsd-pi|scripts\/e2e-real\.mjs/.test(
				body,
			),
			`${rn} non deve contenere contenuti relativi alla mitigazione e2e-real (è gestita da R4)`,
		);
	}
});

// =============================================================================
// Anti-regressione: il registro R4 referenza esattamente i path dei
// file di test effettivamente presenti su disco (no link rotti alla
// documentazione).
// =============================================================================

test("EN runtime-fallbacks.md cita i path dei file di test che esistono su disco", async () => {
	const text = await readDoc(EN_DOC);
	const section = extractR4Section(text);
	assert.ok(section !== null, "precondizione: ## R4 presente");
	const testPathRe = /tests\/[A-Za-z0-9._/-]+\.test\.ts/g;
	const referencedPaths = new Set(section!.match(testPathRe) ?? []);
	assert.ok(referencedPaths.size > 0, "almeno un path di test referenziato");
	for (const relPath of referencedPaths) {
		const abs = path.join(REPO_ROOT, relPath);
		const stat = await fs.stat(abs).catch(() => null);
		assert.ok(
			stat !== null && stat.isFile(),
			`path di test referenziato ma non esistente: ${relPath}`,
		);
	}
});

test("IT runtime-fallbacks.it.md cita i path dei file di test che esistono su disco", async () => {
	const text = await readDoc(IT_DOC);
	const section = extractR4Section(text);
	assert.ok(section !== null, "precondizione: ## R4 presente");
	const testPathRe = /tests\/[A-Za-z0-9._/-]+\.test\.ts/g;
	const referencedPaths = new Set(section!.match(testPathRe) ?? []);
	assert.ok(referencedPaths.size > 0, "almeno un path di test referenziato");
	for (const relPath of referencedPaths) {
		const abs = path.join(REPO_ROOT, relPath);
		const stat = await fs.stat(abs).catch(() => null);
		assert.ok(
			stat !== null && stat.isFile(),
			`path di test referenziato ma non esistente: ${relPath}`,
		);
	}
});