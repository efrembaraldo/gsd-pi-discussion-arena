/**
 * Test di parity per `src/agent-dir.ts` (M017/S02/T01).
 *
 * Scopo: garantire che l'estrazione di `resolveAgentDir` in TS (D138, source
 * of truth TS) resti semanticamente IDENTICA alla copia locale di 5 righe
 * in `scripts/copy-template.mjs` (CLI postinstall). Il test di parity è la
 * guardia anti-drift richiesta da D138 — se un futuro refactor diverge, il
 * test fallisce prima del merge.
 *
 * Copertura (5 test, esattamente quanto specificato dal task plan):
 *   1. `resolveAgentDir` con `env.GSD_AGENT_DIR` settato ritorna verbatim.
 *   2. `resolveAgentDir` con `env.GSD_AGENT_DIR` vuoto cade al default.
 *   3. `resolveAgentDir` con `env.GSD_AGENT_DIR` assente cade al default.
 *   4. Parità 1:1 con `scripts/copy-template.mjs` su una matrice di env
 *      (incluso casi con spazi / path relativi per robustezza).
 *   5. Snapshot del valore canonico di DISCUSSION_ARENA_USER_COORDINATION_RELATIVE_PATH.
 *
 * Pattern di import:
 *   - `import "./ts-esm-loader.mjs"` come side-effect statico: registra gli
 *     hook ESM (D019) che rimappano `src/xxx.js` -> `src/xxx.ts` nei test
 *     (pattern speculare a `tests/parse-discussion-arena-block.test.ts:23`).
 *   - `import { resolveAgentDir as resolveAgentDirMjs } from
 *     "../scripts/copy-template.mjs"`: statico, perché il file `.mjs` esiste
 *     realmente (l'hook non interferisce con `.mjs` reali).
 *   - `await import("../src/agent-dir.js")`: dynamic, perché il `.ts` viene
 *     risolto solo dopo che gli hook sono registrati.
 *
 * Vincoli di test:
 *   - Nessuna mutazione di `process.env` globale: ogni chiamata riceve un
 *     env object esplicito, così il test è isolato e parallelizzabile.
 *   - Default path derivato runtime via `os.homedir()` + `path.join` —
 *     stessa composizione usata dagli helper sotto test, quindi la parità
 *     è deterministica cross-OS (Windows path.sep gestito da path.join).
 *   - Zero dipendenze npm (D004): solo `node:os`, `node:path`, `node:test`,
 *     `node:assert/strict`.
 */

import "./ts-esm-loader.mjs";
import * as assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveAgentDir as resolveAgentDirMjs } from "../scripts/copy-template.mjs";

const { resolveAgentDir, DISCUSSION_ARENA_USER_COORDINATION_RELATIVE_PATH } =
	await import("../src/agent-dir.js");

/** Path default canonico (D137): `<homedir>/.gsd/agent`. */
const defaultPath = join(homedir(), ".gsd", "agent");

test("resolveAgentDir con env.GSD_AGENT_DIR settato ritorna env.GSD_AGENT_DIR verbatim", () => {
	const override = "/tmp/custom-agent-dir-xyz";
	assert.equal(resolveAgentDir({ GSD_AGENT_DIR: override }), override);
});

test("resolveAgentDir con env.GSD_AGENT_DIR vuoto ritorna $HOME/.gsd/agent", () => {
	assert.equal(resolveAgentDir({ GSD_AGENT_DIR: "" }), defaultPath);
});

test("resolveAgentDir con env.GSD_AGENT_DIR assente ritorna $HOME/.gsd/agent", () => {
	// Equivalente a `delete process.env.GSD_AGENT_DIR` ma isolato (no mutazione
	// globale): la chiave semplicemente non è presente sull'oggetto env.
	assert.equal(resolveAgentDir({}), defaultPath);
});

test("parità 1:1 con scripts/copy-template.mjs su matrice di env (guardia anti-drift D138)", () => {
	const cases: NodeJS.ProcessEnv[] = [
		{},
		{ GSD_AGENT_DIR: "/tmp/x" },
		{ GSD_AGENT_DIR: "" },
		{ GSD_AGENT_DIR: "/some/path/with spaces/and-dashes" },
		{ GSD_AGENT_DIR: "/relative/path" },
	];
	for (const env of cases) {
		assert.equal(
			resolveAgentDir(env),
			resolveAgentDirMjs(env),
			`parità rotta per env=${JSON.stringify(env)}`,
		);
	}
});

test("DISCUSSION_ARENA_USER_COORDINATION_RELATIVE_PATH snapshot canonico", () => {
	assert.equal(
		DISCUSSION_ARENA_USER_COORDINATION_RELATIVE_PATH,
		"discussion-arena/discussion-arena-coordination.md",
	);
});
