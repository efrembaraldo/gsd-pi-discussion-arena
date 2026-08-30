/**
 * tests/release-pack.test.ts — Guardia di shape sul tarball npm (S04 / M015).
 *
 * Obiettivo: rendere eseguibile il contratto di packaging per cui
 * `npm pack --dry-run` elenca sia il modulo runtime hermes-readiness
 * (`src/hermes-readiness.ts`, D126) sia il fixture hermes che gli e2e
 * reali / i test di integrazione del runner hermes consumano
 * (`tests/fixtures/fake-hermes/hermes`, M015/S02/T02).
 *
 * Perche': un rilascio che omette `tests/fixtures/fake-hermes/**`
 * romperebbe `tests/e2e-real-hermes.test.ts` per chi installa la
 * extension dal registry npm e cerca di sostituire l'`hermes` reale
 * con il fake — il fake non sarebbe nel tarball, e l'e2e fallirebbe
 * per ENOENT invece che per divergenza di comportamento.
 *
 * Implementazione:
 *  - `spawnSync("npm", ["pack", "--dry-run"], { cwd: <root> })` — niente
 *    shell pipes/redirects/grep alternation (pre-execution gate blocca i
 *    pattern unsafe). `spawnSync` ritorna sia `stdout` che `stderr`
 *    come campi distinti del result, cosi' possiamo assertare senza shell
 *    magic. Il listing dei file del tarball va su stderr (prefisso
 *    `npm notice`), quindi e' essenziale ispezionare `result.stderr`,
 *    non solo `result.stdout`.
 *  - Il cwd e' calcolato da `import.meta.url` (`../`), stesso pattern di
 *    `tests/extension-manifest.test.ts`, NON `process.cwd()` (che dipende
 *    da dove `node --test` viene lanciato).
 *  - Le assertion sono *string contains*, non regex, per essere robusti a
 *    variazioni di formato di `npm pack` (es. `npm notice 3.7kB ...`).
 *
 * Sub-task S04/T04: questo test + l'aggiunta di `tests/fixtures/fake-hermes/**`
 * al field `files` di package.json chiudono il pre-release packaging check.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Path della root del progetto (risolto rispetto a questo file, non al cwd)
// ---------------------------------------------------------------------------

const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));

// ---------------------------------------------------------------------------
// Helper: esegue `npm pack --dry-run` e ritorna stdout+stderr concatenati.
// ---------------------------------------------------------------------------

function npmPackDryRun(): string {
	const result = spawnSync("npm", ["pack", "--dry-run"], {
		cwd: PROJECT_ROOT,
		encoding: "utf8",
		// maxBuffer alto: il listing dei file del tarball puo' superare i 64KB
		// default se la extension cresce (al momento siamo ~50KB ma la
		// guardia e' difensiva per il futuro).
		maxBuffer: 4 * 1024 * 1024,
	});
	assert.equal(
		result.status,
		0,
		`npm pack --dry-run deve uscire con status 0 (stderr: ${result.stderr ?? ""})`,
	);
	// npm pack --dry-run emette il listing su stderr (prefisso "npm notice"),
	// non stdout. Concateniamo entrambi per coprire qualsiasi routing futuro.
	return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

// ---------------------------------------------------------------------------
// Assertion: il tarball include il modulo hermes-readiness (src/hermes-readiness.ts)
// ---------------------------------------------------------------------------

test("npm pack: src/hermes-readiness.ts e' incluso nel tarball (D126)", () => {
	const output = npmPackDryRun();
	assert.ok(
		output.includes("src/hermes-readiness.ts"),
		`src/hermes-readiness.ts deve essere elencato in npm pack --dry-run.\n` +
			`Output:\n${output}`,
	);
});

// ---------------------------------------------------------------------------
// Assertion: il tarball include almeno un file dal fixture hermes
// (tests/fixtures/fake-hermes/hermes). Pattern piu' largo per coprire anche
// eventuali fixture aggiunti in futuro sotto tests/fixtures/fake-hermes/**.
// ---------------------------------------------------------------------------

test("npm pack: tests/fixtures/fake-hermes/** e' incluso nel tarball (M015/S02 fixture)", () => {
	const output = npmPackDryRun();
	// Cerca il prefisso "tests/fixtures/fake-hermes/" nel listing.
	// Pattern volutamente semplice (non regex) per evitare falsi negativi
	// se npm cambia il formato del notice.
	assert.ok(
		output.includes("tests/fixtures/fake-hermes/"),
		`almeno un file in tests/fixtures/fake-hermes/ deve essere elencato in npm pack --dry-run.\n` +
			`Output:\n${output}`,
	);
	// Guardia aggiuntiva: il binario fake-hermes (quello usato da
	// e2e-real-hermes.test.ts e dispatcher.test.ts) deve essere incluso.
	assert.ok(
		output.includes("tests/fixtures/fake-hermes/hermes"),
		`tests/fixtures/fake-hermes/hermes deve essere elencato in npm pack --dry-run.\n` +
			`Output:\n${output}`,
	);
});

// ---------------------------------------------------------------------------
// Assertion di shape: il listing di npm pack deve avere il prefisso "npm notice"
// per ogni entry — se npm dovesse cambiare formato, questo test fallisce
// prima ancora che le altre assertion di contains possano dare falsi positivi.
// ---------------------------------------------------------------------------

test("npm pack: l'output mantiene il prefisso 'npm notice' (anti-drift di formato)", () => {
	const output = npmPackDryRun();
	assert.ok(
		output.includes("npm notice"),
		`l'output di npm pack deve contenere 'npm notice' (formato stabile dalla v7).\n` +
			`Output:\n${output}`,
	);
});

// ---------------------------------------------------------------------------
// Assertion di consistenza: il tarball elenca >=10 file (sanity check che
// spawnSync non abbia catturato un output vuoto / troncato).
// ---------------------------------------------------------------------------

test("npm pack: l'output contiene almeno 10 file (sanity check su tarball consistente)", () => {
	const output = npmPackDryRun();
	const fileLines = output
		.split("\n")
		.filter((line) => line.startsWith("npm notice") && /\d/.test(line));
	assert.ok(
		fileLines.length >= 10,
		`npm pack deve elencare >=10 file nel tarball (attuale: ${fileLines.length}).\n` +
			`Output:\n${output}`,
	);
});

// ---------------------------------------------------------------------------
// Assertion di config: package.json `files` include `tests/fixtures/fake-hermes/**`.
// Garantisce che la modifica al package.json resti coerente con il listing
// del tarball (se qualcuno rimuove la riga, l'assertion di config fallisce
// prima ancora che npm pack venga rieseguito).
// ---------------------------------------------------------------------------

test("package.json files: include 'tests/fixtures/fake-hermes/**' (verifica config-side)", () => {
	const pkgJsonPath = path.join(PROJECT_ROOT, "package.json");
	const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as { files?: unknown };
	const files = pkg.files;
	assert.ok(Array.isArray(files), "package.json.files deve essere un array");
	assert.ok(
		(files as string[]).includes("tests/fixtures/fake-hermes/**"),
		`package.json.files deve includere 'tests/fixtures/fake-hermes/**' (attuale: ${JSON.stringify(files)})`,
	);
});
