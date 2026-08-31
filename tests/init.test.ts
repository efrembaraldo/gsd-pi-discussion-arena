/**
 * Test unit del command `/discussion-arena-init` (S03/M017, T03).
 *
 * Copre i 4 scenari di success criterion comportamentale di S03:
 *   1. tmpdir vuota → root + 3 subdir create, 0 skip, 0 errori; verifica
 *      filesystem con i 3 `.gitkeep` placeholder;
 *   2. tmpdir già inizializzata (2ª invocazione) → 0 created, 4 skipped;
 *      idempotente per contratto;
 *   3. cwd con `participants/analyst.md` preesistente (file utente) → la
 *      subdir `participants/` NON viene toccata, il file utente resta
 *      byte-identico; root + le 2 subdir mancanti vengono create;
 *   4. wrapper `runInitCli` side-effect → scrive su stderr con il prefisso
 *      canonico `[discussion-arena-init]` via logger iniettabile (NO mock
 *      di `process.stderr`), ritorna `InitResult` con `created`/`skipped`
 *      corretti.
 *
 * Tutte le fixture sono sintetiche su tmpdir effimera (pattern
 * participants-override.test.ts). I test usano `node:test` + `node:assert/strict`
 * con il loader ESM (`node --import ./tests/ts-esm-loader.mjs`), come tutto
 * il resto della suite.
 *
 * Zero dipendenze npm aggiunte: riusa `runInit` + `runInitCli` da `src/init.ts`
 * (T01) e `DISCUSSION_ARENA_COORDINATION_DIR` da
 * `src/discussion-arena-coordination.ts` (riuso speculare di S02).
 */

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { runInit, runInitCli } from "../src/init.js";
import { DISCUSSION_ARENA_COORDINATION_DIR } from "../src/discussion-arena-coordination.js";

const activeFixtures: string[] = [];
function track(root: string): void {
	activeFixtures.push(root);
}

afterEach(() => {
	for (const root of activeFixtures.splice(0)) {
		try {
			fs.rmSync(root, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	}
});

/** Subdir canoniche (riuso speculare di `src/init.ts:INIT_SUBDIRS`). */
const EXPECTED_SUBDIRS = [
	"participants",
	"participants-overrides",
	"transcripts",
] as const;

// ─── Test 1: root + 3 subdir create, 3 .gitkeep presenti ──────────────────

test("runInit: tmpdir vuota -> 4 created (root + 3 subdir), 0 skip, 0 errori, 3 .gitkeep presenti", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-discussion-arena-init-fresh-"));
	track(cwd);

	const result = runInit(cwd);
	assert.deepEqual(result.errors, [], "nessun errore");
	assert.equal(result.created.length, 4, "root + 3 subdir");
	assert.equal(result.skipped.length, 0, "tmpdir vuota: nulla da skippare");

	const root = path.join(cwd, DISCUSSION_ARENA_COORDINATION_DIR);
	assert.ok(fs.existsSync(root), "root .gsd/discussion-arena/ esiste");
	assert.ok(
		result.created.some((p) => p === root),
		"root presente in created",
	);

	// Verifica filesystem: 3 subdir con relativo .gitkeep.
	for (const sub of EXPECTED_SUBDIRS) {
		const subPath = path.join(root, sub);
		assert.ok(fs.existsSync(subPath), `subdir ${sub} esiste`);
		assert.ok(
			fs.existsSync(path.join(subPath, ".gitkeep")),
			`.gitkeep presente in ${sub}`,
		);
		assert.ok(
			fs.statSync(path.join(subPath, ".gitkeep")).isFile(),
			`.gitkeep in ${sub} è un file (non directory)`,
		);
	}
});

// ─── Test 2: idempotente (2ª invocazione) ─────────────────────────────────

test("runInit: tmpdir gia inizializzata -> 0 created, 4 skipped, idempotente", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-discussion-arena-init-twice-"));
	track(cwd);

	const first = runInit(cwd);
	assert.equal(first.created.length, 4, "prima invocazione: 4 created");
	assert.equal(first.errors.length, 0);

	const second = runInit(cwd);
	assert.equal(second.created.length, 0, "seconda invocazione: 0 created");
	assert.equal(second.skipped.length, 4, "seconda invocazione: 4 skipped");
	assert.equal(second.errors.length, 0, "nessun errore");

	// Il filesystem resta intatto: root + 3 subdir + 3 .gitkeep ancora lì.
	const root = path.join(cwd, DISCUSSION_ARENA_COORDINATION_DIR);
	for (const sub of EXPECTED_SUBDIRS) {
		const subPath = path.join(root, sub);
		assert.ok(fs.existsSync(subPath), `subdir ${sub} ancora presente`);
		assert.ok(
			fs.existsSync(path.join(subPath, ".gitkeep")),
			`.gitkeep in ${sub} ancora presente (NON duplicato)`,
		);
	}
});

// ─── Test 3: file utente preesistente NON viene toccato ───────────────────

test("runInit: cwd con participants/analyst.md preesistente -> participants/ NON toccata, file utente byte-identico", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-discussion-arena-init-user-"));
	track(cwd);

	// File utente preesistente in participants/. Stabiliamo un contenuto
	// distintivo per verificare l'integrità byte-per-byte dopo l'init.
	const root = path.join(cwd, DISCUSSION_ARENA_COORDINATION_DIR);
	const participantsDir = path.join(root, "participants");
	fs.mkdirSync(participantsDir, { recursive: true });
	const analystPath = path.join(participantsDir, "analyst.md");
	const userContent =
		"---\nname: analyst\nrole: Custom Analyst\ndescription: file utente preesistente\n---\n\nSystem prompt utente.\n";
	fs.writeFileSync(analystPath, userContent, "utf-8");

	const result = runInit(cwd);
	assert.equal(result.errors.length, 0);

	// Root esistente (perche' participants/ e' sua figlia) -> skipped.
	assert.ok(
		result.skipped.includes(root),
		"root preesistente in skipped (NON ricreata)",
	);
	// participants/ preesistente -> skipped, NON toccata, .gitkeep NON scritto.
	assert.ok(
		result.skipped.includes(participantsDir),
		"participants/ preesistente in skipped",
	);
	assert.ok(
		!fs.existsSync(path.join(participantsDir, ".gitkeep")),
		"NESSUN .gitkeep scritto in participants/ con file utente presente (non-distruttivo)",
	);

	// Le 2 subdir mancanti vengono create. Il root NON viene creato (gia'
	// presente come parent di participants/); participants/ NON viene creata
	// (gia' presente con file utente). Quindi: 2 created, 2 skipped.
	assert.equal(
		result.created.length,
		2,
		"root skipped + participants/ skipped + 2 subdir mancanti = 2 created",
	);
	assert.equal(
		result.skipped.length,
		2,
		"root + participants/ preesistenti = 2 skipped",
	);
	const overridesDir = path.join(root, "participants-overrides");
	const transcriptsDir = path.join(root, "transcripts");
	assert.ok(result.created.includes(overridesDir), "participants-overrides creata");
	assert.ok(result.created.includes(transcriptsDir), "transcripts creata");
	assert.ok(fs.existsSync(overridesDir), "participants-overrides esiste su fs");
	assert.ok(fs.existsSync(transcriptsDir), "transcripts esiste su fs");

	// Integrity check: il file utente e' ancora byte-identico al contenuto
	// originale. Confronto binario (no encoding roundtrip) per catturare
	// qualsiasi alterazione, incluse scritture accidentali di .gitkeep.
	const after = fs.readFileSync(analystPath);
	const before = Buffer.from(userContent, "utf-8");
	assert.ok(
		after.equals(before),
		"participants/analyst.md byte-identico: NON toccato da runInit",
	);
});

// ─── Test 4: runInitCli side-effect via logger iniettabile ────────────────

test("runInitCli: scrive su stderr con prefisso [discussion-arena-init] via logger, ritorna InitResult", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-discussion-arena-init-cli-"));
	track(cwd);

	// Cattura stderr senza mockare process.stderr.write direttamente:
	// runInitCli accetta un logger iniettabile (D020 — i mock vivono nei
	// test). Verifichiamo pero' che la CLI di default scriva davvero su
	// stderr con il prefisso canonico tramite captureStderr minimale.
	const lines: string[] = [];
	const original = process.stderr.write.bind(process.stderr);
	process.stderr.write = ((chunk: unknown) => {
		lines.push(String(chunk));
		return true;
	}) as unknown as typeof process.stderr.write;

	try {
		const result = runInitCli(cwd);

		assert.equal(result.errors.length, 0, "nessun errore");
		assert.equal(result.created.length, 4, "root + 3 subdir");
		assert.equal(result.skipped.length, 0);
		assert.deepEqual(result.errors, []);

		// Verifica prefisso canonico [discussion-arena-init] (D053 speculare):
		// 1 riga per il root + 3 per le subdir = 4 linee totali.
		const cliLines = lines.filter((l) => l.startsWith("[discussion-arena-init] "));
		assert.equal(
			cliLines.length,
			4,
			"1 riga per il root + 3 per le subdir, tutte con prefisso canonico",
		);
		for (const line of cliLines) {
			assert.match(
				line,
				/^\[discussion-arena-init\] created .+\n$/,
				"riga nel formato canonico: '[discussion-arena-init] created <path>\\n'",
			);
		}
	} finally {
		process.stderr.write = original;
	}
});

// ─── Test 4b: logger iniettabile di runInit (per documentare l'opzione) ───

test("runInit: opts.logger riceve un evento 'created <path>' per ogni path creato", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-discussion-arena-init-logger-"));
	track(cwd);

	const events: string[] = [];
	const result = runInit(cwd, {
		logger: (msg) => {
			events.push(msg);
		},
	});

	assert.equal(result.created.length, 4);
	assert.equal(events.length, 4, "logger invocato una volta per created");
	for (const evt of events) {
		assert.match(
			evt,
			/^created /,
			"ogni evento inizia con 'created ' (nessun prefisso qui: il wrapper CLI aggiunge [discussion-arena-init])",
		);
	}
});

// ─── Test 4c: re-init su dir gia esistente -> logger salta i preesistenti ─

test("runInit: 2ª invocazione su cwd inizializzata -> logger non emette nulla (skipped non viene loggato)", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-discussion-arena-init-silent-"));
	track(cwd);

	// Prima invocazione: svuota il buffer.
	runInit(cwd);
	const events: string[] = [];
	const second = runInit(cwd, {
		logger: (msg) => {
			events.push(msg);
		},
	});

	assert.equal(second.created.length, 0);
	assert.equal(second.skipped.length, 4);
	assert.equal(events.length, 0, "skipped non viene loggato: 0 eventi");
});
