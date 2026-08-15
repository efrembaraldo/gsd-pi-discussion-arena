/**
 * Policy di scansione naming condivisa (M004/S04 T05 -> S05 T04).
 *
 * Estrae la policy della guardia di regressione naming da
 * tests/naming-residue.test.ts in un modulo riusabile: la allowlist e i
 * predicati vivono QUI (una sola fonte di verita), mentre il perimetro di
 * scansione e parametrizzabile dai consumatori.
 *
 * Criterio (esteso per override utente: il rename vale "ovunque", inclusi gli
 * identificatori di codice, non solo la prosa):
 * - Il token `ar\u0065na` (case-insensitive: ar\u0065na / Ar\u0065na / AR\u0065NA /
 *   ar\u0065naId / ar\u0065na_crashes_total / ar\u0065na.complete /
 *   gsd-ar\u0065na-* / ...) e ammesso solo se PRECEDUTO dal qualificatore
 *   canonico `discussion` (con separatore `-`, `_`, spazio, o concatenazione
 *   camelCase/PascalCase/UPPER_SNAKE): discussion-arena, discussion_arena,
 *   discussion arena, Discussion Arena, discussionArenaId,
 *   DiscussionArenaEvent, DISCUSSION_ARENA_MODES, ...
 * - Eccezioni documentate (identificatori fissati dal contratto slice, non
 *   formato legacy, ciascuna con un proprio pattern in ALLOWLIST):
 *   - il literal path legacy `.gsd/arena` nelle asserzioni di assenza della
 *     directory legacy (D054) in tests/event-log.test.ts;
 *   - `unitTypeToAr\u0065naGroup` da S01 (src/phase-mapping.ts): firma
 *     obbligatoria del mapping unitType -> gruppo discussion_arena.
 *
 * Perimetri disponibili:
 *  - `trackedSourceFiles()`: file tracciati da git (`git ls-files`);
 *  - `untrackedSourceFiles()`: file NON tracciati ma non ignorati
 *    (`git ls-files --others --exclude-standard`) — chiude la known
 *    limitation S04: i file appena creati da una slice (ancora untracked
 *    alla chiusura) rientrano nella scansione;
 *  - `allSourceFiles()`: unione deduplicata dei due (l'ordine di git non e
 *    garantito, quindi il risultato e ordinato per determinismo).
 *
 * Filtri comuni: estensione `.ts` / `.md` / `.json` e directory di stato del
 * framework GSD escluse (`.gsd/` e `.gsd-state/`): output interno del
 * sistema, non superficie sorgente del progetto, e contengono prosa legacy
 * non canonicalizzata. `git ls-files` esclude inoltre node_modules/ e i file
 * gitignored; `--exclude-standard` fa lo stesso per il perimetro untracked.
 *
 * Nota: il termine compare nel sorgente di questo modulo solo in forma
 * escapata (`\u0061`, `\u0065`) perche la guardia scansiona anche i file di
 * test — un literal contiguo qui sarebbe un residuo a pieno titolo.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

/** Radice del repository, derivata dal path reale di questo modulo. */
export const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
);

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

/** Allowlist unica e documentata. `pattern` e testato contro l'intera riga. */
export const ALLOWLIST: ReadonlyArray<{ pattern: RegExp; why: string }> = [
{
pattern: CANONICAL_PREFIX_RE,
why: "qualificatore canonico 'discussion' + token (prosa e identificatori: kebab, snake, spazio, camelCase, PascalCase, UPPER_SNAKE)",
},
{
pattern: LEGACY_PATH_RE,
why: "literal path legacy .gsd/arena: asserzione di assenza della directory legacy (D054), occorrenza intenzionale",
},
{
pattern: /unitTypeToAr\u0065naGroup/,
why: "firma obbligatoria di src/phase-mapping.ts (S01): mapping unitType -> gruppo, nome fissato dal contratto slice",
},
];

export interface Residue {
	file: string;
	line: number;
	text: string;
}

/** True se la riga contiene il token legacy fuori dalla allowlist. */
export function isResidueLine(text: string): boolean {
	if (!LEGACY_TOKEN_RE.test(text)) return false;
	return !ALLOWLIST.some(({ pattern }) => pattern.test(text));
}

/**
 * File tracciati (ts/md/json) fuori dalle directory di stato.
 * `git ls-files` non garantisce ordine semantico; il risultato e ordinato
 * per determinismo nei test.
 */
export function trackedSourceFiles(): string[] {
	return sourceFilesFromGit(["ls-files"]);
}

/**
 * File NON tracciati ma non ignorati (ts/md/json) fuori dalle directory di
 * stato: `git ls-files --others --exclude-standard`. Chiude la known
 * limitation S04 — i file appena creati da una slice sono untracked fino al
 * commit di chiusura e devono comunque passare sotto la scansione.
 */
export function untrackedSourceFiles(): string[] {
	return sourceFilesFromGit(["ls-files", "--others", "--exclude-standard"]);
}

/** Esegue `git ls-files` con gli argomenti dati e applica i filtri comuni. */
function sourceFilesFromGit(args: string[]): string[] {
	const out = execFileSync("git", args, {
		cwd: REPO_ROOT,
		encoding: "utf-8",
	});
	return out
		.split("\n")
		.map((rel) => rel.trim())
		.filter((rel) => rel.length > 0)
		.filter((rel) => SOURCE_EXT_RE.test(rel))
		.filter((rel) => !STATE_DIR_PREFIXES.some((prefix) => rel.startsWith(prefix)))
		.sort();
}

/**
 * Perimetro combinato: file tracciati E untracked non-ignorati, deduplicati
 * e ordinati. È la superficie su cui vale il criterio "zero residui" — un
 * file appena creato da una slice resta coperto indipendentemente dal suo
 * stato git al momento dell'esecuzione della guardia.
 */
export function allSourceFiles(): string[] {
	const seen = new Set<string>(trackedSourceFiles());
	const combined: string[] = [...seen];
	for (const rel of untrackedSourceFiles()) {
		if (!seen.has(rel)) {
			seen.add(rel);
			combined.push(rel);
		}
	}
	return combined.sort();
}

/** Righe non vuote di ogni file, con coordinate file:riga. */
export function allLines(
	files: string[],
): Array<{ file: string; line: number; text: string }> {
	const lines: Array<{ file: string; line: number; text: string }> = [];
	for (const rel of files) {
		const abs = path.join(REPO_ROOT, rel);
		if (!fs.existsSync(abs)) continue; // file tracciato cancellato localmente (rename/merge)
		const content = fs.readFileSync(abs, "utf-8");
		content.split(/\r?\n/).forEach((text, idx) => {
			if (text.trim().length > 0)
				lines.push({ file: rel, line: idx + 1, text });
		});
	}
	return lines;
}

/** Residui di naming trovati, ordinati per file:riga. */
export function scanResidues(files: string[]): Residue[] {
	const residues: Residue[] = [];
	for (const { file, line, text } of allLines(files)) {
		if (isResidueLine(text))
			residues.push({ file, line, text: text.trim() });
	}
	residues.sort((a, b) =>
		a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file),
	);
	return residues;
}
