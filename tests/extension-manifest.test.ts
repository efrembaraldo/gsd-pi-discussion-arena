/**
 * Guardia di shape sul manifest v2 (S04 / M009).
 *
 * Obiettivo: rendere eseguibile il contratto dichiarativo di S04 — lo schema
 * JSON dell'extension-manifest deve restare conforme al contract canonico di
 * gsd-pi (`gsd-pi/docs/extension-sdk/manifest-spec.md`) per i 4 campi
 * obbligatori richiesti da `isManifest()` (`id` / `name` / `version` / `tier`,
 * stringhe non vuote) e deve essere esteso in modo puro-additivo (D084) con il
 * contratto v2: `version` 0.2.0, `priority` 100 (number top-level),
 * `capabilities.required` (4 hook) e `provides.events` (4 eventi).
 *
 * Senza questo test la shape v2 puo' driftare silenziosamente (campo
 * rinominato, array accorciato, `priority` scritta come stringa) e M010
 * costruirebbe la tier classification su una base dati sbagliata.
 *
 * Nota: legge il JSON reale in root (`new URL("../extension-manifest.json",
 * import.meta.url)`, pattern di `tests/examples-validation.test.ts`) — nessuna
 * fixture duplicata, il test parsa esattamente il file che il registry di
 * gsd-pi carica a runtime.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Path reale del manifest (risolto rispetto a questo file, non al cwd)
// ---------------------------------------------------------------------------

const MANIFEST_PATH = fileURLToPath(
	new URL("../extension-manifest.json", import.meta.url),
);

function loadManifest(): Record<string, unknown> {
	const raw = readFileSync(MANIFEST_PATH, "utf8");
	return JSON.parse(raw) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Contratto canonico di base (isManifest permissivo: id/name/version/tier)
// ---------------------------------------------------------------------------

test("estensione: i 4 campi obbligatori dello schema canonico sono stringhe non vuote", () => {
	const m = loadManifest();
	for (const key of ["id", "name", "version", "tier"] as const) {
		assert.equal(typeof m[key], "string", `${key} deve essere una stringa`);
		assert.ok(
			(m[key] as string).length > 0,
			`${key} deve essere una stringa non vuota`,
		);
	}
	// Lo registry permissivo accetta campi extra; i campi obbligatori devono
	// restare esattamente presenti (mai rimossi o rinominati).
	assert.ok(m.id === "gsd-pi-discussion-arena", "id rimasto stabile (v1)");
});

test("Manifest: il campo requires.platform resta 'gsd-pi' (additive-only v1)", () => {
	const m = loadManifest();
	const requires = m.requires as { platform?: unknown };
	assert.equal(typeof requires, "object");
	assert.equal(requires.platform, "gsd-pi");
});

// ---------------------------------------------------------------------------
// Contratto v2
// ---------------------------------------------------------------------------

test("Manifest: la versione e' '0.2.0' (bump manifesto a v2)", () => {
	const m = loadManifest();
	assert.equal(m.version, "0.2.0");
});

test("Manifest: priority 100 (number top-level, non stringa)", () => {
	const m = loadManifest();
	assert.equal(typeof m.priority, "number");
	assert.equal(m.priority, 100);
	// Guardia negativa: una priority scritta come stringa romperebbe M010.
	assert.equal(typeof m.priority, "number", "priority non deve essere una stringa");
});

test("Manifest: provides.tools/commands v1 preservate (additive-only, D084)", () => {
	const m = loadManifest();
	const provides = m.provides as { tools?: unknown; commands?: unknown };
	assert.ok(Array.isArray(provides.tools), "provides.tools preservata");
	assert.ok(Array.isArray(provides.commands), "provides.commands preservata");
	assert.deepEqual(provides.tools, ["discussion_arena"]);
	assert.deepEqual(provides.commands, ["discussion-arena"]);
});

test("Manifest: capabilities.required e' esattamente [unit_start, adjust_tool_set, before_agent_start, phase_change]", () => {
	const m = loadManifest();
	const capabilities = m.capabilities as { required?: unknown };
	assert.ok(capabilities && typeof capabilities === "object", "capabilities top-level presente");
	assert.ok(Array.isArray(capabilities.required), "capabilities.required e' un array");
	assert.deepEqual(capabilities.required, [
		"unit_start",
		"adjust_tool_set",
		"before_agent_start",
		"phase_change",
	]);
});

test("Manifest: provides.events e' esattamente i 4 eventi dichiarati, in ordine", () => {
	const m = loadManifest();
	const provides = m.provides as { events?: unknown };
	assert.ok(Array.isArray(provides.events), "provides.events e' un array");
	assert.deepEqual(provides.events, [
		"unit_start",
		"adjust_tool_set",
		"before_agent_start",
		"tool_call",
	]);
});

// ---------------------------------------------------------------------------
// Negative surface: i tipi contano quanto i valori (guardie anti-drift)
// ---------------------------------------------------------------------------

test("Manifest: gli array di capability/eventi non hanno duplicati ne' valori fuori contratto", () => {
	const m = loadManifest();
	const caps = ((m.capabilities as { required?: unknown }).required ?? []) as unknown[];
	const events = ((m.provides as { events?: unknown }).events ?? []) as unknown[];
	for (const arr of [caps, events]) {
		assert.equal(new Set(arr).size, arr.length, "nessun duplicato negli array dichiarativi");
		for (const v of arr) {
			assert.equal(typeof v, "string");
			assert.ok((v as string).length > 0, "nessun elemento stringa vuota");
		}
	}
});

test("Manifest: description e' una stringa non vuota (metadata v1 preservato)", () => {
	const m = loadManifest();
	assert.equal(typeof m.description, "string");
	assert.ok((m.description as string).length > 0);
});