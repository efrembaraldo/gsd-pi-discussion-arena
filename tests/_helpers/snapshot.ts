/**
 * tests/_helpers/snapshot.ts — Helper riusabile per snapshot test custom in
 * `node:test` puro (D004: zero deps npm).
 *
 * Implementa il pattern deciso in D103 (M011/S03 + S05):
 *   - snapshot persistiti in `tests/__snapshots__/<name>.json`, committati in
 *     repo (NON gitignored) per CI reproducibility;
 *   - rigenerabili via convenzione `UPDATE_SNAPSHOTS=1 npm test` (nessun flag
 *     bespoke, nessuna auto-discovery via args, nessuna customizzazione del
 *     test runner — D004 + D103);
 *   - canonicalizzazione JSON con chiavi top-level ordinate lexicograficamente
 *     (ricorsivo su oggetti nested), array preservati nell'ordine degli
 *     elementi. Rende lo snapshot bit-identico indipendente dall'ordine di
 *     inserimento delle chiavi nel sorgente.
 *
 * API pubblica:
 *   - `canonicalize(value: unknown): string`
 *       Serializza `value` come JSON con indent 2 e chiavi oggetto ordinate
 *       lexicograficamente (ricorsivo). Gli array preservano l'ordine degli
 *       elementi. Usato anche direttamente dai test che vogliono solo la
 *       forma canonica.
 *   - `assertSnapshot(t, name, value, opts?): void`
 *       Confronto `canonical(value)` contro `tests/__snapshots__/<name>.json`.
 *       Se `opts.update === true` o `process.env.UPDATE_SNAPSHOTS === "1"`,
 *       scrive il baseline e ritorna (modalità `t.diagnostic(...)` per non
 *       essere contata come test fallito). Altrimenti:
 *         - snapshot assente → throw con messaggio che istruisce a usare
 *           `UPDATE_SNAPSHOTS=1` per inizializzare;
 *         - mismatch → `assert.fail` con diff unificato (60 righe di contesto)
 *           che include entrambi i canonical separati da `--- expected` /
 *           `+++ actual`, unified-diff-style.
 *       `t` è il `TestContext` di `node:test` (passato dal test caller).
 *
 * Esempio d'uso (vedi `tests/integration/manifest-snapshot.test.ts`):
 *
 *   ```ts
 *   import { test } from "node:test";
 *   import { assertSnapshot } from "../_helpers/snapshot.js";
 *   import { loadManifest } from "./_load-manifest.js";
 *
 *   test("manifest snapshot: extension-manifest.json v2 è bit-identico al baseline", () => {
 *     assertSnapshot(t, "manifest-snapshot", loadManifest());
 *   });
 *   ```
 *
 * Come rigenerare i baseline:
 *
 *   ```bash
 *   UPDATE_SNAPSHOTS=1 npm test
 *   # oppure in modo mirato:
 *   UPDATE_SNAPSHOTS=1 node --import ./tests/ts-esm-loader.mjs \
 *     --test tests/integration/manifest-snapshot.test.ts
 *   ```
 *
 * Zero dipendenze npm: solo `node:fs`, `node:path`, `node:url`,
 * `node:assert/strict`. Pattern riusato da S03 (manifest bit-identico) e S05
 * (availability-only transcript regression).
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as assert from "node:assert/strict";

/**
 * Forma minima del `TestContext` di `node:test` su cui ci appoggiamo: solo
 * `diagnostic`, che viene chiamato quando il baseline viene rigenerato
 * (modalità update). Dichiarato qui come tipo strutturale per non accoppiare
 * l'helper al `@types/node` di una specifica versione di `node:test`.
 */
export interface TestContextLike {
	diagnostic(message: string): void;
}

/**
 * `JSON.stringify` replacer ricorsivo che ordina lexicograficamente le chiavi
 * di ogni oggetto incontrato. Gli array NON sono riordinati (preservano
 * l'ordine degli elementi). Restituisce il valore così come arrivato per i
 * tipi primitivi.
 */
function sortKeysReplacer(_key: string, value: unknown): unknown {
	if (value !== null && typeof value === "object" && !Array.isArray(value)) {
		const sorted: Record<string, unknown> = {};
		for (const k of Object.keys(value as Record<string, unknown>).sort()) {
			sorted[k] = (value as Record<string, unknown>)[k];
		}
		return sorted;
	}
	return value;
}

/**
 * Serializza `value` come JSON con indent 2 e top-level keys ordinate
 * lexicograficamente (ricorsivo su oggetti nested). Gli array preservano
 * l'ordine degli elementi — `canonicalize({events:["c","a","b"]})` produce
 * `'{\n  "events": [\n    "c",\n    "a",\n    "b"\n  ]\n}'`.
 */
export function canonicalize(value: unknown): string {
	return JSON.stringify(value, sortKeysReplacer, 2);
}

/**
 * Risolve il path assoluto del file di snapshot `tests/__snapshots__/<name>.json`
 * relativamente al modulo chiamante (NON a questo helper). `import.meta.url`
 * è passato esplicitamente dal caller via la signature `assertSnapshot(t,
 * name, value, opts?, callerUrl?)` — vedi nota implementativa sotto.
 */
function resolveSnapshotPath(name: string, callerUrl: string): string {
	return fileURLToPath(new URL(`../__snapshots__/${name}.json`, callerUrl));
}

/**
 * Diff unificato minimale (60 righe di contesto per lato) tra expected e
 * actual: header `--- expected\n+++ actual`, body con linee ` `<spazio> / `-`
 * / `+` come in un unified diff. Non usa librerie: per i nostri file di
 * snapshot (manifest v2 = ~20 righe, transcript availability-only ~50 righe)
 * un diff line-by-line naive produce output leggibile, predicibile e
 * indipendente dalla piattaforma. Il context window di 60 righe garantisce
 * che snapshot grandi restino leggibili senza essere troncati.
 */
function buildUnifiedDiff(expected: string, actual: string): string {
	const CONTEXT_LINES = 60;
	const expectedLines = expected.split("\n");
	const actualLines = actual.split("\n");
	const max = Math.max(expectedLines.length, actualLines.length);
	const ctxStart = Math.max(0, 0);
	const ctxEnd = Math.min(max, ctxStart + CONTEXT_LINES);

	const header = "--- expected\n+++ actual";
	const body: string[] = [];
	for (let i = ctxStart; i < ctxEnd; i += 1) {
		const e = expectedLines[i];
		const a = actualLines[i];
		if (e === a) {
			body.push(` ${e ?? ""}`);
		} else {
			if (e !== undefined) body.push(`-${e}`);
			if (a !== undefined) body.push(`+${a}`);
		}
	}
	return [header, ...body].join("\n");
}

/**
 * Confronta `value` (canonicalizzato) contro il baseline persistito in
 * `tests/__snapshots__/<name>.json`. Il path del baseline è risolto
 * relativamente al modulo CHE CHIAMA questo helper (callerUrl), così lo
 * stesso helper è riusabile da qualunque profondità di `tests/` senza dover
 * conoscere la propria collocazione.
 *
 * Modalità update (scrittura): se `opts.update === true` oppure
 * `process.env.UPDATE_SNAPSHOTS === "1"`, scrive il canonical di `value` e
 * ritorna senza assertion. La scrittura è accompagnata da `t.diagnostic(...)`
 * per ispezionabilità ma non falla il test.
 *
 * Modalità strict (default): se il file è assente, throw con messaggio che
 * istruisce l'utente a usare `UPDATE_SNAPSHOTS=1` per inizializzare. Se il
 * canonical di `value` diverge dal baseline, `assert.fail` con diff unificato
 * che include entrambi i canonical per ispezione diretta.
 *
 * NB: `import.meta.url` deve essere passato esplicitamente perché `node:test`
 * non espone automaticamente il caller al chiamato, e l'helper non può
 * sapere da quale file viene invocato senza un indizio. La firma
 * `assertSnapshot(t, name, value, opts, callerUrl)` è esplicita; i wrapper
 * di convenienza per i test file useranno direttamente `import.meta.url`.
 */
export function assertSnapshot(
	t: TestContextLike,
	name: string,
	value: unknown,
	opts?: { update?: boolean },
	callerUrl: string = import.meta.url,
): void {
	const snapshotPath = resolveSnapshotPath(name, callerUrl);
	const canonical = canonicalize(value);
	const isUpdate = opts?.update === true || process.env.UPDATE_SNAPSHOTS === "1";

	if (isUpdate) {
		mkdirSync(dirname(snapshotPath), { recursive: true });
		// writeFileSync (non async) per evitare race con i check immediati
		// del test (existsSync/readFileSync). Scrittura solo in modalità update,
		// mai nel path hot: snapshot piccoli (manifest v2 ~20 righe), nessun
		// collo di bottiglia. Il newline finale rende il file git-friendly
		// (POSIX text file convention).
		writeFileSync(snapshotPath, canonical + "\n", "utf8");
		t.diagnostic(`snapshot updated: ${snapshotPath}`);
		return;
	}

	if (!existsSync(snapshotPath)) {
		throw new Error(
			`snapshot missing: ${snapshotPath} — run with UPDATE_SNAPSHOTS=1 to initialize`,
		);
	}

	const baseline = readFileSync(snapshotPath, "utf8");
	if (baseline === canonical || baseline === canonical + "\n") {
		return;
	}

	assert.fail(
		`snapshot mismatch (${name}):\n${buildUnifiedDiff(baseline, canonical)}`,
	);
}
