/**
 * tests/integration/s02-e2e-real.test.ts — M011/S02/T02.
 *
 * Test di integrazione del runner `scripts/e2e-real.mjs` (M011). Dodici
 * `test()` cases esercitano i 4 helper pubblici + 2 path `runScenario`
 * (skip-mode + end-to-end con fake-gsd) + 2 sanity check trasversali
 * (matrice 6×6 + wiring CI yaml). Stack: `node:test` + `node:assert/strict`
 * — niente vitest/jest (D004 zero deps).
 *
 * Pattern riusato da `tests/integration/s01-tool-call-site.test.ts`:
 * - `import "../ts-esm-loader.mjs";` (self-sufficiency — i test girano
 *   anche con `node --test` diretto senza `--import ./tests/ts-esm-loader.mjs`).
 * - Workspace sempre `os.tmpdir()` (mai path di progetto), `mkdtemp`
 *   + cleanup in `finally` per evitare inquinamento tra test/runs.
 * - Subprocess isolato in un proprio tmpdir per evitare side-effect su
 *   lo stato della working directory della suite.
 *
 * Mapping test → helper pubblico di scripts/e2e-real.mjs:
 *  T1, T2 → findGsd
 *  T3, T4 → parseTierLine
 *  T5, T6 → envForScenario + buildSpawnEnv
 *  T7, T8 → formatSummaryLine + formatFailLine
 *  T9     → SCENARIO_MATRIX.length === 36 (6 profili × 6 fasi)
 *  T10    → runScenario skip-mode (fake-gsd-only, gsd mancante)
 *  T11    → runScenario end-to-end con tests/fixtures/fake-gsd/gsd
 *  T12    → .github/workflows/ci.yml contiene 'e2e-real:' + 'workflow_dispatch'
 */

import "../ts-esm-loader.mjs";
import * as assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
	findGsd,
	parseTierLine,
	envForScenario,
	buildSpawnEnv,
	formatSummaryLine,
	formatFailLine,
	runScenario,
	EXTENSION_ENTRY,
	REPO_ROOT,
} from "../../scripts/e2e-real.mjs";
// .js → .ts sibling remapping (vedi ts-hooks.mjs, sezione "Speciatori
// relativi `.js` rimappati a sibling `.ts`").
import { SCENARIO_MATRIX } from "../../src/runtime-profiles.js";

// Path assoluto al fake-gsd riusato nei test runScenario end-to-end.
// Risolto rispetto a `import.meta.url` per non dipendere dal `cwd`.
const FAKE_GSD = path.resolve(
	fileURLToPath(import.meta.url),
	"..",
	"..",
	"fixtures",
	"fake-gsd",
	"gsd",
);

/** Crea un tmpdir di lavoro e ne restituisce il path. */
async function createTmpDir(prefix: string): Promise<string> {
	return await fs.mkdtemp(path.join(os.tmpdir(), `s02-${prefix}-`));
}

// ---------------------------------------------------------------------------
// T1: findGsd → PATH senza un binario 'gsd' → null.
// ---------------------------------------------------------------------------

test("T1: findGsd con PATH='/tmp/no-such-dir-xyz:/tmp/abc' → null (nessun candidato presente)", () => {
	const result = findGsd("/tmp/no-such-dir-xyz:/tmp/abc");
	assert.equal(
		result,
		null,
		"findGsd deve ritornare null quando nessuna directory del PATH contiene 'gsd'",
	);
});

// ---------------------------------------------------------------------------
// T2: findGsd → PATH che include una dir con un fake-gsd → path assoluto.
// ---------------------------------------------------------------------------

test("T2: findGsd con PATH=<tmpdir>/has-gsd (con binario 'gsd' presente) → path assoluto del fake-gsd", async () => {
	const dir = await createTmpDir("findgsd");
	try {
		// Crea `<dir>/gsd` come file eseguibile marker.
		const fakePath = path.join(dir, "gsd");
		await fs.writeFile(
			fakePath,
			"#!/bin/sh\necho marker-only\n",
			{ mode: 0o755 },
		);
		const result = findGsd(dir);
		assert.equal(
			result,
			fakePath,
			"findGsd deve ritornare il path assoluto del primo 'gsd' presente nel PATH",
		);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// T3: parseTierLine → riga `[discussion-arena DEGRADED] reason: X — Y` →
//     { tier: 'D', reasons: [X] }. Copre l'em-dash italiano dopo `reason:`.
// ---------------------------------------------------------------------------

test("T3: parseTierLine con marker DEGRADED + reasons 'no_GSD_VERSION' → { tier: 'D', reasons: ['no_GSD_VERSION'] }", () => {
	const stderr =
		"[discussion-arena DEGRADED] reason: no_GSD_VERSION — fallback su availability-only\n";
	const result = parseTierLine(stderr);
	assert.deepEqual(result, {
		tier: "D",
		reasons: ["no_GSD_VERSION"],
	});
});

// ---------------------------------------------------------------------------
// T4: parseTierLine → stderr senza marker → null.
// ---------------------------------------------------------------------------

test("T4: parseTierLine con stderr senza marker DEGRADED → null", () => {
	const stderr = "qualcosa senza marker\naltre linee\n";
	const result = parseTierLine(stderr);
	assert.equal(
		result,
		null,
		"stderr senza '[discussion-arena DEGRADED]' deve ritornare null",
	);
});

// ---------------------------------------------------------------------------
// T5: envForScenario('no_GSD_VERSION', 'planning') → env contiene
//     GSD_VERSION: null esplicito (firma del profilo degraded availability-only).
// ---------------------------------------------------------------------------

test("T5: envForScenario('no_GSD_VERSION', 'planning') → env con GSD_VERSION: null incluso", () => {
	const result = envForScenario("no_GSD_VERSION", "planning");
	assert.deepEqual(result, {
		GSD_E2E_PROFILE: "no_GSD_VERSION",
		GSD_E2E_PHASE: "planning",
		GSD_PROJECT_ID: "ce19056a2702",
		GSD_VERSION: null,
	});
});

// ---------------------------------------------------------------------------
// T6: buildSpawnEnv(value=null) → la chiave è RIMOSSA dall'env risultante
//     (override esplicito del profilo degraded). Toglie GSD_VERSION dal
//     process.env di partenza solo per la durata del test.
// ---------------------------------------------------------------------------

test("T6: buildSpawnEnv({ GSD_VERSION: null, GSD_FOO: 'bar' }) con process.env.GSD_VERSION preimpostato → env senza GSD_VERSION ma con GSD_FOO='bar'", () => {
	const prev = process.env.GSD_VERSION;
	process.env.GSD_VERSION = "1.2.3-test";
	try {
		const env = buildSpawnEnv({
			GSD_VERSION: null,
			GSD_FOO: "bar",
		});
		assert.equal(
			"GSD_VERSION" in env,
			false,
			"GSD_VERSION deve essere rimosso dall'env (override null esplicito)",
		);
		assert.equal(
			env.GSD_FOO,
			"bar",
			"GSD_FOO deve attraversare il filtro inalterato",
		);
	} finally {
		if (prev === undefined) {
			delete process.env.GSD_VERSION;
		} else {
			process.env.GSD_VERSION = prev;
		}
	}
});

// ---------------------------------------------------------------------------
// T7: formatSummaryLine → contract grep-friendly. La riga è consumata da
//     `grep` nella CI e dai parser di log; il formato è parte del contract
//     (D109 + slice verification "stderr summary lines").
// ---------------------------------------------------------------------------

test("T7: formatSummaryLine('full', 'planning', 'F', [], 0) → '[e2e-real] full/planning: tier=F reasons=[] exit=0'", () => {
	const result = formatSummaryLine("full", "planning", "F", [], 0);
	assert.equal(
		result,
		"[e2e-real] full/planning: tier=F reasons=[] exit=0",
		"contract grep-friendly della summary line: '[e2e-real] <profile>/<phase>: tier=<F|A|D> reasons=[...] exit=<0|1>'",
	);
});

// ---------------------------------------------------------------------------
// T8: formatFailLine → include 'FAIL scenario=<profile>/<phase>' + triple
//     expected/got/reasons. Failure-mode visibility (slice verification).
// ---------------------------------------------------------------------------

test("T8: formatFailLine('full', 'planning', 'F', 'D', ['no_GSD_VERSION']) → include 'FAIL scenario=full/planning' + expected=F + got=D", () => {
	const result = formatFailLine("full", "planning", "F", "D", [
		"no_GSD_VERSION",
	]);
	assert.match(
		result,
		/FAIL scenario=full\/planning/,
		"header 'FAIL scenario=...' deve essere presente",
	);
	assert.match(
		result,
		/expected=F/,
		"campo 'expected=F' deve essere presente",
	);
	assert.match(
		result,
		/got=D/,
		"campo 'got=D' deve essere presente",
	);
	assert.match(
		result,
		/reasons=\[no_GSD_VERSION\]/,
		"campo 'reasons=[no_GSD_VERSION]' deve essere presente",
	);
});

// ---------------------------------------------------------------------------
// T9: SCENARIO_MATRIX.length === 36 = 6 capability profiles × 6 fasi arena.
//     Verifica statica del prodotto cartesiano (invariante di fase).
// ---------------------------------------------------------------------------

test("T9: SCENARIO_MATRIX length === 36 (= 6 profili × 6 fasi arena)", () => {
	assert.equal(
		SCENARIO_MATRIX.length,
		36,
		"la matrice scenario deve essere 6 capability profiles × 6 fasi = 36 celle",
	);
});

// ---------------------------------------------------------------------------
// T10: runScenario skip-mode. Una cella `fake-gsd-only` ritorna
//      { skipped: true, exitCode: 0 } anche con un gsdPath inesistente —
//      il branch `scope === 'fake-gsd-only'` cortocircuita lo spawn.
// ---------------------------------------------------------------------------

test("T10: runScenario(cella fake-gsd-only, gsdPath='/nonexistent/gsd') → { skipped: true, exitCode: 0 } (scope skip, nessuno spawn)", () => {
	const fakeGsdOnlyCell = SCENARIO_MATRIX.find(
		(c) => c.scope === "fake-gsd-only",
	);
	assert.ok(
		fakeGsdOnlyCell,
		"matrice deve contenere almeno una cella fake-gsd-only (skip mode)",
	);
	// T10 e T11 restano sync: runScenario è sync, mkdtempSync/rmSync mantengono
	// il test in modalità sincrona (niente await necessario). Stessa forma
	// di T11 per simmetria con il contratto del runner.
	const tmpRoot = fsSync.mkdtempSync(path.join(os.tmpdir(), "s02-runsync-"));
	try {
		const result = runScenario(fakeGsdOnlyCell, {
			gsdPath: "/nonexistent/gsd",
			tmpdirRoot: tmpRoot,
		});
		assert.equal(
			result.skipped,
			true,
			"cella fake-gsd-only deve cortocircuitare con skipped=true",
		);
		assert.equal(
			result.exitCode,
			0,
			"skip mode ritorna exitCode=0 (motivo dello skip = 'gsd non richiesto')",
		);
	} finally {
		fsSync.rmSync(tmpRoot, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// T11: runScenario end-to-end con fake-gsd. Una cella `e2e-real-testable`
//      (full × planning) spawna effettivamente il fake-gsd (binario Node
//      che non emette marker DEGRADED). runScenario deduce `observedTier=F`,
//      match con `expectedTier=F` (full) → exit 0, summary non-vuoto.
// ---------------------------------------------------------------------------

test("T11: runScenario(cella full × planning, gsdPath=fake-gsd) → non skip, summary non-vuota, spawn reale del fake-gsd andato a buon fine", () => {
	const cell = SCENARIO_MATRIX.find(
		(c) => c.profile === "full" && c.phase === "planning",
	);
	assert.ok(cell, "cella full × planning deve esistere nella matrice");

	// Verifica che il fake-gsd esista ed sia eseguibile; lo chmod è
	// difensivo contro un clone senza bit +x preservato.
	assert.ok(
		fsSync.existsSync(FAKE_GSD),
		`fake-gsd mancante sul path: ${FAKE_GSD}`,
	);
	fsSync.chmodSync(FAKE_GSD, 0o755);

	const tmpRoot = fsSync.mkdtempSync(path.join(os.tmpdir(), "s02-runfull-"));
	try {
		const result = runScenario(cell, {
			gsdPath: FAKE_GSD,
			tmpdirRoot: tmpRoot,
			entryPath: EXTENSION_ENTRY,
		});
		assert.equal(
			result.skipped,
			false,
			"cella full × planning NON è fake-gsd-only (skip mode non scatta)",
		);
		assert.ok(
			typeof result.summary === "string" && result.summary.length > 0,
			"summary non deve essere vuota dopo spawn del fake-gsd",
		);
		assert.match(
			result.summary,
			/^\[e2e-real\] full\/planning:/,
			"summary deve seguire il formato canonico '[e2e-real] full/planning: ...'",
		);
	} finally {
		fsSync.rmSync(tmpRoot, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// T12: Sanity check del wiring CI prodotto da T01 (cross-check fra slice
//      tasks). Conferma che il commit T01 abbia introdotto il job e
//      il trigger `workflow_dispatch` richiesti da D109.
// ---------------------------------------------------------------------------

test("T12: .github/workflows/ci.yml contiene 'e2e-real:' E 'workflow_dispatch'", async () => {
	const ciPath = path.join(REPO_ROOT, ".github", "workflows", "ci.yml");
	const ciYaml = await fs.readFile(ciPath, "utf-8");
	assert.match(
		ciYaml,
		/e2e-real:/,
		"job 'e2e-real:' deve essere presente nel workflow CI",
	);
	assert.match(
		ciYaml,
		/workflow_dispatch/,
		"trigger 'workflow_dispatch' deve essere presente (D109 + guardia D022)",
	);
});
