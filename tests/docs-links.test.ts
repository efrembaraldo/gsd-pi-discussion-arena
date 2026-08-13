/**
 * Test di enforcement della convenzione bilingue (M006/S01/T06).
 *
 * Contratto eseguibile (Integration Closure di S01): la convenzione
 * documentale "EN canonico + suffisso `.it.md` + link incrociati bilaterali"
 * non è un accordo verbale — questa suite fallisce quando una slice a valle
 * la viola:
 *
 *   - un link interno si rompe (qualsiasi file `.md` del corpus);
 *   - un documento del corpus perde la sua variante `.it.md` (o un
 *     `.it.md` perde la sua controparte EN);
 *   - una coppia perde il link incrociato bilaterale;
 *   - un documento linka l'archivio deliberativo (D069): il file è fuori
 *     dalla navigazione documentale, quindi il link-checker non lo vedrebbe
 *     come rotto (il file esiste localmente) e solo questa suite lo vieta;
 *   - il set minimo documentale (README pair + sei index delle tre sezioni
 *     docs/) sparisce: impedisce che il test passi per vacuità.
 *
 * Corpus documentale: la coppia README alla root più tutti i `.md` sotto
 * `docs/` (archivio escluso). Esempi, partecipanti e fixture NON sono
 * documentazione bilingue e non richiedono la variante `.it.md`.
 *
 * L'enforcement riusa il link-checker di produzione (`checkLinks` da
 * scripts/check-links.mjs) sia per il check "zero link rotti" sia per la
 * risoluzione dei target dei link (campo `resolved`, fragment già rimossi).
 *
 * Sensibilità: i casi negativi in fondo provano ogni dimensione
 * dell'enforcement su fixture temporanee in os.tmpdir (mai path gitignored
 * del repo): se l'enforcement diventasse vacuo, questi test falliscono.
 */

import { afterEach, before, test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { checkLinks } from "../scripts/check-links.mjs";

// ---------------------------------------------------------------------------
// Corpus documentale e definizione della convenzione
// ---------------------------------------------------------------------------

/** Root del repo (risolta rispetto a questo file, non al cwd). */
const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

/** File dell'archivio deliberativo: escluso dal corpus e mai linkato (D069). */
const ARCHIVE_BASENAME = "discussion-arena-deliberation-archive.md";

/** Set minimo documentale: il test fallisce se sparisce (niente pass vacuo). */
const REQUIRED_DOCS = [
	"README.md",
	"README.it.md",
	"docs/user-guide/index.md",
	"docs/user-guide/index.it.md",
	"docs/contributor-guide/index.md",
	"docs/contributor-guide/index.it.md",
	"docs/architecture/index.md",
	"docs/architecture/index.it.md",
];

/** Un file `.it.md` è la variante italiana; ogni altro `.md` è il canonico EN. */
function isItalianDoc(file: string): boolean {
	return file.endsWith(".it.md");
}

/**
 * Controparte bilingue di un documento: `X.md` ↔ `X.it.md`.
 * La coppia condivide directory e stem del nome.
 */
function siblingOf(file: string): string {
	const dir = path.dirname(file);
	const base = path.basename(file);
	const stem = isItalianDoc(file) ? base.slice(0, -".it.md".length) : base.slice(0, -".md".length);
	return path.join(dir, `${stem}${isItalianDoc(file) ? ".md" : ".it.md"}`);
}

/**
 * Enumera il corpus documentale sotto `root`: tutti i `.md` sotto `docs/`
 * (archivio deliberativo escluso) più la coppia README alla root.
 */
function collectDocs(root: string): string[] {
	const archiveAbs = path.join(root, "docs", ARCHIVE_BASENAME);
	const out: string[] = [];

	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
			} else if (entry.isFile() && entry.name.endsWith(".md") && full !== archiveAbs) {
				out.push(full);
			}
		}
	};

	const docsDir = path.join(root, "docs");
	if (fs.existsSync(docsDir)) walk(docsDir);
	for (const name of ["README.md", "README.it.md"]) {
		const p = path.join(root, name);
		if (fs.existsSync(p)) out.push(p);
	}
	return out.sort();
}

/** Path relativo a root per messaggi di errore leggibili. */
function relTo(root: string, file: string): string {
	return path.relative(root, file);
}

// ---------------------------------------------------------------------------
// Dimensioni dell'enforcement (helper condivisi tra corpus reale e fixture)
// ---------------------------------------------------------------------------

/** Documenti del corpus la cui controparte bilingue non esiste su disco. */
function missingSiblings(root: string, docs: string[]): string[] {
	const out: string[] = [];
	for (const doc of docs) {
		const sibling = siblingOf(doc);
		if (!fs.existsSync(sibling)) {
			out.push(`${relTo(root, doc)} manca della variante ${relTo(root, sibling)}`);
		}
	}
	return out.sort();
}

/**
 * Mappa file → set dei target locali risolti (path assoluti), ricavata dal
 * risultato del link-checker di produzione: `resolved` ha già il fragment
 * rimosso e il path normalizzato rispetto alla dir del file sorgente.
 */
function targetsByFile(linkResult: ReturnType<typeof checkLinks>): Map<string, Set<string>> {
	const map = new Map<string, Set<string>>();
	for (const link of linkResult.links) {
		if (link.kind !== "local" || link.resolved == null) continue;
		const set = map.get(link.file) ?? new Set<string>();
		set.add(link.resolved);
		map.set(link.file, set);
	}
	return map;
}

/**
 * Documenti che NON linkano la propria controparte bilingue: il link
 * incrociato bilaterale è assente anche in una sola direzione.
 */
function missingCrossLinks(
	root: string,
	docs: string[],
	linkResult: ReturnType<typeof checkLinks>,
): string[] {
	const targets = targetsByFile(linkResult);
	const out: string[] = [];
	for (const doc of docs) {
		const sibling = siblingOf(doc);
		const set = targets.get(doc) ?? new Set<string>();
		if (!set.has(sibling)) {
			out.push(`${relTo(root, doc)} non linka la sua variante ${relTo(root, sibling)}`);
		}
	}
	return out.sort();
}

/**
 * Riferimenti (file:riga) a link che risolvono verso l'archivio deliberativo.
 * Il file esiste localmente, quindi il link-checker da solo non lo vedrebbe
 * come rotto: è il contratto D069 a vietarlo esplicitamente.
 */
function archiveLinkers(root: string, linkResult: ReturnType<typeof checkLinks>): string[] {
	const archiveAbs = path.join(root, "docs", ARCHIVE_BASENAME);
	return linkResult.links
		.filter((link) => link.kind === "local" && link.resolved === archiveAbs)
		.map((link) => `${relTo(root, link.file)}:${link.line}`)
		.sort();
}

// ---------------------------------------------------------------------------
// Stato condiviso calcolato una sola volta sul corpus reale del repo
// ---------------------------------------------------------------------------

let realDocs: string[];
let realLinks: ReturnType<typeof checkLinks>;

before(() => {
	realDocs = collectDocs(REPO_ROOT);
	realLinks = checkLinks(REPO_ROOT);
});

// ---------------------------------------------------------------------------
// Enforcement sul corpus reale
// ---------------------------------------------------------------------------

test("enforcement: zero link locali rotti sull'intero corpus markdown del repo", () => {
	const detail = realLinks.broken.map((b) => `${relTo(REPO_ROOT, b.file)}:${b.line}: ${b.target}`).join("\n");
	assert.equal(
		realLinks.brokenCount,
		0,
		`link locali rotti (righe file:riga: target):\n${detail || "(nessuno)"}`,
	);
});

test("convenzione bilingue: ogni documento del corpus ha la sua variante .it.md (e viceversa)", () => {
	assert.deepEqual(
		missingSiblings(REPO_ROOT, realDocs),
		[],
		"ogni documento EN richiede la variante .it.md e ogni .it.md la controparte EN",
	);
});

test("convenzione bilingue: ogni coppia EN-IT ha il link incrociato bilaterale", () => {
	assert.deepEqual(
		missingCrossLinks(REPO_ROOT, realDocs, realLinks),
		[],
		"ogni documento deve linkare la propria controparte bilingue (e viceversa)",
	);
});

test("D069: nessun documento linka l'archivio deliberativo (fuori dalla navigazione)", () => {
	assert.deepEqual(
		archiveLinkers(REPO_ROOT, realLinks),
		[],
		"docs/discussion-arena-deliberation-archive.md è escluso dalla navigazione: nessun link deve risolverlo",
	);
});

test("guardia: il set minimo documentale (README pair + sei index) è presente", () => {
	const missing = REQUIRED_DOCS.filter((rel) => !fs.existsSync(path.join(REPO_ROOT, rel)));
	assert.deepEqual(missing, [], "documentazione minima mancante: il corpus si sarebbe ridotto senza che i test lo notassero");
});

// ---------------------------------------------------------------------------
// Casi negativi su fixture: l'enforcement è sensibile, non tautologico
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

/** Scrive un albero di file (rel -> contenuto) sotto root. */
async function writeTree(root: string, files: Record<string, string>): Promise<void> {
	for (const [rel, content] of Object.entries(files)) {
		const p = path.join(root, rel);
		await fsPromises.mkdir(path.dirname(p), { recursive: true });
		await fsPromises.writeFile(p, content, "utf8");
	}
}

test("negativo: un documento senza variante .it.md viene rilevato", async () => {
	const root = await makeTmp("docs-links-neg-sibling-");
	await writeTree(root, {
		"README.md": "# R\n\n[Italiano](README.it.md)\n",
		"README.it.md": "# R (IT)\n\n[English](README.md)\n",
		"docs/user-guide/index.md": "# User Guide\n\n[English](index.md)\n",
	});

	const docs = collectDocs(root);
	assert.deepEqual(missingSiblings(root, docs), ["docs/user-guide/index.md manca della variante docs/user-guide/index.it.md"]);
});

test("negativo: un link incrociato mancante in una sola direzione viene rilevato", async () => {
	const root = await makeTmp("docs-links-neg-cross-");
	await writeTree(root, {
		// README.md NON linka README.it.md (violazione); README.it.md sì.
		"README.md": "# R\n",
		"README.it.md": "# R (IT)\n\n[English](README.md)\n",
	});

	const docs = collectDocs(root);
	const result = checkLinks(root);
	assert.deepEqual(missingCrossLinks(root, docs, result), [
		"README.md non linka la sua variante README.it.md",
	]);
});

test("negativo: un link all'archivio deliberativo viene rilevato (D069)", async () => {
	const root = await makeTmp("docs-links-neg-archive-");
	await writeTree(root, {
		"README.md": "# R\n",
		"README.it.md": "# R (IT)\n",
		// L'archivio esiste (come nel repo reale): il link risolve, quindi il
		// link-checker da solo non lo vedrebbe — solo D069 lo vieta.
		"docs/discussion-arena-deliberation-archive.md": "# Archive stub\n",
		"docs/user-guide/index.md": "# U\n\n[archive](../discussion-arena-deliberation-archive.md)\n",
		"docs/user-guide/index.it.md": "# U (IT)\n",
	});

	const result = checkLinks(root);
	// Il link risolve davvero: brokenCount == 0, ma il contratto D069 lo flagga.
	assert.equal(result.brokenCount, 0);
	assert.deepEqual(archiveLinkers(root, result), ["docs/user-guide/index.md:3"]);
});

test("negativo: un link interno rotto viene rilevato dal link check del corpus", async () => {
	const root = await makeTmp("docs-links-neg-broken-");
	await writeTree(root, {
		"README.md": "# R\n\n[rotto](missing.md)\n",
		"README.it.md": "# R (IT)\n",
	});

	const result = checkLinks(root);
	assert.equal(result.brokenCount, 1);
	assert.equal(result.broken[0].target, "missing.md");
	assert.ok(result.broken[0].file.endsWith("README.md"));
});
