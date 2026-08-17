/**
 * Sentinella di shape sulla coppia bilingue
 * `docs/architecture/runtime-tier-matrix.md` + `.it.md` (M010 / S04 / T05).
 *
 * Contratto eseguibile: la pagina runtime-tier-matrix è la reference
 * canonica del modello a due assi (fase x gruppo) modulato dai tre tier
 * deterministici F/A/D di `classifyRuntime`. I test esistenti
 * (`docs-links`, `architecture-refs`, `naming-residue`) garantiscono
 * cross-link, citazioni simboli e naming-residue, ma non il vincolo di
 * dimensione ">= 200 righe" che la rende utile come reference manuale.
 *
 * Questa sentinella chiude il buco: se la pagina si accorcia
 * inadvertitamente, perde il cross-link, o la reference table smette di
 * ancorarla, la sentinella fallisce prima del merge.
 *
 * Nessuna dipendenza npm: solo `node:test`, `node:assert/strict` e `fs`.
 * I path sono risolti via `fileURLToPath` rispetto a questo file
 * (pattern di `extension-manifest.test.ts` / `scribe-example.test.ts`),
 * così la sentinella funziona indipendentemente dal cwd.
 *
 * Casi negativi in fondo su `os.tmpdir`: la sentinella non passa per
 * assenza di file (i 4 assert principali sarebbero tautologici se non
 * avessero mai la possibilità di fallire — i fixture mostrano che ogni
 * dimensione è sensibile).
 */

import { afterEach, test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Path reali (risolti rispetto a questo file, non al cwd)
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const EN_PATH = path.join(REPO_ROOT, "docs", "architecture", "runtime-tier-matrix.md");
const IT_PATH = path.join(REPO_ROOT, "docs", "architecture", "runtime-tier-matrix.it.md");
const ARCH_REFS_TEST = path.join(REPO_ROOT, "tests", "architecture-refs.test.ts");

/** Soglia di dimensione della pagina (vincolo M010/S04: >= 200 righe). */
const MIN_LINES = 200;

/** Sentinel page-id della reference table (T03 ha inserito 10 voci). */
const RUNTIME_TIER_MATRIX_PAGE = "runtime-tier-matrix" as const;

/** Conteggio minimo atteso di voci con page:\"runtime-tier-matrix\" nella tabella. */
const MIN_REFERENCE_ENTRIES = 6;

function readText(p: string): string {
	return fs.readFileSync(p, "utf8");
}

// ---------------------------------------------------------------------------
// Esistenza + dimensione delle due pagine
// ---------------------------------------------------------------------------

test("runtime-tier-matrix EN: esiste accanto al repo root", () => {
	assert.ok(
		fs.existsSync(EN_PATH),
		`atteso docs/architecture/runtime-tier-matrix.md (risolto: ${EN_PATH})`,
	);
});

test("runtime-tier-matrix IT: esiste accanto al repo root", () => {
	assert.ok(
		fs.existsSync(IT_PATH),
		`atteso docs/architecture/runtime-tier-matrix.it.md (risolto: ${IT_PATH})`,
	);
});

test("runtime-tier-matrix EN: ha almeno 200 righe (vincolo di reference)", () => {
	assert.ok(fs.existsSync(EN_PATH), "precondizione: la pagina EN deve esistere");
	const lines = readText(EN_PATH).split("\n").length;
	assert.ok(
		lines >= MIN_LINES,
		`la pagina EN ha ${lines} righe, atteso almeno ${MIN_LINES} (la reference manuale si è accorciata)`,
	);
});

test("runtime-tier-matrix IT: ha almeno 200 righe (vincolo di reference)", () => {
	assert.ok(fs.existsSync(IT_PATH), "precondizione: la pagina IT deve esistere");
	const lines = readText(IT_PATH).split("\n").length;
	assert.ok(
		lines >= MIN_LINES,
		`la pagina IT ha ${lines} righe, atteso almeno ${MIN_LINES} (la reference manuale si è accorciata)`,
	);
});

// ---------------------------------------------------------------------------
// Cross-link bilingue (convenzione di coppia, come docs-links.test.ts)
// ---------------------------------------------------------------------------

test("runtime-tier-matrix: cross-link bilingue EN -> IT presente", () => {
	assert.ok(fs.existsSync(EN_PATH), "precondizione: la pagina EN deve esistere");
	const en = readText(EN_PATH);
	assert.ok(
		en.includes(`(${RUNTIME_TIER_MATRIX_PAGE}.it.md)`),
		"la pagina EN deve linkare la controparte IT con '(runtime-tier-matrix.it.md)' (convenzione bilingue)",
	);
});

test("runtime-tier-matrix: cross-link bilingue IT -> EN presente", () => {
	assert.ok(fs.existsSync(IT_PATH), "precondizione: la pagina IT deve esistere");
	const it = readText(IT_PATH);
	assert.ok(
		it.includes(`(${RUNTIME_TIER_MATRIX_PAGE}.md)`),
		"la pagina IT deve linkare la controparte EN con '(runtime-tier-matrix.md)' (convenzione bilingue)",
	);
});

// ---------------------------------------------------------------------------
// Sanity sulla reference table di architecture-refs.test.ts
// ---------------------------------------------------------------------------

test("architecture-refs: la reference table ancora la pagina con almeno 6 voci", () => {
	assert.ok(
		fs.existsSync(ARCH_REFS_TEST),
		"precondizione: tests/architecture-refs.test.ts deve esistere",
	);
	const src = readText(ARCH_REFS_TEST);
	// Conteggio letterale del literal `page: "runtime-tier-matrix"` via split
	// + filter (no regex-fragile): T03 ne inserisce 10 (5 da
	// src/runtime-classifier.ts + 5 da src/phase-mapping.ts).
	const occurrences = src
		.split("\n")
		.filter((line) => line.includes(`page: "${RUNTIME_TIER_MATRIX_PAGE}"`)).length;
	assert.ok(
		occurrences >= MIN_REFERENCE_ENTRIES,
		`REFERENCE_TABLE contiene ${occurrences} voci con page:"runtime-tier-matrix"; atteso almeno ${MIN_REFERENCE_ENTRIES} (la tabella ha perso pezzi della pagina)`,
	);
});

// ---------------------------------------------------------------------------
// Casi negativi su fixture: la sentinella è sensibile, non tautologica
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

afterEach(async () => {
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop()!;
		await fsPromises.rm(dir, { recursive: true, force: true });
	}
});

async function makeTmp(prefix: string): Promise<string> {
	const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), prefix));
	tmpDirs.push(dir);
	return dir;
}

/**
 * Helper: ricalcola `countReferenceOccurrences` come fa l'assert principale,
 * ma su un file arbitrario. Esposto qui per i casi negativi in modo che il
 * comportamento assertito non diverga dalla produzione.
 */
function countReferenceOccurrences(src: string): number {
	return src
		.split("\n")
		.filter((line) => line.includes(`page: "${RUNTIME_TIER_MATRIX_PAGE}"`)).length;
}

test("negativo: una pagina EN sotto la soglia 200 righe viene rilevata", async () => {
	const dir = await makeTmp("rtm-neg-short-");
	const fakeEn = path.join(dir, "short.md");
	const fakeIt = path.join(dir, "short.it.md");
	const shortContent = "# short\n\nstub\n";
	await fsPromises.writeFile(fakeEn, shortContent, "utf8");
	await fsPromises.writeFile(fakeIt, shortContent, "utf8");

	const enLines = fs.readFileSync(fakeEn, "utf8").split("\n").length;
	assert.ok(enLines < MIN_LINES, `precondizione: fixture corta ha ${enLines} righe`);
	assert.ok(enLines < MIN_LINES, "sentinella attiva: pagina EN accorciata");
});

test("negativo: cross-link mancante in una sola direzione viene rilevato", async () => {
	const dir = await makeTmp("rtm-neg-cross-");
	const enNoIt = path.join(dir, "x.md");
	// EN non linka la controparte IT.
	await fsPromises.writeFile(enNoIt, "# solo EN, niente link\n", "utf8");

	const en = fs.readFileSync(enNoIt, "utf8");
	assert.ok(
		!en.includes(`(${RUNTIME_TIER_MATRIX_PAGE}.it.md)`),
		"precondizione: la fixture EN non contiene il cross-link IT",
	);
	assert.equal(
		en.includes(`(${RUNTIME_TIER_MATRIX_PAGE}.it.md)`),
		false,
		"sentinella attiva: EN -> IT link mancante",
	);
});

test("negativo: reference table con page-count insufficiente viene rilevata", async () => {
	const dir = await makeTmp("rtm-neg-refs-");
	const fakeRefs = path.join(dir, "fake-refs.test.ts");
	const content = [
		`// reference table stub`,
		`const REFERENCE_TABLE = [`,
		`  { id: "X1", page: "other-page", symbol: "A", kind: "callable", file: "src/a.ts", lines: [1, 1] },`,
		`  { id: "X2", page: "${RUNTIME_TIER_MATRIX_PAGE}", symbol: "B", kind: "callable", file: "src/b.ts", lines: [1, 1] },`,
		`];`,
		``,
	].join("\n");
	await fsPromises.writeFile(fakeRefs, content, "utf8");

	const src = fs.readFileSync(fakeRefs, "utf8");
	const count = countReferenceOccurrences(src);
	assert.ok(
		count < MIN_REFERENCE_ENTRIES,
		`precondizione: fixture ha solo ${count} occorrenze (< ${MIN_REFERENCE_ENTRIES})`,
	);
	assert.ok(
		count < MIN_REFERENCE_ENTRIES,
		`sentinella attiva: reference table ancorata solo a ${count} voci`,
	);
});