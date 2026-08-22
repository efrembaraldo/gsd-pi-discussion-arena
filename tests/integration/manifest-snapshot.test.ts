/**
 * tests/integration/manifest-snapshot.test.ts — M011/S03/T02.
 *
 * Test anti-drift BIT-IDENTICO su `extension-manifest.json` v2: confronta la
 * serializzazione canonica del manifest (chiavi top-level ordinate
 * lexicograficamente, ricorsivo su oggetti nested, array preservati
 * nell'ordine degli elementi) contro un baseline committato in
 * `tests/__snapshots__/manifest-snapshot.json`.
 *
 * SCOPO: rilevare qualsiasi modifica non documentata al manifest — campo
 * rinominato, evento rimosso, tier cambiato, versione bumpata senza ADR —
 * PRIMA che possa rompere M010 (che costruisce la tier classification sul
 * manifest). Se il manifest cambia, `npm test` exit != 0, il pre-flight
 * check in CI blocca il merge (vedi `.github/workflows/ci.yml#build`).
 *
 * Come rigenerare il baseline dopo una modifica intenzionale del manifest:
 *
 *   ```bash
 *   UPDATE_SNAPSHOTS=1 npm test
 *   # oppure in modo mirato:
 *   UPDATE_SNAPSHOTS=1 node --import ./tests/ts-esm-loader.mjs \
 *     --test tests/integration/manifest-snapshot.test.ts
 *   ```
 *
 * Convenzioni (decisioni D004 + D103):
 *   - Variabile d'ambiente `UPDATE_SNAPSHOTS=1` (NON un flag CLI bespoke,
 *     nessuna auto-discovery via args — coerente con D004 zero deps npm).
 *   - Baseline committato in `tests/__snapshots__/manifest-snapshot.json`
 *     (NON gitignored) per CI reproducibility.
 *
 * Ortogonalità con `tests/extension-manifest.test.ts` (shape-only guard):
 * quel test asserisce solo che `id/name/version/tier` sono stringhe non
 * vuote e che `provides.{tools,commands,events}` hanno la shape attesa.
 * Questo test è ortogonale: asserisce che il file INTERO è bit-identico a
 * un baseline versionato. Shape-only guard e anti-drift snapshot sono
 * entrambi necessari: shape-only tollera drift silenzioso, snapshot tollera
 * solo modifiche dichiarate (via UPDATE_SNAPSHOTS+commit).
 */

import "../ts-esm-loader.mjs";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertSnapshot } from "../_helpers/snapshot.js";

// ---------------------------------------------------------------------------
// Path reale del manifest (risolto rispetto a questo file, non al cwd)
// Stesso pattern di `tests/extension-manifest.test.ts:46-49`.
// ---------------------------------------------------------------------------

const MANIFEST_PATH = fileURLToPath(
	new URL("../../extension-manifest.json", import.meta.url),
);

function loadManifest(): Record<string, unknown> {
	const raw = readFileSync(MANIFEST_PATH, "utf8");
	return JSON.parse(raw) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Test anti-drift bit-identico
// ---------------------------------------------------------------------------

test("manifest snapshot: extension-manifest.json v2 è bit-identico al baseline (chiavi ordinate lexicograficamente)", (t) => {
	assertSnapshot(t, "manifest-snapshot", loadManifest());
});
