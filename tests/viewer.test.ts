/**
 * Test del modulo puro viewer.ts (M018/S06/T01 — renderViewer + escapeHtml +
 * discussionArenaViewPath).
 *
 * 6 scenari canonici (piano T01):
 *
 *   1. struttura: fixture eventi in-memory (discussion_arena_start +
 *      participant_message su 2 round + round_end + discussion_arena_done)
 *      → output contiene DOCTYPE, <html lang="en">, <head>, <style>,
 *      <body>, <main>, un <article class="round"> per round, chiusura
 *      </html>; il path view è `<cwd>/.gsd/discussion-arena/views/<id>.html`.
 *   2. XSS: testo partecipante con `<script>alert(1)</script>` → presente
 *      come `&lt;script&gt;`, MAI letterale; doppi apici escapati in
 *      attributo/header.
 *   3. zero asset esterni: nessun `<script`, nessun `<link`, nessun
 *      `src=`, nessuna occorrenza di `http://` o `https://`.
 *   4. decision box: round con blocco ```decision ben formato →
 *      decision-box con JSON parsed escaped; malformato → decision-error
 *      visibile; assente → nessun decision-box per quel round.
 *   5. dark mode: `<style>` contiene `prefers-color-scheme`.
 *   6. determinismo: due chiamate renderViewer(stessi eventi) → stringa
 *      identica.
 *
 * Layer I/O (M018/S06/T02) — scenari 7-10, TUTTE le fixture su tmp dir
 * (nessun percorso .gsd/ reale):
 *
 *   7. runViewer con id invalido (`"abc"`) → {ok:false}, messaggio
 *      `invalid replay id format`, nessun file scritto.
 *   8. runViewer con id hex32 valido ma log assente su tmp dir →
 *      {ok:false}, messaggio `event log not found or empty`.
 *   9. integration happy path: event log JSONL reale scritto nella tmp
 *      dir (righe JSON dirette, pattern replay.test.ts scenario 4) →
 *      {ok:true}, file esiste al path atteso con gli article attesi.
 *  10. idempotenza: due runViewer consecutivi stesso id → contenuto file
 *      byte-identico (renderViewer pura: nessuna dipendenza dal clock).
 *
 * Self-sufficiency: registra gli hook ESM (`.js` -> `.ts` + stub
 * `@gsd/pi-coding-agent`) anche quando il file gira sotto `node --test`
 * senza `--import ./tests/ts-esm-loader.mjs` (pattern tests/replay.test.ts).
 * Scenari 1-6 in-memory; scenari 7-10 solo su directory temporanee.
 */

// Self-sufficiency: registra gli hook ESM (pattern replay.test.ts:43).
import "./ts-esm-loader.mjs";
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";

import {
	discussionArenaViewPath,
	escapeHtml,
	renderViewer,
	runViewer,
	writeViewer,
} from "../viewer.js";
import { discussionArenaEventLogPath } from "../replay.js";
import type { DiscussionArenaEvent } from "../helpers.js";

// ─── Fixture in-memory (shape di helpers.ts:86) ─────────────────────────────

/** Evento base con ts fisso (nessun clock: il determinismo è parte del contratto). */
function makeEvent(type: string, extra: Record<string, unknown> = {}): DiscussionArenaEvent {
	return { ts: "2026-01-01T00:00:00.000Z", type, ...extra };
}

/** Event log minimo su 2 round: start, 2 messaggi, round_end, done. */
function makeTwoRoundEvents(): DiscussionArenaEvent[] {
	return [
		makeEvent("discussion_arena_start", { discussionArenaId: "a".repeat(32) }),
		makeEvent("participant_message", {
			round: 1,
			participantId: "analyst",
			text: "Round one analysis.",
		}),
		makeEvent("round_end", { round: 1 }),
		makeEvent("participant_message", {
			round: 2,
			participantId: "critic",
			text: "Round two critique.",
		}),
		makeEvent("round_end", { round: 2 }),
		makeEvent("discussion_arena_done", { outcome: "consensus" }),
	];
}

// ─── Scenario 1: struttura documento + path canonico ────────────────────────

test("renderViewer: struttura documento standalone e un article per round", () => {
	const html = renderViewer(makeTwoRoundEvents());

	assert.ok(html.startsWith("<!DOCTYPE html>"), "manca il DOCTYPE iniziale");
	for (const expected of [
		'<html lang="en">',
		"<head>",
		'<meta charset="utf-8">',
		"<style>",
		"</style>",
		"</head>",
		"<body>",
		"<main>",
		"</main>",
		"</body>",
		"</html>",
	]) {
		assert.ok(html.includes(expected), `manca l'elemento atteso: ${expected}`);
	}
	// Un article per round del transcript ricostruito (2 messaggi su 2 round).
	const articles = html.split('<article class="round">').length - 1;
	assert.equal(articles, 2, `article attesi 2, trovati ${articles}`);
	assert.ok(html.endsWith("</html>"), "il documento non chiude con </html>");
	// Titolo derivato dai dati, non dal clock.
	assert.ok(
		html.includes(`<title>Discussion Arena ${"a".repeat(32)}</title>`),
		"title non derivato dal discussionArenaId dell'evento start",
	);
});

test("discussionArenaViewPath: path canonico <cwd>/.gsd/discussion-arena/views/<id>.html", () => {
	const p = discussionArenaViewPath("/tmp/cwd", "abc123");
	assert.equal(
		p,
		path.join("/tmp/cwd", ".gsd", "discussion-arena", "views", "abc123.html"),
	);
});

// ─── Scenario 2: XSS ─────────────────────────────────────────────────────────

test("renderViewer: il testo partecipante con tag script viene escapato (no XSS)", () => {
	const events: DiscussionArenaEvent[] = [
		makeEvent("discussion_arena_start", { discussionArenaId: "b".repeat(32) }),
		makeEvent("participant_message", {
			round: 1,
			participantId: 'evil"onload="x',
			text: "<script>alert(1)</script> and \"quoted\" text",
		}),
	];
	const html = renderViewer(events);

	assert.ok(
		html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"),
		"lo script non risulta escapato",
	);
	assert.ok(
		!html.includes("<script>alert(1)"),
		"trovato uno script letterale non escapato nel documento",
	);
	// Doppi apici escapati (attributi e header partecipante).
	assert.ok(html.includes("&quot;quoted&quot;"), `doppi apici non escapati nel testo`);
	assert.ok(
		html.includes('evil&quot;onload=&quot;x'),
		"doppi apici non escapati nel participantId (header round)",
	);
	// escapeHtml unitaria: ordine & per primo, niente doppio escaping.
	assert.equal(escapeHtml(`&lt;`), "&amp;lt;");
	assert.equal(escapeHtml(`a<b>"c"'d'&e`), "a&lt;b&gt;&quot;c&quot;&#39;d&#39;&amp;e");
});

// ─── Scenario 3: zero asset esterni ─────────────────────────────────────────

test("renderViewer: zero asset esterni (no script/link/src/URL assoluti)", () => {
	const html = renderViewer(makeTwoRoundEvents());

	assert.ok(!html.includes("<script"), "trovato un tag <script>");
	assert.ok(!html.includes("<link"), "trovato un tag <link>");
	assert.ok(!html.includes("src="), "trovato un attributo src=");
	assert.ok(!html.includes("http://"), "trovato un URL http://");
	assert.ok(!html.includes("https://"), "trovato un URL https://");
});

// ─── Scenario 4: decision box ────────────────────────────────────────────────

test("renderViewer: decision-box per blocco decision ben formato, decision-error per malformato, nulla se assente", () => {
	const goodDecision = '```decision\n{"choice": "option-a", "confidence": 0.9}\n```';
	const badDecision = "```decision\n{not-json\n```";
	const events: DiscussionArenaEvent[] = [
		makeEvent("discussion_arena_start", { discussionArenaId: "c".repeat(32) }),
		// Round 1: decision ben formattata.
		makeEvent("participant_message", {
			round: 1,
			participantId: "analyst",
			text: `Analisi.\n${goodDecision}`,
		}),
		// Round 2: decision malformata.
		makeEvent("participant_message", {
			round: 2,
			participantId: "critic",
			text: `Critica.\n${badDecision}`,
		}),
		// Round 3: nessuna decision.
		makeEvent("participant_message", {
			round: 3,
			participantId: "observer",
			text: "Osservazione senza decisione.",
		}),
	];
	const html = renderViewer(events);

	// 3 round renderizzati.
	const articles = html.split('<article class="round">').length - 1;
	assert.equal(articles, 3, `article attesi 3, trovati ${articles}`);

	// Round 1: JSON parsed, pretty-printed ed escaped nel decision-box.
	assert.ok(html.includes('<div class="decision-box">'), "decision-box assente");
	assert.ok(
		html.includes("&quot;choice&quot;: &quot;option-a&quot;"),
		"JSON parsed non presente (escaped) nel decision-box",
	);
	// Un fixture con SOLO la decisione valida non produce alcun paragrafo di
	// errore renderizzato (l'asserzione usa l'elemento <p>, non la stringa
	// della classe, che compare comunque nel selettore CSS embedded).
	const goodOnly = renderViewer([
		makeEvent("discussion_arena_start", { discussionArenaId: "c".repeat(32) }),
		makeEvent("participant_message", {
			round: 1,
			participantId: "analyst",
			text: `Analisi.\n${goodDecision}`,
		}),
	]);
	assert.ok(
		!goodOnly.includes('<p class="decision-error">'),
		"decision-error non atteso con payload valido",
	);

	// Round 2: parseError visibile, rawText escaped.
	assert.ok(
		html.includes("Decision parse error:"),
		"decision-error non visibile per payload malformato",
	);
	assert.ok(
		html.includes("{not-json"),
		"rawText del blocco malformato non presente nel decision-box",
	);

	// Round 3: esattamente 2 decision-box (solo round 1 e 2).
	const boxes = html.split('<div class="decision-box">').length - 1;
	assert.equal(boxes, 2, `decision-box attesi 2, trovati ${boxes}`);
});

// ─── Scenario 5: dark mode ───────────────────────────────────────────────────

test("renderViewer: lo style inline contiene prefers-color-scheme (dark mode)", () => {
	const html = renderViewer(makeTwoRoundEvents());
	assert.ok(
		html.includes("prefers-color-scheme"),
		"manca la media query prefers-color-scheme nello style inline",
	);
});

// ─── Scenario 6: determinismo ────────────────────────────────────────────────

test("renderViewer: due chiamate con gli stessi eventi producono la stessa stringa", () => {
	const events = makeTwoRoundEvents();
	const a = renderViewer(events);
	const b = renderViewer(events);
	assert.equal(a, b, "renderViewer non è deterministico su input identico");
	// Anche con eventi separati ma di contenuto identico (nessuno stato nascosto).
	const c = renderViewer(makeTwoRoundEvents());
	assert.equal(a, c, "renderViewer dipende da stato esterno all'input");
});

// ─── Scenari 7-10: layer I/O runViewer/writeViewer (M018/S06/T02) ───────────

/** Tmp dir isolata per i test I/O (pattern createTmpDir in replay.test.ts). */
async function createTmpDir(): Promise<string> {
	return await fsPromises.mkdtemp(path.join(os.tmpdir(), "gsd-viewer-"));
}

/** Scrive un event log JSONL reale nella tmp dir (pattern replay.test.ts scenario 4). */
function writeEventLog(cwd: string, id: string, events: DiscussionArenaEvent[]): string {
	const logPath = discussionArenaEventLogPath(cwd, id);
	fs.mkdirSync(path.dirname(logPath), { recursive: true });
	fs.writeFileSync(
		logPath,
		events.map((ev) => JSON.stringify(ev)).join("\n") + "\n",
		"utf-8",
	);
	return logPath;
}

test("runViewer con id invalido: {ok:false} 'invalid replay id format', nessun file scritto (T02 scenario 7)", async () => {
	const cwd = await createTmpDir();
	try {
		const result = await runViewer(cwd, "abc");

		assert.equal(result.ok, false, "result atteso {ok:false} per id invalido");
		assert.ok(
			!result.ok && result.error.includes("invalid replay id format: abc"),
			`messaggio atteso 'invalid replay id format: abc'. ottenuto=${!result.ok ? result.error : JSON.stringify(result)}`,
		);
		// Short-circuit PRIMA di qualsiasi I/O: né la directory views/ né il
		// file di view vengono creati.
		assert.ok(
			!fs.existsSync(discussionArenaViewPath(cwd, "abc")),
			"nessun file di view scritto per id invalido",
		);
		assert.ok(
			!fs.existsSync(path.join(cwd, ".gsd", "discussion-arena", "views")),
			"directory views/ non creata per id invalido",
		);
	} finally {
		await fsPromises.rm(cwd, { recursive: true, force: true });
	}
});

test("runViewer con log assente: {ok:false} 'event log not found or empty' su tmp dir (T02 scenario 8)", async () => {
	const cwd = await createTmpDir();
	try {
		const validHexId = crypto.randomBytes(16).toString("hex");
		assert.equal(validHexId.length, 32, `ID hex32 valido: ${validHexId}`);

		const result = await runViewer(cwd, validHexId);

		assert.equal(result.ok, false, "result atteso {ok:false} per log assente");
		assert.ok(
			!result.ok && result.error.includes(`event log not found or empty: ${validHexId}`),
			`messaggio atteso 'event log not found or empty: <id>'. ottenuto=${!result.ok ? result.error : JSON.stringify(result)}`,
		);
		assert.ok(
			!fs.existsSync(discussionArenaViewPath(cwd, validHexId)),
			"nessun file di view scritto quando il log è assente",
		);
	} finally {
		await fsPromises.rm(cwd, { recursive: true, force: true });
	}
});

test("runViewer happy path integration: log JSONL reale → {ok:true}, file view al path atteso con gli article attesi (T02 scenario 9)", async () => {
	const cwd = await createTmpDir();
	try {
		const id = crypto.randomBytes(16).toString("hex");
		writeEventLog(cwd, id, makeTwoRoundEvents());

		const result = await runViewer(cwd, id);

		assert.ok(result.ok, `result atteso {ok:true}. ottenuto=${JSON.stringify(result)}`);
		if (!result.ok) return; // narrowing per il typechecker
		const expectedPath = discussionArenaViewPath(cwd, id);
		assert.equal(
			result.path,
			expectedPath,
			`path ritornato === path canonico della view. atteso=${expectedPath}`,
		);
		assert.ok(fs.existsSync(expectedPath), "il file view esiste su disco");

		const html = fs.readFileSync(expectedPath, "utf-8");
		assert.ok(html.startsWith("<!DOCTYPE html>"), "documento standalone dal disco");
		const articles = html.split('<article class="round">').length - 1;
		assert.equal(articles, 2, `article attesi 2 (2 round del log). trovati=${articles}`);
		assert.ok(html.includes("Round one analysis."), "testo round 1 presente");
		assert.ok(html.includes("Round two critique."), "testo round 2 presente");
	} finally {
		await fsPromises.rm(cwd, { recursive: true, force: true });
	}
});

test("runViewer idempotenza: due run consecutivi stesso id → contenuto file byte-identico (T02 scenario 10)", async () => {
	const cwd = await createTmpDir();
	try {
		const id = crypto.randomBytes(16).toString("hex");
		writeEventLog(cwd, id, makeTwoRoundEvents());
		const viewPath = discussionArenaViewPath(cwd, id);

		const first = await runViewer(cwd, id);
		assert.ok(first.ok, `prima run {ok:true}. ottenuto=${JSON.stringify(first)}`);
		const firstContent = fs.readFileSync(viewPath, "utf-8");

		const second = await runViewer(cwd, id);
		assert.ok(second.ok, `seconda run {ok:true}. ottenuto=${JSON.stringify(second)}`);
		if (!first.ok || !second.ok) return; // narrowing per il typechecker
		assert.equal(second.path, first.path, "stesso path su run ripetute");

		const secondContent = fs.readFileSync(viewPath, "utf-8");
		assert.equal(
			secondContent,
			firstContent,
			"contenuto file byte-identico tra run consecutive (nessuna dipendenza dal clock)",
		);
		// Il file NON cresce: sovrascrittura, non append.
		assert.equal(
			secondContent.length,
			firstContent.length,
			"lunghezza invariata (nessun append)",
		);
	} finally {
		await fsPromises.rm(cwd, { recursive: true, force: true });
	}
});

// ─── Edge I/O: writeViewer crea la directory views/ ricorsivamente ──────────

test("writeViewer: mkdir ricorsivo della directory views/ assente e ritorno del path scritto (T02)", async () => {
	const cwd = await createTmpDir();
	try {
		const id = "e".repeat(32);
		const html = renderViewer(makeTwoRoundEvents());
		const returned = await writeViewer(cwd, id, html);
		const expected = discussionArenaViewPath(cwd, id);
		assert.equal(returned, expected, "path ritornato === path canonico");
		assert.ok(fs.existsSync(expected), "file scritto su disco");
		assert.equal(
			fs.readFileSync(expected, "utf-8"),
			html,
			"contenuto file === html passato",
		);
	} finally {
		await fsPromises.rm(cwd, { recursive: true, force: true });
	}
});

// ─── Edge: event log senza round nel transcript ──────────────────────────────

test("renderViewer: eventi solo strutturali → documento valido senza article (empty state)", () => {
	const html = renderViewer([
		makeEvent("discussion_arena_start", { discussionArenaId: "d".repeat(32) }),
		makeEvent("round_end", { round: 1 }),
		makeEvent("discussion_arena_done", { outcome: "unknown" }),
	]);
	assert.ok(html.startsWith("<!DOCTYPE html>"));
	assert.ok(html.endsWith("</html>"));
	const articles = html.split('<article class="round">').length - 1;
	assert.equal(articles, 0);
});
