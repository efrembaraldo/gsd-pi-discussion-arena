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
 *
 * Guardie S08 (MEM401/MEM403, release 0.10.1 riparativa):
 *  - il difetto packaging di 0.10.0: l'array `files` escludeva i 5 moduli
 *    importati da `index.ts` (branch.ts, decision.ts, scribe-synthesis.ts,
 *    viewer.ts, status.ts, aggiunti come import dal 2026-09-02), quindi
 *    l'import dal pacchetto installato falliva con ERR_MODULE_NOT_FOUND
 *    branch.js (falsificato da S07/T04). Opzione A (D165): allowlist
 *    esplicita, MAI glob `*.ts` top-level.
 *  - guardie additive S08 (i 5 test M015 sopra restano intatti, D084):
 *    (a) config-side: package.json#files include i 5 moduli +
 *        scripts/copy-template.mjs + examples/discussion-arena-coordination.example.md;
 *    (b) sweep strutturale REALE: `npm pack` (spawnSync, tarball in dir
 *        temporanea, estrazione via `tar` — MAI shell pipes, D133), poi per
 *        ogni file `.ts` spedito ogni specifier `from "./x.js"` /
 *        `import("./x.js")` deve risolvere a `x.ts` presente nel tarball
 *        estratto;
 *    (c) assert che `scripts/copy-template.mjs` sia elencato in
 *        `npm pack --dry-run` (il postinstall deve funzionare dal pacchetto).
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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

// ===========================================================================
// Guardie S08 (MEM401/MEM403, release 0.10.1 riparativa) — additive, i 5
// test M015 sopra restano intatti (D084).
// ===========================================================================

// ---------------------------------------------------------------------------
// (a) Config-side: package.json#files include i 5 moduli importati da index.ts
//     + scripts/copy-template.mjs + examples/discussion-arena-coordination.example.md
//     (Opzione A / D165: voci esplicite, MAI glob *.ts top-level).
//     Se qualcuno rimuove una voce, questo assert fallisce prima ancora di
//     pagare il costo di un npm pack reale.
// ---------------------------------------------------------------------------

const S08_REQUIRED_FILES: readonly string[] = [
	"branch.ts",
	"decision.ts",
	"scribe-synthesis.ts",
	"viewer.ts",
	"status.ts",
	"scripts/copy-template.mjs",
	"examples/discussion-arena-coordination.example.md",
];

test("package.json files (S08/MEM401): include i 5 moduli importati da index.ts + copy-template.mjs + example (Opzione A / D165)", () => {
	const pkg = JSON.parse(
		readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8"),
	) as { files?: unknown };
	const files = pkg.files;
	assert.ok(Array.isArray(files), "package.json.files deve essere un array");
	for (const entry of S08_REQUIRED_FILES) {
		assert.ok(
			(files as string[]).includes(entry),
			`package.json.files deve includere '${entry}' (attuale: ${JSON.stringify(files)})`,
		);
	}
});

// ---------------------------------------------------------------------------
// (b) Sweep strutturale REALE (MEM403): npm pack (spawnSync, tarball in dir
//     temporanea) -> estrazione via tar -> per ogni file `.ts` spedito, ogni
//     specifier `from "./x.js"` / `import("./x.js")` deve risolvere a `x.ts`
//     presente nel tarball estratto. I 5 specifier di index.ts verso
//     branch/decision/scribe-synthesis/viewer/status sono esattamente quelli
//     che in 0.10.0 fallivano (ERR_MODULE_NOT_FOUND, MEM401).
// ---------------------------------------------------------------------------

function npmPackReal(packDestination: string): string {
	const result = spawnSync(
		"npm",
		["pack", "--pack-destination", packDestination],
		{
			cwd: PROJECT_ROOT,
			encoding: "utf8",
			maxBuffer: 4 * 1024 * 1024,
		},
	);
	assert.equal(
		result.status,
		0,
		`npm pack deve uscire con status 0 (stderr: ${result.stderr ?? ""})`,
	);
	// npm pack stampa il path del tarball RELATIVO AL CWD del processo (con
	// --pack-destination esterna puo' stampare il solo nome base), quindi NON
	// parsare il path stampato: nella destination (mkdtemp fresco) il tarball
	// e' l'unico file .tgz presente — lo individuiamo via readdir.
	const lines = (result.stdout ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
	assert.ok(
		lines.some((l) => l.endsWith(".tgz")),
		`npm pack deve stampare il path del tarball .tgz (stdout: ${result.stdout ?? ""})`,
	);
	const tarballs = readdirSync(packDestination).filter((f) => f.endsWith(".tgz"));
	assert.equal(
		tarballs.length,
		1,
		`nella pack destination deve esserci esattamente un tarball .tgz (trovati: ${JSON.stringify(tarballs)})`,
	);
	return path.join(packDestination, tarballs[0]);
}

function collectTsFiles(dir: string): string[] {
	const collected: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const entryPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			collected.push(...collectTsFiles(entryPath));
		} else if (entry.name.endsWith(".ts")) {
			collected.push(entryPath);
		}
	}
	return collected;
}

test("npm pack reale (S08/MEM403): sweep strutturale — ogni specifier './x.js' risolve a un '.ts' nel tarball estratto", () => {
	const tmpDir = mkdtempSync(path.join(tmpdir(), "release-pack-s08-"));
	try {
		const tarballPath = npmPackReal(tmpDir);
		assert.ok(existsSync(tarballPath), `il tarball deve esistere: ${tarballPath}`);

		const extractDir = path.join(tmpDir, "extracted");
		mkdirSync(extractDir);
		// Estrazione via tar invocato con spawnSync (MAI shell pipe/redirect, D133).
		const tar = spawnSync("tar", ["-xzf", tarballPath, "-C", extractDir], {
			encoding: "utf8",
			maxBuffer: 4 * 1024 * 1024,
		});
		assert.equal(
			tar.status,
			0,
			`tar -xzf deve uscire con status 0 (stderr: ${tar.stderr ?? ""})`,
		);

		// npm pack chiama il tarball <name>-<version>.tgz e la root della
		// estrazione e' sempre package/ (convenzione npm).
		const pkgDir = path.join(extractDir, "package");
		assert.ok(
			existsSync(pkgDir),
			`la root dell'estrazione deve esistere: ${pkgDir} (contenuto: ${readdirSync(extractDir).join(", ")})`,
		);

		const shippedTs = collectTsFiles(pkgDir);
		assert.ok(
			shippedTs.length >= 30,
			`il tarball deve contenere >=30 file .ts (attuali: ${shippedTs.length})`,
		);

		// Guardia MEM401: i 5 moduli importati da index.ts devono essere presenti
		// nel tarball estratto (in 0.10.0 mancavano).
		for (const mod of ["branch", "decision", "scribe-synthesis", "viewer", "status"]) {
			assert.ok(
				shippedTs.some((f) => path.basename(f) === `${mod}.ts`),
				`${mod}.ts deve essere presente nel tarball estratto (difetto packaging 0.10.0, MEM401)`,
			);
		}

		// Sweep: ogni specifier relativo './x.js' / '../x.js' in un .ts spedito
		// deve risolvere a x.ts presente nel tarball. I test/ NON sono spediti,
		// quindi non producono falsi positivi.
		const specifierRe = /(?:from\s*|import\()\s*["'](\.[^"']*?\.js)["']/g;
		let totalSpecifiers = 0;
		const unresolved: string[] = [];
		for (const tsFile of shippedTs) {
			const content = readFileSync(tsFile, "utf8");
			for (const match of content.matchAll(specifierRe)) {
				totalSpecifiers += 1;
				const specifier = match[1];
				const resolved = path.resolve(path.dirname(tsFile), specifier);
				const candidateTs = `${resolved.slice(0, -".js".length)}.ts`;
				if (!existsSync(candidateTs)) {
					unresolved.push(
						`${path.relative(pkgDir, tsFile)} -> "${specifier}" (atteso: ${path.relative(pkgDir, candidateTs)})`,
					);
				}
			}
		}
		assert.ok(
			totalSpecifiers >= 40,
			`attesi >=40 specifier ./.js nel tarball (attuali: ${totalSpecifiers}) — il sweep non deve girare a vuoto`,
		);
		assert.deepEqual(
			unresolved,
			[],
			`tutti gli specifier ./x.js nel tarball devono risolvere a un .ts presente (unresolved: ${JSON.stringify(unresolved, null, 2)})`,
		);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// (c) scripts/copy-template.mjs deve essere elencato in npm pack --dry-run:
//     il postinstall `node scripts/copy-template.mjs` deve funzionare
//     end-to-end dal pacchetto installato (Opzione A / D165).
// ---------------------------------------------------------------------------

test("npm pack --dry-run (S08): elenca scripts/copy-template.mjs (postinstall end-to-end)", () => {
	const output = npmPackDryRun();
	assert.ok(
		output.includes("scripts/copy-template.mjs"),
		`scripts/copy-template.mjs deve essere elencato in npm pack --dry-run.\n` +
			`Output:\n${output}`,
	);
});
