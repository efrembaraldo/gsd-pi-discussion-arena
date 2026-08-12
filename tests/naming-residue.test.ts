/**
 * Guardia di regressione naming (M004/S04/T05).
 *
 * Rende eseguibile il criterio di accettazione della slice — "nessun residuo
 * del termine legacy nei file tracciati `*.ts` / `*.md` / `*.json`" — che in
 * precedenza era affidato a una pipeline di grep manuale non eseguibile come
 * verifica di task (pipe vietate) e soggetta a falsi positivi.
 *
 * Criterio (esteso per override utente: il rename vale "ovunque", inclusi gli
 * identificatori di codice, non solo la prosa):
 * - Il token `ar\u0065na` (case-insensitive: ar\u0065na / Ar\u0065na / AR\u0065NA / ar\u0065naId /
 *   ar\u0065na_crashes_total / ar\u0065na.complete / gsd-ar\u0065na-* / ...) è ammesso solo
 *   se PRECEDUTO dal qualificatore canonico `discussion` (con separatore
 *   `-`, `_`, spazio, o concatenazione camelCase/PascalCase/UPPER_SNAKE):
 *   discussion-arena, discussion_arena, discussion arena, Discussion Arena,
 *   discussionArenaId, DiscussionArenaEvent, DISCUSSION_ARENA_MODES, ...
 * - Unica eccezione non-canonicizzata: il literal path legacy `.gsd/arena`
 *   nelle asserzioni di assenza della directory legacy (D054) in
 *   tests/event-log.test.ts — occorrenza intenzionale e necessaria.
 *
 * Policy di scansione (documentata in un unico posto, qui):
 * - Perimetro: file tracciati da git (`git ls-files`) con estensione
 *   `.ts` / `.md` / `.json`, ESCLUSE le directory di stato del framework GSD
 *   (`.gsd/` e `.gsd-state/`): sono output interno del sistema, non superficie
 *   sorgente del progetto, e contengono prosa legacy non canonicalizzata.
 *   `git ls-files` esclude inoltre node_modules/ e i file gitignored.
 * - Coerenza con la demo della slice (`rg` rispetta .gitignore): il perimetro
 *   qui è un superset deterministico indipendente dalla config globale.
 *
 * Nota: il termine compare nel sorgente di questo file solo in forma escapata
 * (`\u0061`, `\u0065`) perché la guardia scansiona anche sé stessa — un
 * literal contiguo qui sarebbe un residuo a pieno titolo.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

/** Radice del repository, derivata dal path reale di questo file. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SOURCE_EXT_RE = /\.(ts|md|json)$/;

/**
 * Directory di stato del framework GSD: output interno, non superficie
 * sorgente del progetto (vedi doc header).
 */
const STATE_DIR_PREFIXES = [".gsd/", ".gsd-state/"];

/**
 * Token legacy, case-insensitive, SENZA word boundary: cattura prosa e
 * identificatori (ar\u0065naId, Ar\u0065naEvent, ar\u0065na_crashes_total,
 * STOP-BEFORE-AR\u0065NA, ...). Escapato per evitare il self-match.
 */
const LEGACY_TOKEN_RE = /ar\u0065na/i;

/**
 * Forme canoniche: `discussion` + separatore opzionale (-, _, spazio, o
 * concatenazione camelCase) + token. Copre discussion-arena, discussion_arena,
 * discussion arena, Discussion Arena, discussionArenaId, DiscussionArenaEvent,
 * DISCUSSION_ARENA_MODES, runDiscussionArena, gsd-discussion-arena-*, ...
 */
const CANONICAL_PREFIX_RE = /discussion[-_\s]?ar\u0065na/i;

/**
 * Literal path legacy dell'event log (D054): asserzioni semantiche di assenza
 * della directory legacy in tests/event-log.test.ts (forme `path.join` e
 * prosa del messaggio). Intenzionale: il path legacy va nominato per poter
 * asserire che non esiste.
 */
const LEGACY_PATH_RE = /\.gsd\/ar\u0065na|\.gsd", "ar\u0065na"/i;

/** Allowlist unica e documentata. `pattern` è testato contro l'intera riga. */
const ALLOWLIST: ReadonlyArray<{ pattern: RegExp; why: string }> = [
	{
		pattern: CANONICAL_PREFIX_RE,
		why: "qualificatore canonico 'discussion' + token (prosa e identificatori: kebab, snake, spazio, camelCase, PascalCase, UPPER_SNAKE)",
	},
	{
		pattern: LEGACY_PATH_RE,
		why: "literal path legacy .gsd/arena: asserzione di assenza della directory legacy (D054), occorrenza intenzionale",
	},
];

interface Residue {
	file: string;
	line: number;
	text: string;
}

/** True se la riga contiene il token legacy fuori dalla allowlist. */
function isResidueLine(text: string): boolean {
	if (!LEGACY_TOKEN_RE.test(text)) return false;
	return !ALLOWLIST.some(({ pattern }) => pattern.test(text));
}

/** File tracciati (ts/md/json) fuori dalle directory di stato. */
function trackedSourceFiles(): string[] {
	const out = execFileSync("git", ["ls-files"], {
		cwd: REPO_ROOT,
		encoding: "utf-8",
	});
	return out
		.split("\n")
		.filter((rel) => rel.length > 0)
		.filter((rel) => SOURCE_EXT_RE.test(rel))
		.filter((rel) => !STATE_DIR_PREFIXES.some((prefix) => rel.startsWith(prefix)));
}

/** Righe non vuote di ogni file, con coordinate file:riga. */
function allLines(files: string[]): Array<{ file: string; line: number; text: string }> {
	const lines: Array<{ file: string; line: number; text: string }> = [];
	for (const rel of files) {
		const abs = path.join(REPO_ROOT, rel);
		if (!fs.existsSync(abs)) continue; // file tracciato cancellato localmente (rename/merge)
		const content = fs.readFileSync(abs, "utf-8");
		content.split(/\r?\n/).forEach((text, idx) => {
			if (text.trim().length > 0) lines.push({ file: rel, line: idx + 1, text });
		});
	}
	return lines;
}

/** Residui di naming trovati, ordinati per file:riga. */
function scanResidues(files: string[]): Residue[] {
	const residues: Residue[] = [];
	for (const { file, line, text } of allLines(files)) {
		if (isResidueLine(text)) residues.push({ file, line, text: text.trim() });
	}
	residues.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));
	return residues;
}

test("la policy di scansione copre la superficie sorgente attesa", () => {
	const files = trackedSourceFiles();
	assert.ok(files.length >= 40, `set troppo piccolo (${files.length}): la policy è rotta?`);
	for (const expected of ["index.ts", "README.md", "replay.ts", "tests/event-log.test.ts"]) {
		assert.ok(files.includes(expected), `file atteso mancante dal set: ${expected}`);
	}
	for (const excluded of [".gsd/", ".gsd-state/"]) {
		assert.ok(
			files.every((rel) => !rel.startsWith(excluded)),
			`directory di stato non esclusa: ${excluded}`,
		);
	}
});

test("nessun residuo del token legacy nei file tracciati (ts/md/json)", () => {
	const files = trackedSourceFiles();
	const residues = scanResidues(files);
	const detail = residues
		.map((r) => `${r.file}:${r.line}: ${r.text}`)
		.join("\n");
	assert.deepEqual(
		residues,
		[],
		`residui di naming fuori allowlist (${residues.length}):\n${detail}`,
	);
});

test("ogni pattern allowlist è necessario (matcha almeno una riga reale)", () => {
	const selfFile = path.basename(import.meta.url).replace(/\.m?js$/, ".ts");
	const files = trackedSourceFiles().filter((rel) => rel !== `tests/${selfFile}`);
	const lines = allLines(files).map((l) => l.text);
	for (const { pattern, why } of ALLOWLIST) {
		assert.ok(
			lines.some((text) => pattern.test(text)),
			`pattern allowlist morto (nessuna occorrenza reale) — rimuoverlo: ${why}`,
		);
	}
});

test("la guardia rileva un residuo introdotto (auto-controllo)", () => {
	// "una ar\u0065na di prova" a runtime; nel sorgente il termine è escapato.
	const probe = "una " + "ar\u0065na" + " di prova";
	assert.ok(isResidueLine(probe), "la riga-probe deve essere classificata come residuo");
	// Identificatore legacy: "ar\u0065naId" a runtime.
	assert.ok(isResidueLine("ar\u0065naId"), "identificatore legacy deve essere residuo");
	// Evento protocollo legacy: "ar\u0065na.complete" a runtime.
	assert.ok(
		isResidueLine("ar\u0065na.complete"),
		"evento protocollo legacy deve essere residuo (D055 superato dall'override)",
	);
	// Forme canoniche: mai residuo.
	assert.ok(
		!isResidueLine("discussionAr\u0065naId"),
		"identificatore canonico camelCase non deve essere residuo",
	);
	assert.ok(
		!isResidueLine("la discussion ar\u0065na è obbligatoria"),
		"prosa canonica con spazio non deve essere residuo",
	);
	assert.ok(
		!isResidueLine("DiscussionAr\u0065naEvent"),
		"tipo canonico PascalCase non deve essere residuo",
	);
	assert.ok(
		!isResidueLine('path.join(cwd, ".gsd", "ar\u0065na")'),
		"path legacy in forma path.join non deve essere residuo (D054)",
	);
});
