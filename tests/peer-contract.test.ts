/**
 * tests/peer-contract.test.ts — Presidio statico del peer contract (S01 / M020, T02).
 *
 * Obiettivo: rendere eseguibile il contratto di installazione R085 per il
 * peer REALE `@opengsd/gsd-pi`: range `>=1.21.1` con
 * `peerDependenciesMeta.optional` true (peer opzionale). Il peer fantasma
 * `@gsd/pi-coding-agent` (E404 sul registry npm, nessuna visibilita',
 * warning d'installazione) e' rimosso da package.json e package-lock.json
 * (D167): il test negativo qui sotto ne impedisce la re-introduzione
 * silenziosa.
 *
 * DUE CONTRATTI DISTINTI, MAI FUSI (R085, D166):
 *   1. Contratto di INSTALLAZIONE: range peer npm
 *      `@opengsd/gsd-pi >=1.21.1` (opzionale) — `peerDependencies` +
 *      `peerDependenciesMeta` in package.json, pinnati da questo presidio.
 *      La soglia `>=1.21.1` segue la prima release del peer reale sul
 *      registry (1.21.1), non la soglia runtime.
 *   2. Contratto di RUNTIME: soglia di feature detection 1.21.0 via
 *      `HOST_FEATURE_VERSION` in `src/runtime-classifier.ts:148` — NON
 *      toccata da questo presidio. L'host esegue la feature detection a
 *      runtime sul processo host (>= 1.21.0 -> feature host), in modo
 *      indipendente dal range npm con cui la extension e' stata installata:
 *      un host 1.21.0 installato senza il peer opzionale resta pienamente
 *      supportato.
 *
 * ENTRY-POINT (D166/MEM414): `main` e `exports` dichiarati su `./index.ts`
 * rendono il pacchetto consumabile via import mantenendo la export map
 * CHIUSA — solo `.`, nessuna wildcard `./*`, nessun `types` separato, nessun
 * build JS. La coerenza con `pi.extensions` (contiene `./index.ts`) e'
 * pinnata qui: entry-point importabile e extension registration restano
 * allineati.
 *
 * Nota: legge il JSON reale in root (`path.join(PROJECT_ROOT, "package.json")`
 * + `readFileSync`, pattern di `tests/extension-manifest.test.ts` e
 * `tests/release-pack.test.ts`) — nessuna fixture duplicata, il test parsa
 * esattamente il file che npm consuma a install time. Solo node:assert/strict
 * (D084/D004: zero nuove dipendenze).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const PROJECT_ROOT = dirname(fileURLToPath(import.meta.url)) + "/..";
const PEER_NAME = "@opengsd/gsd-pi";
const PEER_RANGE = ">=1.21.1";
const GHOST_PEER = "@gsd/pi-coding-agent";
const ENTRY_POINT = "./index.ts";

function loadPackageJson(): Record<string, unknown> {
	const raw = readFileSync(join(PROJECT_ROOT, "package.json"), "utf8");
	return JSON.parse(raw) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// (1) Contratto di installazione: peer reale, positivo
// ---------------------------------------------------------------------------

test("peer contract: peerDependencies['@opengsd/gsd-pi'] === '>=1.21.1' (R085, D167)", () => {
	const pkg = loadPackageJson();
	const peerDeps = pkg.peerDependencies as Record<string, unknown> | undefined;
	assert.ok(
		peerDeps !== undefined && typeof peerDeps === "object",
		`package.json.peerDependencies deve essere un oggetto (attuale: ${JSON.stringify(pkg.peerDependencies)})`,
	);
	const range = peerDeps?.[PEER_NAME];
	assert.equal(
		range,
		PEER_RANGE,
		`package.json.peerDependencies['${PEER_NAME}'] deve essere '${PEER_RANGE}' (contratto di installazione R085, D167) — attuale: ${String(range)}`,
	);
});

test("peer contract: peerDependenciesMeta['@opengsd/gsd-pi'].optional === true (D167)", () => {
	const pkg = loadPackageJson();
	const peerMeta = pkg.peerDependenciesMeta as
		| Record<string, { optional?: unknown }>
		| undefined;
	assert.ok(
		peerMeta !== undefined && typeof peerMeta === "object",
		`package.json.peerDependenciesMeta deve essere un oggetto (attuale: ${JSON.stringify(pkg.peerDependenciesMeta)})`,
	);
	const meta = peerMeta?.[PEER_NAME];
	assert.ok(
		meta !== undefined && typeof meta === "object",
		`package.json.peerDependenciesMeta['${PEER_NAME}'] deve esistere (attuale: ${JSON.stringify(peerMeta?.[PEER_NAME])})`,
	);
	assert.equal(
		meta?.optional,
		true,
		`package.json.peerDependenciesMeta['${PEER_NAME}'].optional deve essere true (peer opzionale, D167) — attuale: ${String(meta?.optional)}`,
	);
});

// ---------------------------------------------------------------------------
// (2) Contratto negativo: il peer fantasma non torna
// ---------------------------------------------------------------------------

test("peer contract negativo: '@gsd/pi-coding-agent' assente da peerDependencies e peerDependenciesMeta (D167)", () => {
	const pkg = loadPackageJson();
	const peerDeps = pkg.peerDependencies as Record<string, unknown> | undefined;
	assert.ok(
		peerDeps !== undefined && typeof peerDeps === "object",
		`package.json.peerDependencies deve essere un oggetto (attuale: ${JSON.stringify(pkg.peerDependencies)})`,
	);
	assert.ok(
		!(GHOST_PEER in peerDeps),
		`package.json.peerDependencies non deve piu' contenere il peer fantasma '${GHOST_PEER}' (E404 sul registry, rimosso in D167) — attuale: ${JSON.stringify(Object.keys(peerDeps))}`,
	);
	const peerMeta = pkg.peerDependenciesMeta as
		| Record<string, unknown>
		| undefined;
	assert.ok(
		peerMeta !== undefined && typeof peerMeta === "object",
		`package.json.peerDependenciesMeta deve essere un oggetto (attuale: ${JSON.stringify(pkg.peerDependenciesMeta)})`,
	);
	assert.ok(
		!(GHOST_PEER in peerMeta),
		`package.json.peerDependenciesMeta non deve piu' contenere il peer fantasma '${GHOST_PEER}' (E404 sul registry, rimosso in D167) — attuale: ${JSON.stringify(Object.keys(peerMeta))}`,
	);
});

// ---------------------------------------------------------------------------
// (3) Entry-point: main/exports chiusi su ./index.ts (D166/MEM414)
// ---------------------------------------------------------------------------

test("entry-point: main === './index.ts' ed exports chiusa su '.' (D166/MEM414)", () => {
	const pkg = loadPackageJson();
	assert.equal(
		pkg.main,
		ENTRY_POINT,
		`package.json.main deve essere '${ENTRY_POINT}' (entry-point consumabile via import, D166) — attuale: ${String(pkg.main)}`,
	);
	const exportsMap = pkg.exports as Record<string, unknown> | undefined;
	assert.ok(
		exportsMap !== undefined && typeof exportsMap === "object" && !Array.isArray(exportsMap),
		`package.json.exports deve essere un oggetto (attuale: ${JSON.stringify(pkg.exports)})`,
	);
	assert.deepEqual(
		Object.keys(exportsMap),
		["."],
		`package.json.exports deve essere una export map CHIUSA con la sola chiave '.' (nessuna wildcard './*', nessun subpath, D166/MEM414) — attuale: ${JSON.stringify(Object.keys(exportsMap))}`,
	);
	assert.equal(
		exportsMap["."],
		ENTRY_POINT,
		`package.json.exports['.'] deve essere '${ENTRY_POINT}' (D166) — attuale: ${String(exportsMap["."])}`,
	);
});

test("entry-point: pi.extensions contiene './index.ts' (coerenza entry-point/extension registration)", () => {
	const pkg = loadPackageJson();
	const pi = pkg.pi as Record<string, unknown> | undefined;
	assert.ok(
		pi !== undefined && typeof pi === "object",
		`package.json.pi deve essere un oggetto (attuale: ${JSON.stringify(pkg.pi)})`,
	);
	const extensions = pi?.extensions as unknown;
	assert.ok(
		Array.isArray(extensions),
		`package.json.pi.extensions deve essere un array (attuale: ${JSON.stringify(pi?.extensions)})`,
	);
	assert.ok(
		(extensions as unknown[]).includes(ENTRY_POINT),
		`package.json.pi.extensions deve contenere '${ENTRY_POINT}' (entry-point main/exports allineato alla extension registration, D166) — attuale: ${JSON.stringify(extensions)}`,
	);
});
