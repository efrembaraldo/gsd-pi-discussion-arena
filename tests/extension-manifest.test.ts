/**
 * Guardia di shape sul manifest (S04 / M009, riallineata in S01 / M010).
 *
 * Obiettivo: rendere eseguibile il contratto canonico di gsd-pi
 * (`gsd-pi/docs/extension-sdk/manifest-spec.md`) per i 4 campi obbligatori
 * richiesti da `isManifest()` (`id` / `name` / `version` / `tier`, stringhe
 * non vuote) e tenere come guardia anti-drift i campi dichiarativi
 * effettivamente consumati dal loader (`requires.platform`, `provides.tools`,
 * `provides.commands`, `provides.events`).
 *
 * S01 / M010 ha rimosso dal manifest `phase_change` (evento INESISTENTE in
 * `ExtensionAPI.on`), `capabilities.required` (campo documentale non validato
 * dal loader gsd-pi) e `priority` (non letto dal loader, D083). Questo test
 * e' stato allineato al nuovo contratto: niente asserzioni su `priority` /
 * `capabilities` / `phase_change`, solo shape canonica + `provides.events`
 * (4 eventi reali: `unit_start`, `adjust_tool_set`, `before_agent_start`,
 * `tool_call`).
 *
 * Senza questo test la shape puo' driftare silenziosamente (campo rinominato,
 * array accorciato, evento fantasma reintrodotto) e M010 costruirebbe la tier
 * classification su una base dati sbagliata.
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
// Contratto canonico (D084 additive-only)
// ---------------------------------------------------------------------------

test("Manifest: la versione e' '0.2.0' (target di rilascio corrente)", () => {
	const m = loadManifest();
	assert.equal(m.version, "0.2.0");
});

test("Manifest: provides.tools/commands preservate (additive-only, D084)", () => {
	const m = loadManifest();
	const provides = m.provides as { tools?: unknown; commands?: unknown };
	assert.ok(Array.isArray(provides.tools), "provides.tools preservata");
	assert.ok(Array.isArray(provides.commands), "provides.commands preservata");
	assert.deepEqual(provides.tools, ["discussion_arena"]);
	assert.deepEqual(provides.commands, ["discussion-arena"]);
});

test("Manifest: provides.events e' esattamente i 4 eventi reali, in ordine (no phase_change)", () => {
	const m = loadManifest();
	const provides = m.provides as { events?: unknown };
	assert.ok(Array.isArray(provides.events), "provides.events e' un array");
	assert.deepEqual(provides.events, [
		"unit_start",
		"adjust_tool_set",
		"before_agent_start",
		"tool_call",
	]);
	// Guardia anti-regressione: phase_change e' un evento INESISTENTE in
	// ExtensionAPI.on — se rientra per errore, M010 costruirebbe la tier
	// classification su una base falsa.
	assert.ok(
		!(provides.events as unknown[]).includes("phase_change"),
		"phase_change non deve essere dichiarato (non esiste in ExtensionAPI.on)",
	);
});

// ---------------------------------------------------------------------------
// Negative surface: i tipi contano quanto i valori (guardie anti-drift)
// ---------------------------------------------------------------------------

test("Manifest: provides.events non ha duplicati ne' valori vuoti", () => {
	const m = loadManifest();
	const events = ((m.provides as { events?: unknown }).events ?? []) as unknown[];
	assert.equal(new Set(events).size, events.length, "nessun duplicato in provides.events");
	for (const v of events) {
		assert.equal(typeof v, "string");
		assert.ok((v as string).length > 0, "nessun evento stringa vuota");
	}
});

test("Manifest: nessun campo fantasma (priority / capabilities / phase_change) reintrodotto", () => {
	const m = loadManifest();
	// priority: non letto dal loader gsd-pi (D083) — non deve ricomparire.
	assert.equal(
		m.priority,
		undefined,
		"priority non deve essere dichiarato (non letto dal loader gsd-pi)",
	);
	// capabilities: campo documentale non validato — non deve ricomparire.
	assert.equal(
		m.capabilities,
		undefined,
		"capabilities non deve essere dichiarato (campo documentale non validato)",
	);
});

test("Manifest: description e' una stringa non vuota (metadata v1 preservato)", () => {
	const m = loadManifest();
	assert.equal(typeof m.description, "string");
	assert.ok((m.description as string).length > 0);
});