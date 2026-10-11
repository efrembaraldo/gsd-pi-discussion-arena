/**
 * tests/release-tag.test.ts — Guardia di shape sui tag annotati di release
 * (v0.9.0 baseline S04 / M015; v0.10.0 estensione S07 / M019; v0.10.1
 * estensione S08 / M019 — release riparativa packaging).
 *
 * Storia guardie per release (pattern M015, additivo):
 *   - S04 / M015: v0.9.0 (assertion 1-3)
 *   - S07 / M019: v0.10.0 (assertion 4-6)
 *   - S08 / M019: v0.10.1 (assertion 7-9)
 *
 * Obiettivo: rendere eseguibile il contratto di release per cui esistono su
 * origin i tag annotati `v0.9.0`, `v0.10.0` e `v0.10.1`, ciascuno corrispondente alla
 * versione bumpata in `package.json` e `extension-manifest.json`. Per ogni
 * versione di release guardata, tre assertion `execFileSync` coprono i tre
 * invarianti minimi:
 *
 *   1. Local: `git tag -l v<VER>` ritorna esattamente "v<VER>".
 *      Garantisce che il tag esiste localmente (creato con `git tag -a`).
 *
 *   2. Annotated: `git cat-file -t v<VER>` ritorna "tag" (NON "commit").
 *      Un tag lightweight avrebbe object-type "commit", ma il pre-execution
 *      gate di release richiede tag annotato perche' il tag object porta
 *      tagger + messaggio + timestamp, informazioni che il registry GitHub
 *      usa per la "Verified tag" UI e per `gh release create`.
 *
 *   3. Pushed: `git ls-remote --tags origin v<VER>` ritorna
 *      `<sha>\trefs/tags/v<VER>` con `<sha>` == SHA locale del tag object
 *      (ottenuto via `git rev-parse v<VER>`). Per i tag annotati, l'SHA
 *      remoto e' quello del tag object (NON del commit puntato): un match
 *      byte-per-byte conferma che origin e' sincronizzato al tag annotato,
 *      non a un lightweight equivalent scappato via push parallelo.
 *
 * Pattern M015: le guardie sono additive — ogni nuova release aggiunge tre
 * test paralleli (locale / annotato / pushed) senza rimuovere le guardie
 * delle release precedenti, cosi' la history di release resta verificabile.
 *
 * Perche' execFileSync e non shell pipes: la pre-execution verification
 * gate di S04 blocca shell pipe/redirect/grep alternation (la forma naive
 * `git ls-remote --tags origin | grep v0.9.0` viene rifiutata). execFileSync
 * passa argomenti come argv, niente shell expansion, ed e' anche piu'
 * efficiente (no fork di /bin/sh).
 *
 * cwd = PROJECT_ROOT calcolato da `import.meta.url` (../), stesso pattern di
 * tests/release-pack.test.ts e tests/extension-manifest.test.ts. NON
 * `process.cwd()`: `node --test` puo' essere lanciato da cwd diverse.
 *
 * NOTA: la assertion 3 (push su origin) richiede accesso SSH al remote
 * `origin`. Se il remote non e' raggiungibile (es. CI senza SSH key, o
 * sandbox senza rete), l'assertion fallisce loudly con l'errore completo
 * di git — questo e' desiderabile: se origin manca, il tag NON e' stato
 * pushato e il rilascio non e' completo, va riprovato.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Path della root del progetto (risolto rispetto a questo file, non al cwd)
// ---------------------------------------------------------------------------

const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));

// ---------------------------------------------------------------------------
// Helper: esegue `git <args>` dalla PROJECT_ROOT e ritorna stdout trimmed.
// Su failure di git (es. remote irraggiungibile, tag assente) cattura
// l'errore per produrre un messaggio diagnostico ricco.
// ---------------------------------------------------------------------------

function gitOrThrow(args: string[]): string {
	try {
		const stdout = execFileSync("git", args, {
			cwd: PROJECT_ROOT,
			encoding: "utf8",
			// 4MB: ls-remote su repo grossi puo' superare i 64KB default.
			maxBuffer: 4 * 1024 * 1024,
		});
		return stdout.trim();
	} catch (err) {
		const e = err as { status?: number | null; stderr?: Buffer | string };
		const stderr =
			typeof e.stderr === "string"
				? e.stderr
				: e.stderr
					? e.stderr.toString("utf8")
					: "(no stderr)";
		throw new Error(
			`git ${args.join(" ")} fallisce (status=${e.status ?? "?"}):\n${stderr}`,
		);
	}
}

// ---------------------------------------------------------------------------
// Assertion 1: il tag locale v0.9.0 esiste (`git tag -l v0.9.0` == "v0.9.0").
// ---------------------------------------------------------------------------

test("git tag -l v0.9.0: il tag locale esiste", () => {
	const listed = gitOrThrow(["tag", "-l", "v0.9.0"]);
	assert.equal(
		listed,
		"v0.9.0",
		`git tag -l v0.9.0 deve ritornare esattamente "v0.9.0" (attuale: ${JSON.stringify(listed)})`,
	);
});

// ---------------------------------------------------------------------------
// Assertion 2: il tag e' annotato (`git cat-file -t v0.9.0` == "tag", non "commit").
// Un lightweight tag avrebbe object-type "commit" — sarebbe semanticamente
// equivalente ma privo di tagger + messaggio + timestamp.
// ---------------------------------------------------------------------------

test("git cat-file -t v0.9.0: il tag e' annotato (object-type == 'tag')", () => {
	const objectType = gitOrThrow(["cat-file", "-t", "v0.9.0"]);
	assert.equal(
		objectType,
		"tag",
		`git cat-file -t v0.9.0 deve ritornare "tag" (tag annotato), non "commit" (lightweight).\n` +
			`Attuale: ${JSON.stringify(objectType)}.\n` +
			`Per creare un tag annotato: git tag -a v0.9.0 -m "release: v0.9.0 — <descrizione>"`,
	);
});

// ---------------------------------------------------------------------------
// Assertion 3: il tag e' pushato su origin (`git ls-remote --tags origin v0.9.0`
// ritorna lo stesso SHA del tag object locale). Per i tag annotati, l'SHA
// remoto e' quello del tag object (NON del commit puntato da ^{}).
// ---------------------------------------------------------------------------

test("git ls-remote --tags origin v0.9.0: il tag annotato e' pushato su origin", () => {
	const localTagSha = gitOrThrow(["rev-parse", "v0.9.0"]);
	const remoteListing = gitOrThrow(["ls-remote", "--tags", "origin", "v0.9.0"]);
	// Formato atteso: `<sha>\trefs/tags/v0.9.0` (singola riga, singolo tab).
	const lines = remoteListing.split("\n").filter((line) => line.length > 0);
	assert.equal(
		lines.length,
		1,
		`git ls-remote deve ritornare esattamente 1 riga per v0.9.0 (attuale: ${lines.length}).\n` +
			`Output:\n${remoteListing}`,
	);
	const [remoteSha] = lines[0].split("\t");
	assert.ok(
		typeof remoteSha === "string" && remoteSha.length === 40,
		`la riga di ls-remote deve contenere un SHA di 40 char seguito da tab + ref.\n` +
			`Riga: ${JSON.stringify(lines[0])}`,
	);
	assert.equal(
		remoteSha,
		localTagSha,
		`lo SHA remoto del tag object deve matchare quello locale.\n` +
			`Locale: ${localTagSha}\n` +
			`Remoto: ${remoteSha}\n` +
			`NOTA: per i tag annotati, ls-remote ritorna lo SHA del tag object (NON del commit puntato).\n` +
			`Se non matchano, ri-eseguire: git push origin v0.9.0`,
	);
});

// ===========================================================================
// Estensione S07 / M019: guardia di shape parallela sul tag annotato v0.10.0.
// Stessi tre invarianti della baseline v0.9.0 (locale / annotato / pushed),
// stessa meccanica execFileSync — le guardie v0.9.0 restano intatte
// (pattern M015: guardie additive per release).
// ===========================================================================

// ---------------------------------------------------------------------------
// Assertion 4: il tag locale v0.10.0 esiste (`git tag -l v0.10.0` == "v0.10.0").
// ---------------------------------------------------------------------------

test("git tag -l v0.10.0: il tag locale esiste", () => {
	const listed = gitOrThrow(["tag", "-l", "v0.10.0"]);
	assert.equal(
		listed,
		"v0.10.0",
		`git tag -l v0.10.0 deve ritornare esattamente "v0.10.0" (attuale: ${JSON.stringify(listed)})`,
	);
});

// ---------------------------------------------------------------------------
// Assertion 5: il tag v0.10.0 e' annotato (`git cat-file -t v0.10.0` == "tag",
// non "commit" — un lightweight tag sarebbe privo di tagger + messaggio).
// ---------------------------------------------------------------------------

test("git cat-file -t v0.10.0: il tag e' annotato (object-type == 'tag')", () => {
	const objectType = gitOrThrow(["cat-file", "-t", "v0.10.0"]);
	assert.equal(
		objectType,
		"tag",
		`git cat-file -t v0.10.0 deve ritornare "tag" (tag annotato), non "commit" (lightweight).\n` +
			`Attuale: ${JSON.stringify(objectType)}.\n` +
			`Per creare un tag annotato: git tag -a v0.10.0 -m "release: v0.10.0 — <descrizione>"`,
	);
});

// ---------------------------------------------------------------------------
// Assertion 6: il tag v0.10.0 e' pushato su origin (`git ls-remote --tags
// origin v0.10.0` ritorna lo stesso SHA del tag object locale, che per i tag
// annotati e' il tag object e non il commit puntato).
// ---------------------------------------------------------------------------

test("git ls-remote --tags origin v0.10.0: il tag annotato e' pushato su origin", () => {
	const localTagSha = gitOrThrow(["rev-parse", "v0.10.0"]);
	const remoteListing = gitOrThrow(["ls-remote", "--tags", "origin", "v0.10.0"]);
	// Formato atteso: `<sha>\trefs/tags/v0.10.0` (singola riga, singolo tab).
	const lines = remoteListing.split("\n").filter((line) => line.length > 0);
	assert.equal(
		lines.length,
		1,
		`git ls-remote deve ritornare esattamente 1 riga per v0.10.0 (attuale: ${lines.length}).\n` +
			`Output:\n${remoteListing}`,
	);
	const [remoteSha] = lines[0].split("\t");
	assert.ok(
		typeof remoteSha === "string" && remoteSha.length === 40,
		`la riga di ls-remote deve contenere un SHA di 40 char seguito da tab + ref.\n` +
			`Riga: ${JSON.stringify(lines[0])}`,
	);
	assert.equal(
		remoteSha,
		localTagSha,
		`lo SHA remoto del tag object deve matchare quello locale.\n` +
			`Locale: ${localTagSha}\n` +
			`Remoto: ${remoteSha}\n` +
			`NOTA: per i tag annotati, ls-remote ritorna lo SHA del tag object (NON del commit puntato).\n` +
			`Se non matchano, ri-eseguire: git push origin v0.10.0`,
	);
});

// ===========================================================================
// Estensione S08 / M019: guardia di shape parallela sul tag annotato v0.10.1
// (release riparativa packaging). Stessi tre invarianti delle baseline
// v0.9.0/v0.10.0 (locale / annotato / pushed), stessa meccanica execFileSync
// — le guardie v0.9.0/v0.10.0 restano intatte (pattern M015: guardie
// additive per release). Le guardie v0.10.1 diventano verdi SOLO dopo
// creazione+push del tag in S08/T05 (atteso, MEM400).
// ===========================================================================

// ---------------------------------------------------------------------------
// Assertion 7: il tag locale v0.10.1 esiste (`git tag -l v0.10.1` == "v0.10.1").
// ---------------------------------------------------------------------------

test("git tag -l v0.10.1: il tag locale esiste", () => {
	const listed = gitOrThrow(["tag", "-l", "v0.10.1"]);
	assert.equal(
		listed,
		"v0.10.1",
		`git tag -l v0.10.1 deve ritornare esattamente "v0.10.1" (attuale: ${JSON.stringify(listed)})`,
	);
});

// ---------------------------------------------------------------------------
// Assertion 8: il tag v0.10.1 e' annotato (`git cat-file -t v0.10.1` == "tag",
// non "commit" — un lightweight tag sarebbe privo di tagger + messaggio).
// ---------------------------------------------------------------------------

test("git cat-file -t v0.10.1: il tag e' annotato (object-type == 'tag')", () => {
	const objectType = gitOrThrow(["cat-file", "-t", "v0.10.1"]);
	assert.equal(
		objectType,
		"tag",
		`git cat-file -t v0.10.1 deve ritornare "tag" (tag annotato), non "commit" (lightweight).\n` +
			`Attuale: ${JSON.stringify(objectType)}.\n` +
			`Per creare un tag annotato: git tag -a v0.10.1 -m "release: v0.10.1 — <descrizione>"`,
	);
});

// ---------------------------------------------------------------------------
// Assertion 9: il tag v0.10.1 e' pushato su origin (`git ls-remote --tags
// origin v0.10.1` ritorna lo stesso SHA del tag object locale, che per i tag
// annotati e' il tag object e non il commit puntato).
// ---------------------------------------------------------------------------

test("git ls-remote --tags origin v0.10.1: il tag annotato e' pushato su origin", () => {
	const localTagSha = gitOrThrow(["rev-parse", "v0.10.1"]);
	const remoteListing = gitOrThrow(["ls-remote", "--tags", "origin", "v0.10.1"]);
	// Formato atteso: `<sha>\trefs/tags/v0.10.1` (singola riga, singolo tab).
	const lines = remoteListing.split("\n").filter((line) => line.length > 0);
	assert.equal(
		lines.length,
		1,
		`git ls-remote deve ritornare esattamente 1 riga per v0.10.1 (attuale: ${lines.length}).\n` +
			`Output:\n${remoteListing}`,
	);
	const [remoteSha] = lines[0].split("\t");
	assert.ok(
		typeof remoteSha === "string" && remoteSha.length === 40,
		`la riga di ls-remote deve contenere un SHA di 40 char seguito da tab + ref.\n` +
			`Riga: ${JSON.stringify(lines[0])}`,
	);
	assert.equal(
		remoteSha,
		localTagSha,
		`lo SHA remoto del tag object deve matchare quello locale.\n` +
			`Locale: ${localTagSha}\n` +
			`Remoto: ${remoteSha}\n` +
			`NOTA: per i tag annotati, ls-remote ritorna lo SHA del tag object (NON del commit puntato).\n` +
			`Se non matchano, ri-eseguire: git push origin v0.10.1`,
	);
});