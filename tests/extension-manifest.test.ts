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
 *
 * S01 / M019 (R071): aggiunto presidio anti-drift strutturale
 * `assertVersionParity(manifest, package.json)` — il test snapshot
 * bit-identico (D103) rileva solo che il manifest e' cambiato rispetto al
 * baseline, non che manifest e package.json siano concordi (una
 * rigenerazione distratta del baseline con manifest disallineato passerebbe).
 * La funzione pura chiude quel buco ed e' autocontrollata con drift simulato
 * interamente in memoria: nessuna scrittura su file reali.
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

const PACKAGE_PATH = fileURLToPath(new URL("../package.json", import.meta.url));

function loadPackageJson(): Record<string, unknown> {
	return JSON.parse(readFileSync(PACKAGE_PATH, "utf8")) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Presidio anti-drift versione (R071): funzione pura a livello di modulo,
// ispezionabile e autocontrollabile con drift simulato in memoria. Solo
// node:assert/strict (D084/D004: zero nuove dipendenze). Il messaggio nomina
// ENTRAMBE le versioni e la label del chiamante, cosi' un drift manifesto vs
// package.json fallisce con causa leggibile nei log CI del job build.
// ---------------------------------------------------------------------------

function assertVersionParity(
	manifest: { version?: unknown },
	pkg: { version?: unknown },
	label: string,
): void {
	assert.equal(
		manifest.version,
		pkg.version,
		`manifest ${label}: extension-manifest.json version '${String(manifest.version)}' != package.json version '${String(pkg.version)}' — allinea i due file (R071)`,
	);
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

test("Manifest: la versione e' '0.9.2' (target di rilascio corrente)", () => {
	const m = loadManifest();
	assert.equal(m.version, "0.9.2");
});

test("Manifest: version in parita' con package.json.version (presidio anti-drift R071)", () => {
	assertVersionParity(
		loadManifest(),
		loadPackageJson(),
		"extension-manifest.json vs package.json",
	);
});

test("Presidio anti-drift: assertVersionParity lancia su manifest sintetico discordante (drift simulato, SOLO in memoria)", () => {
	const realPkg = loadPackageJson();
	const syntheticManifest = { version: "0.9.0" };
	assert.throws(
		() => assertVersionParity(syntheticManifest, realPkg, "drift simulato"),
		/drift simulato/,
	);
});

test("Presidio anti-drift: assertVersionParity lancia su package sintetico discordante (direzione opposta, SOLO in memoria)", () => {
	const realManifest = loadManifest();
	const syntheticPkg = { version: "99.99.99" };
	assert.throws(
		() => assertVersionParity(realManifest, syntheticPkg, "drift simulato (package)"),
		/drift simulato \(package\):.*99\.99\.99/,
	);
});

test("Manifest: provides.tools/commands preservate (additive-only, D084)", () => {
	const m = loadManifest();
	const provides = m.provides as { tools?: unknown; commands?: unknown };
	assert.ok(Array.isArray(provides.tools), "provides.tools preservata");
	assert.ok(Array.isArray(provides.commands), "provides.commands preservata");
	assert.deepEqual(provides.tools, ["discussion_arena"]);
	assert.deepEqual(provides.commands, [
		"discussion-arena",
		"discussion-arena-init",
		"discussion-arena-view",
		"discussion-arena-status",
	]);
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

// ---------------------------------------------------------------------------
// Wiring reale (S07/T03): activate() registra il 4° command
// `discussion-arena-status` e il suo handler emette SOLO via ctx.ui.notify
// (mai su process.stdout — R061). Pattern capture-handler di
// tests/index.test.ts:187 (stub api con cast `as never`).
// ---------------------------------------------------------------------------

import "./ts-esm-loader.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import activate from "../index.js";

interface CapturedStatusCommand {
	names: string[];
	handler: (args: unknown, ctx: unknown) => Promise<void>;
}

let captured: CapturedStatusCommand | undefined;

function captureStatusCommand(): CapturedStatusCommand {
	if (captured) return captured;
	const names: string[] = [];
	let statusHandler: unknown;
	// Shape locale minima dello stub (nessun import di tipi dal bare
	// specifier @gsd/pi-coding-agent — pattern repo, vedi tests/index.test.ts).
	const api = {
		on: () => {},
		registerTool: () => ({}),
		registerCommand: (name: string, cfg: { handler?: unknown }) => {
			names.push(name);
			if (name === "discussion-arena-status") {
				statusHandler = cfg.handler;
			}
			return {};
		},
	} as never;
	activate(api);
	if (!statusHandler) {
		throw new Error(
			"discussion-arena-status non registrato da activate() (dual registration MEM338 rotta)",
		);
	}
	captured = {
		names,
		handler: statusHandler as (args: unknown, ctx: unknown) => Promise<void>,
	};
	return captured;
}

// Nota: activate() gira UNA sola volta per processo (cache del modulo ESM);
// entrambi i test condividono lo stesso capture.
test("Wiring: activate() registra esattamente i 4 comandi canonici in ordine", () => {
	const { names } = captureStatusCommand();
	assert.deepEqual(names, [
		"discussion-arena",
		"discussion-arena-init",
		"discussion-arena-view",
		"discussion-arena-status",
	]);
});

test("Wiring: discussion-arena-status emette solo via ctx.ui.notify, mai su process.stdout (R061)", async () => {
	const { handler } = captureStatusCommand();
	const cwd = mkdtempSync(join(tmpdir(), "manifest-status-"));
	try {
		const notifications: string[] = [];
		const ctx = {
			cwd,
			ui: {
				notify: async (message: string) => {
					notifications.push(message);
				},
			},
		};
		// Spy su process.stdout.write: qualunque tentativo di scrittura
		// diretta del comando verrebbe contato. NOTA: sotto `node --test` il
		// reporter scrive i propri chunk sullo stesso stream durante l'await,
		// quindi il criterio è che NESSUN chunk stdout contenga l'output del
		// comando (header canonico o titolo formattato) — verificato a parte
		// che fuori dal runner il conteggio grezzo è 0.
		const originalWrite = process.stdout.write.bind(process.stdout);
		const stdoutChunks: string[] = [];
		(process.stdout as { write: unknown }).write = ((chunk: unknown) => {
			stdoutChunks.push(String(chunk));
			// Inoltra al reporter di `node --test` (T02/R071): con `return true`
			// la spy ingoiava i chunk TAP degli altri test durante l'await del
			// handler (reporter padre: 1-2 test conteggiati su 13) e i messaggi
			// di fallimento (es. presidio anti-drift R071) non arrivavano ai log CI.
			return originalWrite(chunk as never);
		}) as typeof process.stdout.write;
		try {
			await handler("", ctx);
		} finally {
			process.stdout.write = originalWrite;
		}
		assert.ok(
			!stdoutChunks.some((c) => /\[discussion-arena-status\]|Discussion Arena status/.test(c)),
			`nessun output del comando su stdout (trovati ${stdoutChunks.length} chunk estranei del test runner)`,
		);
		assert.equal(notifications.length, 1, "una sola notify canonica");
		assert.match(
			notifications[0],
			/^\[discussion-arena-status\]/,
			"notify con prefisso canonico [discussion-arena-status]",
			);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});