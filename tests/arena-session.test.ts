/**
 * Test unitari per arena-session.ts:
 *   - topicSlug: normalizzazione topic in nome file
 *   - cwdHashShort: hash breve cwd (8 char hex)
 *   - getSessionFilePath: path completo sessione
 *   - saveSession/loadSession round-trip (con tmpdir)
 *   - loadSession ritorna null per file inesistente
 *
 * Nessuna chiamata a getAgentDir reale: i path sono costruiti passando un
 * tmpdir esplicito come agentDir, così i test sono isolati e parallelizzabili.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	topicSlug,
	cwdHashShort,
	getSessionFilePath,
	loadSession,
	saveSession,
	type ArenaSession,
} from "../arena-session.js";

test("topicSlug: lowercase, alfanumerici+dash, max 50 char", () => {
	assert.equal(topicSlug("Convenienza Sviluppo AI"), "convenienza-sviluppo-ai");
	assert.equal(topicSlug("café & résumé"), "caf-r-sum");
	assert.equal(topicSlug("!!!"), "untitled", "string vuoto dopo normalizzazione -> fallback 'untitled'");
	assert.equal(topicSlug("a".repeat(100)).length, 50, "tronca a 50 char");
	assert.equal(topicSlug(""), "untitled", "string vuoto -> 'untitled'");
});

test("topicSlug: separatori consecutivi collassano in un singolo dash", () => {
	assert.equal(topicSlug("a   b"), "a-b", "spazi multipli collassano");
	assert.equal(topicSlug("a---b"), "a-b", "dash consecutivi collassano");
	assert.equal(topicSlug("  a  "), "a", "trim leading/trailing dash");
});

test("cwdHashShort: 8 char hex, deterministico, cwd-diverso -> hash-diverso", () => {
	const a = cwdHashShort("/tmp/foo");
	const b = cwdHashShort("/tmp/bar");
	assert.equal(a.length, 8, "8 char");
	assert.match(a, /^[0-9a-f]{8}$/, "solo hex");
	assert.equal(cwdHashShort("/tmp/foo"), a, "deterministico");
	assert.notEqual(a, b, "cwd diversi -> hash diversi");
});

test("getSessionFilePath: <agentDir>/arena/sessions/<cwdHash>-<slug>.md", () => {
	const p = getSessionFilePath("/agent/root", "/cwd/test", "Titolo del Tema");
	const expectedHash = cwdHashShort("/cwd/test");
	const expectedSlug = topicSlug("Titolo del Tema");
	assert.equal(p, path.join("/agent/root", "arena", "sessions", `${expectedHash}-${expectedSlug}.md`));
});

test("saveSession + loadSession: round-trip preserva tutti i campi", async () => {
	const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "gsd-arena-session-"));
	const filePath = path.join(tmp, "session.md");
	const original: ArenaSession = {
		topic: "Test topic",
		participants: ["analyst", "architect", "dev"],
		startedAt: "2026-08-01T10:00:00.000Z",
		lastUpdatedAt: "2026-08-01T10:05:00.000Z",
		rounds: 2,
		transcript: "### Round 1 — analyst\nprima risposta\n\n### Round 2 — architect\nseconda risposta",
	};
	await saveSession(filePath, original);
	const loaded = await loadSession(filePath);
	assert.ok(loaded, "session caricata");
	assert.deepEqual(loaded, original);
	await fs.rm(tmp, { recursive: true, force: true });
});

test("loadSession: ritorna null per path inesistente (no throw)", async () => {
	const loaded = await loadSession("/non/esiste/session.md");
	assert.equal(loaded, null);
});

test("loadSession: ritorna null per file malformato (no frontmatter)", async () => {
	const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "gsd-arena-session-bad-"));
	const filePath = path.join(tmp, "bad.md");
	await fs.writeFile(filePath, "non è un frontmatter valido\n", "utf-8");
	const loaded = await loadSession(filePath);
	assert.equal(loaded, null);
	await fs.rm(tmp, { recursive: true, force: true });
});

test("saveSession: crea directory se manca", async () => {
	const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "gsd-arena-session-mkdir-"));
	const deepPath = path.join(tmp, "nested", "dir", "session.md");
	await saveSession(deepPath, {
		topic: "x",
		participants: [],
		startedAt: "2026-01-01T00:00:00.000Z",
		lastUpdatedAt: "2026-01-01T00:00:00.000Z",
		rounds: 1,
		transcript: "### Round 1 — a\ntest",
	});
	const stat = await fs.stat(deepPath);
	assert.ok(stat.isFile());
	await fs.rm(tmp, { recursive: true, force: true });
});
