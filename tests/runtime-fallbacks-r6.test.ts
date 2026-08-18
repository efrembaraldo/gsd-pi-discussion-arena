/**
 * tests/runtime-fallbacks-r6.test.ts — T04/M011/S01.
 *
 * Guardia bilingue per il registro R6 in `docs/architecture/runtime-fallbacks.{md,it.md}`.
 *
 * Lo slice S01 ha popolato la sezione `## R6` con il rischio "race tra
 * `writePendingResearch` (callback `discussion_arena.execute`) e l'ingestion
 * `milestone_end` (lifecycle hook `attachPendingResearchLifecycleHooks`)" e la
 * mitigazione tramite lock file cross-process
 * `<cwd>/.gsd/discussion-arena/pending-research.lock` con claim POSIX
 * `O_CREAT|O_EXCL`.
 *
 * La guardia asserisce:
 *
 *   - EN/IT docs esistono e sono leggibili;
 *   - entrambi contengono una sezione `## R6` non vuota;
 *   - i campi obbligatori (Probability, Impact, Mitigation type,
 *     PR candidacy, Upstream issue) sono presenti in entrambi;
 *   - i termini tecnici canonici (nomi di file sorgente, nomi di simboli
 *     esportati, nomi dei file di test) compaiono in modo speculare;
 *   - il prefisso di log canonico `[discussion-arena]` è documentato in
 *     entrambi;
 *   - il flag `details.pendingResearchWritten` è documentato in entrambi.
 *
 * Se uno qualsiasi di questi assert fallisce, significa che il registro R6
 * è divergente tra EN e IT, oppure incompleto rispetto al contratto del
 * lock primitive, e la slice S01 non è chiusa correttamente.
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
 * Estrae il contenuto della sezione `## R6` (header incluso) dal testo del
 * file. Se l'header `## R6` manca, ritorna `null`. Se l'header esiste ma la
 * sezione è vuota fino al prossimo `## R` o EOF, ritorna la stringa fino
 * al boundary.
 */
function extractR6Section(text: string): string | null {
	const headerRe = /^## R6\s*$/m;
	const match = headerRe.exec(text);
	if (!match) return null;
	const start = match.index;
	// Prossimo header `## ` dopo R6: marca il boundary della sezione.
	// Deve essere un header di livello 2 che NON sia `## R6` stesso.
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
// Sezione `## R6` presente e non vuota.
// =============================================================================

test("EN runtime-fallbacks.md contiene una sezione ## R6 non vuota", async () => {
	const text = await readDoc(EN_DOC);
	const section = extractR6Section(text);
	assert.ok(section !== null, "header ## R6 deve essere presente");
	assert.ok(
		section !== null && section.trim().length > 50,
		"sezione ## R6 deve essere popolata (>50 caratteri di contenuto)",
	);
	// Anti-regressione: un header `## R6\n\n## R7` è la firma dello scheletro
	// vuoto iniziale. Se l'unico contenuto dopo `## R6` è whitespace, è vuota.
	assert.ok(
		section !== null && /## R6\s*\n[\s\S]+\S/.test(section),
		"## R6 deve avere almeno una riga di contenuto non-blank",
	);
});

test("IT runtime-fallbacks.it.md contiene una sezione ## R6 non vuota", async () => {
	const text = await readDoc(IT_DOC);
	const section = extractR6Section(text);
	assert.ok(section !== null, "header ## R6 deve essere presente");
	assert.ok(
		section !== null && section.trim().length > 50,
		"sezione ## R6 deve essere popolata (>50 caratteri di contenuto)",
	);
	assert.ok(
		section !== null && /## R6\s*\n[\s\S]+\S/.test(section),
		"## R6 deve avere almeno una riga di contenuto non-blank",
	);
});

// =============================================================================
// Campi obbligatori speculari EN ↔ IT.
// =============================================================================

const REQUIRED_FIELDS_EN = [
	"Probability",
	"Impact",
	"Mitigation type",
	"PR candidacy",
	"Upstream issue",
] as const;

const REQUIRED_FIELDS_IT = [
	"Probability",
	"Impact",
	"Mitigation type",
	"PR candidacy",
	"Upstream issue",
] as const;

test("EN runtime-fallbacks.md: tutti i campi obbligatori del registro R6 sono presenti", async () => {
	const text = await readDoc(EN_DOC);
	const section = extractR6Section(text);
	assert.ok(section !== null, "precondizione: ## R6 presente");
	for (const field of REQUIRED_FIELDS_EN) {
		assert.ok(
			section!.includes(field),
			`campo obbligatorio mancante: "${field}"`,
		);
	}
});

test("IT runtime-fallbacks.it.md: tutti i campi obbligatori del registro R6 sono presenti", async () => {
	const text = await readDoc(IT_DOC);
	const section = extractR6Section(text);
	assert.ok(section !== null, "precondizione: ## R6 presente");
	for (const field of REQUIRED_FIELDS_IT) {
		assert.ok(
			section!.includes(field),
			`campo obbligatorio mancante: "${field}"`,
		);
	}
});

// =============================================================================
// Simmetria EN ↔ IT sui termini tecnici condivisi.
// =============================================================================

/**
 * Identificatori canonici che DEVONO apparire in modo speculare in EN e IT
 * (sono nomi di simboli, percorsi di file, o token del protocollo: la lingua
 * della prosa non li traduce).
 */
const CANONICAL_TERMS = [
	// File sorgente della slice S01.
	"src/discussion-arena-pending-research.ts",
	"src/discussion-arena-ingestion.ts",
	"src/hooks-unit-aware.ts",
	// Primitive lock esportate (T02).
	"acquirePendingResearchLock",
	"releasePendingResearchLock",
	"withPendingResearchLock",
	"pendingResearchLockPath",
	"PendingResearchLockTimeoutError",
	"PENDING_RESEARCH_LOCK_FILENAME",
	// Lifecycle hook (T03).
	"attachPendingResearchLifecycleHooks",
	"getCurrentUnitType",
	"writePendingResearch",
	"details.pendingResearchWritten",
	// File di test referenziati.
	"tests/unit/pending-research-lock.test.ts",
	"tests/integration/s01-tool-call-site.test.ts",
	"tests/integration/s01-race-condition.test.ts",
	"tests/runtime-fallbacks-r6.test.ts",
	// Log prefisso canonico (T02 decisione D094).
	"[discussion-arena]",
	// File di lock su disco.
	"pending-research.lock",
] as const;

test("EN runtime-fallbacks.md cita ogni termine canonico della sezione R6", async () => {
	const text = await readDoc(EN_DOC);
	const section = extractR6Section(text);
	assert.ok(section !== null, "precondizione: ## R6 presente");
	for (const term of CANONICAL_TERMS) {
		assert.ok(
			section!.includes(term),
			`termine canonico mancante nella sezione R6 EN: "${term}"`,
		);
	}
});

test("IT runtime-fallbacks.it.md cita ogni termine canonico della sezione R6", async () => {
	const text = await readDoc(IT_DOC);
	const section = extractR6Section(text);
	assert.ok(section !== null, "precondizione: ## R6 presente");
	for (const term of CANONICAL_TERMS) {
		assert.ok(
			section!.includes(term),
			`termine canonico mancante nella sezione R6 IT: "${term}"`,
		);
	}
});

// =============================================================================
// Anti-regressione: nessuna sezione R è stata vuotata per sbaglio.
// =============================================================================

test("EN runtime-fallbacks.md: sezioni R1, R2, R3, R4, R5, R7 mantengono lo stato scheletro (placeholder onesto)", async () => {
	const text = await readDoc(EN_DOC);
	// Anti-regressione: lo stato "placeholder onesto" del pre-S01 era
	// header `## Rn` con body vuoto (solo whitespace fino al prossimo
	// header `## Rn+1`). Non assertiamo il body vuoto per R7 perché future
	// slice lo popoleranno; assertiamo invece che R1-R5 NON siano stati
	// sovrascritti da S01 (sono gestiti da milestone distinti).
	const lines = text.split("\n");
	for (const rn of ["R1", "R2", "R3", "R4", "R5", "R7"]) {
		const headerLine = `## ${rn}`;
		// String equality, no regex (evita ReDoS anche se rn è allowlist).
		const found = lines.some((l) => l.trim() === headerLine);
		assert.ok(found, `header ## ${rn} deve esistere`);
	}
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
			!/pending-research|discussion-arena|withPendingResearchLock/.test(body),
			`${rn} non deve contenere contenuti relativi alla mitigazione pending-research (è gestita da R6)`,
		);
	}
});

test("IT runtime-fallbacks.it.md: sezioni R1, R2, R3, R4, R5, R7 mantengono lo stato scheletro (placeholder onesto)", async () => {
	const text = await readDoc(IT_DOC);
	const lines = text.split("\n");
	for (const rn of ["R1", "R2", "R3", "R4", "R5", "R7"]) {
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
			!/pending-research|discussion-arena|withPendingResearchLock/.test(body),
			`${rn} non deve contenere contenuti relativi alla mitigazione pending-research (è gestita da R6)`,
		);
	}
});

// =============================================================================
// Anti-regressione: il registro R6 referenza esattamente i test path
// effettivamente presenti su disco (no link rotti alla documentazione).
// =============================================================================

test("EN runtime-fallbacks.md cita i path dei file di test che esistono su disco", async () => {
	const text = await readDoc(EN_DOC);
	const section = extractR6Section(text);
	assert.ok(section !== null, "precondizione: ## R6 presente");
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
	const section = extractR6Section(text);
	assert.ok(section !== null, "precondizione: ## R6 presente");
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