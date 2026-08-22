/**
 * tests/_helpers/snapshot.test.ts — Unit test del helper snapshot riusabile
 * (M011/S03/T01). 7 test che coprono il contratto del helper uno-per-uno:
 *
 *   1. canonicalize: ordina top-level keys lexicograficamente
 *   2. canonicalize: ordina keys ricorsivamente su oggetti nested
 *   3. canonicalize: preserva ordine elementi di array (non riordina)
 *   4. assertSnapshot: PASS silente quando canonical(value) === canonical(baseline)
 *   5. assertSnapshot: FAIL con diff body quando canonical(value) !== canonical(baseline)
 *   6. assertSnapshot: throw 'snapshot missing' quando file assente e UPDATE_SNAPSHOTS non è '1'
 *   7. assertSnapshot: scrive file quando UPDATE_SNAPSHOTS=1 (anche senza baseline preesistente)
 *
 * Self-sufficiency: il file registra i hook ESM (rimappatura `.js` -> `.ts`
 * + stub `@gsd/pi-coding-agent`) anche quando gira sotto `node --test` senza
 * il flag `--import ./tests/ts-esm-loader.mjs` che normalmente aggiunge
 * `npm test`. Pattern già adottato dai sibling in `tests/integration/`
 * (es. pending-research-roundtrip.test.ts:30, wizard-roundtrip.test.ts:30,
 * research-ingestion.test.ts:41).
 *
 * I test che scrivono file in `tests/__snapshots__/` usano un prefisso
 * dedicato `__helper-test-` (NON `manifest-snapshot`, che è il baseline
 * reale di S03/T02) e fanno cleanup in `afterEach` con `unlinkSync` per non
 * inquinare il worktree.
 */

// Self-sufficiency: registra gli hook ESM anche con `node --test` diretto.
import "../ts-esm-loader.mjs";
import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalize, assertSnapshot } from "./snapshot.js";

// ─── Helpers locali ───────────────────────────────────────────────────────

/**
 * Path assoluto della directory `tests/__snapshots__/` (risolto rispetto a
 * questo file, non al cwd). Coerente con la convenzione dell'helper:
 * `new URL("../__snapshots__/<name>.json", import.meta.url)`.
 */
const SNAPSHOTS_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"__snapshots__",
);

/** Prefisso dedicato ai baseline scritti da questi test (NON conflitta con
 *  `manifest-snapshot`, il baseline reale che S03/T02 scriverà). */
const TEST_PREFIX = "__helper-test-";

/** Set di nomi di file di snapshot scritti durante i test, da rimuovere in
 *  `afterEach` per non inquinare il worktree tra run. */
const writtenPaths = new Set<string>();

function trackSnapshot(name: string): string {
	const p = join(SNAPSHOTS_DIR, `${name}.json`);
	writtenPaths.add(p);
	return p;
}

/** Cleanup di tutti i file scritti da QUESTA suite durante il test corrente.
 *  Eseguito in `afterEach` per garantire che il worktree torni pulito ad
 *  ogni run (i test potrebbero scrivere e cancellare lo stesso path più
 *  volte — la pulizia è idempotente grazie a `force: true`). */
afterEach(() => {
	for (const p of writtenPaths) {
		try {
			if (existsSync(p)) unlinkSync(p);
		} catch {
			// best-effort cleanup, ignora ENOENT race con un altro afterEach
		}
	}
	writtenPaths.clear();
});

/** Mock di `TestContext` minimo: solo `diagnostic`, l'unica API che
 *  `assertSnapshot` chiama (in modalità update). Cattura i messaggi di
 *  aggiornamento per ispezione nei test. */
function makeMockT() {
	const diagnostics: string[] = [];
	return {
		diagnostics,
		t: {
			diagnostic(message: string) {
				diagnostics.push(message);
			},
		},
	};
}

/** Salva e ripristina `process.env.UPDATE_SNAPSHOTS` attorno a una callback.
 *  Usato dai test che dipendono da uno stato specifico dell'env (cancellato
 *  o "1"). */
function withUpdateSnapshots<T>(value: string | undefined, fn: () => T): T {
	const previous = process.env.UPDATE_SNAPSHOTS;
	if (value === undefined) {
		delete process.env.UPDATE_SNAPSHOTS;
	} else {
		process.env.UPDATE_SNAPSHOTS = value;
	}
	try {
		return fn();
	} finally {
		if (previous === undefined) {
			delete process.env.UPDATE_SNAPSHOTS;
		} else {
			process.env.UPDATE_SNAPSHOTS = previous;
		}
	}
}

// ─── Test 1 — canonicalize top-level sorting ──────────────────────────────

test("canonicalize: ordina top-level keys lexicograficamente (z,a,m -> a,m,z)", () => {
	const input = { z: 1, a: 2, m: 3 };
	const out = canonicalize(input);
	assert.equal(
		out,
		'{\n  "a": 2,\n  "m": 3,\n  "z": 1\n}',
		"top-level keys devono apparire in ordine lessicografico, indent 2",
	);
});

// ─── Test 2 — canonicalize recursive sorting ───────────────────────────────

test("canonicalize: ordina keys ricorsivamente su oggetti nested", () => {
	const input = { b: { z: 1, a: 2 }, a: 1 };
	const out = canonicalize(input);
	// Verifica che `a` preceda `b` al top-level E dentro `b` `a` preceda `z`.
	const aIdx = out.indexOf('"a"');
	const bIdx = out.indexOf('"b"');
	const zIdx = out.indexOf('"z"');
	assert.ok(aIdx > -1 && bIdx > -1 && zIdx > -1, "tutte le chiavi presenti nel output");
	assert.ok(aIdx < bIdx, "top-level: 'a' precede 'b'");
	// La sezione dentro `b` inizia dopo l'apertura di `b`; il primo "a" o "z"
	// DOPO `bIdx` è quello dentro `b`. Usa lastIndexOf da bIdx+1 in poi per
	// trovare il primo '"a"' che sia dentro `b`.
	const innerA = out.indexOf('"a"', bIdx);
	const innerZ = out.indexOf('"z"', bIdx);
	assert.ok(innerA > -1 && innerZ > -1, "chiavi nested presenti");
	assert.ok(innerA < innerZ, "nested dentro 'b': 'a' precede 'z'");
});

// ─── Test 3 — canonicalize array order preserved ──────────────────────────

test("canonicalize: preserva l'ordine degli elementi di array (NON riordina)", () => {
	const input = { events: ["c", "a", "b"] };
	const out = canonicalize(input);
	// Atteso: l'array è serializzato con l'ordine letterale ["c","a","b"].
	assert.ok(
		out.includes('"events": [\n    "c",\n    "a",\n    "b"\n  ]'),
		`array preservato in ordine 'c','a','b' (output reale: ${out})`,
	);
	// Guardia anti-regressione: NON deve essere riordinato a ["a","b","c"].
	assert.ok(
		!out.includes('"events": [\n    "a",\n    "b"'),
		"l'array NON deve essere riordinato lessicograficamente",
	);
});

// ─── Test 4 — assertSnapshot PASS silente ─────────────────────────────────

test("assertSnapshot: PASS silente quando canonical(value) === canonical(baseline)", () => {
	const name = `${TEST_PREFIX}pass-symmetric`;
	trackSnapshot(name);

	withUpdateSnapshots("1", () => {
		const { t } = makeMockT();
		// Prima scrittura: crea il baseline con value = {a:1, b:2}.
		assertSnapshot(t, name, { a: 1, b: 2 });
	});

	withUpdateSnapshots(undefined, () => {
		const { t } = makeMockT();
		// Seconda chiamata: stesso value, env update cancellato. PASS silente.
		assertSnapshot(t, name, { a: 1, b: 2 });
		// Esplicito: nessun throw, nessun fail.
	});
});

// ─── Test 5 — assertSnapshot FAIL con diff body ────────────────────────────

test("assertSnapshot: FAIL con diff body quando canonical(value) !== canonical(baseline)", () => {
	const name = `${TEST_PREFIX}fail-diff`;
	trackSnapshot(name);

	withUpdateSnapshots("1", () => {
		const { t } = makeMockT();
		assertSnapshot(t, name, { a: 1 });
	});

	withUpdateSnapshots(undefined, () => {
		const { t } = makeMockT();
		assert.throws(
			() => assertSnapshot(t, name, { a: 2 }),
			(expected: unknown) => {
				const msg = expected instanceof Error ? expected.message : String(expected);
				// Deve contenere almeno uno dei marcatori unified-diff style:
				//   "--- expected", "+++ actual", "--- ", "+++ ", "@@".
				return /expected|actual|---|\+\+\+|@@/.test(msg);
			},
			"FAIL deve includere un body di diff (marcatori expected/actual/---/+++/@@)",
		);
	});
});

// ─── Test 6 — assertSnapshot missing throws ────────────────────────────────

test("assertSnapshot: throw 'snapshot missing' quando file assente e UPDATE_SNAPSHOTS non è '1'", () => {
	// Nome univoco per garantire l'assenza: timestamp epoch ms + prefisso.
	const name = `${TEST_PREFIX}missing-smoke-${Date.now()}`;
	trackSnapshot(name);

	withUpdateSnapshots(undefined, () => {
		const { t } = makeMockT();
		assert.throws(
			() => assertSnapshot(t, name, { foo: "bar" }),
			/snapshot missing|UPDATE_SNAPSHOTS/i,
			"deve throware con messaggio che cita 'snapshot missing' o 'UPDATE_SNAPSHOTS'",
		);
	});
});

// ─── Test 7 — assertSnapshot scrive file con UPDATE_SNAPSHOTS=1 ────────────

test("assertSnapshot: scrive file quando UPDATE_SNAPSHOTS=1 (anche senza baseline preesistente)", () => {
	const name = `${TEST_PREFIX}update-writes`;
	const snapshotPath = trackSnapshot(name);

	// Sanity pre-condizione: il file non deve esistere prima del run.
	if (existsSync(snapshotPath)) {
		rmSync(snapshotPath, { force: true });
	}

	withUpdateSnapshots("1", () => {
		const { t, diagnostics } = makeMockT();
		assertSnapshot(t, name, { hello: "world", n: 42 });
		// Deve aver emesso un diagnostic di aggiornamento.
		assert.equal(
			diagnostics.length,
			1,
			"esattamente un diagnostic emesso in modalità update",
		);
		assert.ok(
			diagnostics[0].includes("snapshot updated"),
			`diagnostic content: ${JSON.stringify(diagnostics[0])}`,
		);
		assert.ok(
			diagnostics[0].includes(snapshotPath),
			"diagnostic deve contenere il path del file",
		);
	});

	// Verifica esistenza del file scritto.
	assert.ok(
		existsSync(snapshotPath),
		`file di snapshot deve esistere dopo UPDATE_SNAPSHOTS=1: ${snapshotPath}`,
	);

	// Verifica contenuto: canonical di {hello, n} con chiavi ordinate.
	const content = readFileSync(snapshotPath, "utf8");
	assert.ok(
		content.includes('"hello": "world"') && content.includes('"n": 42'),
		`contenuto scritto coerente col canonical: ${content}`,
	);

	// Guardia anti-vacuità: la directory `__snapshots__` deve contenere ALMENO
	// questo file appena scritto (NB: i path degli altri test sono già stati
	// puliti da afterEach di test precedenti — questo test è l'ultimo del
	// gruppo e i suoi trackSnapshot vengono comunque puliti dopo).
	const present = readdirSync(SNAPSHOTS_DIR).filter((f) =>
		f.startsWith(TEST_PREFIX),
	);
	assert.ok(
		present.length >= 1,
		"directory __snapshots__ deve contenere almeno il file di questo test",
	);
});