/**
 * tests/peer-contract.test.ts — Presidio statico del peer contract (S03 / M019, T04).
 *
 * Obiettivo: rendere eseguibile il contratto di compatibilita' host R075 per
 * `@gsd/pi-coding-agent`: range `>=1.15.0` con `peerDependenciesMeta.optional`
 * true (peer opzionale, invariato). Prima di questo presidio il field era `*`
 * e nessun test pinnava il range (verificato: grep su tests/ senza presidio
 * dedicato), quindi una regressione del range passava silenziosamente.
 *
 * Perche' `>=1.15.0` e non `>=1.21.0`: il contratto host e' retrocompatibile —
 * la extension gira anche su host pre-1.21 senza le 3 capability v1.21.0
 * (dispatch context #1997, delta toolset #1998, phase_change #1999), degrade-
 * ando nei Tier pre-F con i feature codes `no_dispatch_context`,
 * `no_delta_toolset`, `no_phase_change_event` (T01/T02/T03). La soglia di
 * feature detection 1.21.0 e' un contratto RUNTIME (`HOST_FEATURE_VERSION` in
 * `src/runtime-classifier.ts`), non un vincolo di installazione.
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
const PEER_NAME = "@gsd/pi-coding-agent";
const PEER_RANGE = ">=1.15.0";

function loadPackageJson(): Record<string, unknown> {
	const raw = readFileSync(join(PROJECT_ROOT, "package.json"), "utf8");
	return JSON.parse(raw) as Record<string, unknown>;
}

test("peer contract: peerDependencies['@gsd/pi-coding-agent'] === '>=1.15.0' (R075)", () => {
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
		`package.json.peerDependencies['${PEER_NAME}'] deve essere '${PEER_RANGE}' (contratto host retrocompatibile, R075) — attuale: ${String(range)}`,
	);
});

test("peer contract: peerDependenciesMeta['@gsd/pi-coding-agent'].optional === true (invariato)", () => {
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
		`package.json.peerDependenciesMeta['${PEER_NAME}'].optional deve restare true (peer opzionale, invariato) — attuale: ${String(meta?.optional)}`,
	);
});
