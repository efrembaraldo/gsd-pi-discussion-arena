/**
 * Guardia di regressione naming (M004/S04/T05 -> S05/T04).
 *
 * Rende eseguibile il criterio di accettazione della slice — "nessun residuo
 * del termine legacy nei file `*.ts` / `*.md` / `*.json`" — che in precedenza
 * era affidato a una pipeline di grep manuale non eseguibile come verifica di
 * task (pipe vietate) e soggetta a falsi positivi.
 *
 * La POLICY (token, allowlist, predicati, perimetri) è estratta in
 * `tests/fixtures/naming-scan.ts`: una sola fonte di verità, riusata da
 * questa guardia e dallo Scenario 3 di accettazione (S05/T04).
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
 * Perimetro (con estensione S05/T04, known limitation S04 chiusa): file
 * tracciati da git (`git ls-files`) E file untracked non-ignorati
 * (`git ls-files --others --exclude-standard`) — i file appena creati da una
 * slice sono untracked fino al commit di chiusura e devono comunque passare
 * sotto la scansione. Estensione `.ts` / `.md` / `.json`, ESCLUSE le
 * directory di stato del framework GSD (`.gsd/` e `.gsd-state/`): sono
 * output interno del sistema, non superficie sorgente del progetto, e
 * contengono prosa legacy non canonicalizzata. `git ls-files` esclude inoltre
 * node_modules/ e i file gitignored; `--exclude-standard` fa lo stesso per il
 * perimetro untracked.
 *
 * Nota: il termine compare nel sorgente di questo file solo in forma escapata
 * (`\u0061`, `\u0065`) perché la guardia scansiona anche sé stessa — un
 * literal contiguo qui sarebbe un residuo a pieno titolo.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as path from "node:path";
import {
	ALLOWLIST,
	isResidueLine,
	trackedSourceFiles,
	untrackedSourceFiles,
	allSourceFiles,
	allLines,
	scanResidues,
} from "./fixtures/naming-scan.js";

test("la policy di scansione copre la superficie sorgente attesa", () => {
	const files = allSourceFiles();
	assert.ok(
		files.length >= 40,
		`set troppo piccolo (${files.length}): la policy è rotta?`,
	);
	for (const expected of [
		"index.ts",
		"README.md",
		"replay.ts",
		"tests/event-log.test.ts",
		"tests/fixtures/naming-scan.ts",
		"tests/acceptance-scenario-3.test.ts",
	]) {
		assert.ok(files.includes(expected), `file atteso mancante dal set: ${expected}`);
	}
	for (const excluded of [".gsd/", ".gsd-state/"]) {
		assert.ok(
			files.every((rel) => !rel.startsWith(excluded)),
			`directory di stato non esclusa: ${excluded}`,
		);
	}
});

test("il perimetro combinato è ben formato: no duplicati, tracked e untracked disgiunti", () => {
	const tracked = trackedSourceFiles();
	const untracked = untrackedSourceFiles();
	const combined = allSourceFiles();

	assert.equal(
		new Set(combined).size,
		combined.length,
		"allSourceFiles() non deve contenere duplicati",
	);
	assert.ok(
		untracked.every((rel) => !tracked.includes(rel)),
		"un file non può essere contemporaneamente tracked e untracked",
	);
	assert.ok(
		combined.length >= tracked.length,
		"il perimetro combinato è un superset dei file tracciati",
	);
});

test("nessun residuo del token legacy nel perimetro combinato (tracked E untracked non-ignorati)", () => {
	const files = allSourceFiles();
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
	const files = allSourceFiles().filter(
		(rel) =>
			rel !== `tests/${selfFile}` &&
			rel !== "tests/fixtures/naming-scan.ts",
	);
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
