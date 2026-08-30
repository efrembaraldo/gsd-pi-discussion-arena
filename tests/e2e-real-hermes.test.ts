/**
 * Test E2E real-path del dispatcher hermes (M015/S03/T03, R049 + R045 real-path).
 *
 * Pattern gated da `isHermesAvailable()` (R049) + `gsd --version` (R045): i
 * test invocano `resetHermesProbeCache()` + `isHermesAvailable()` come prima
 * riga e skippano pulito via `t.skip()` se il binario non è nel PATH. Il
 * test R045 aggiunge un secondo check su `gsd --version` perché il fallback
 * degradation si appoggia al runner `gsd` reale (non mockato); senza `gsd`
 * su PATH il fallback fallirebbe con `spawn ENOENT`. In CI runner (dove
 * né hermes né gsd sono installati globalmente) la suite skippa pulito;
 * con entrambi i binari disponibili (es. `hel-arxai`) i test eseguono il
 * flusso end-to-end di `runDiscussionArena`.
 *
 * Cosa copre:
 *  (1) E2E happy-path (R049): runDiscussionArena con participants
 *      `researcher` (engine: hermes) + `analyst` (engine: gsd) su 2 round.
 *      Asserzioni: transcript contiene `### Round 1 — researcher
 *      (Ricercatore)` con `<!-- engine: hermes -->` (R041); transcript
 *      contiene l'entry di analyst (default gsd, no marker); `totalCost >= 0`;
 *      `outcome` in {`"complete"`, `"partial"`}; nessun errore.
 *  (2) Degradation real-path (R045): stesso setup ma PATH override che
 *      rimuove `/home/opengsd/.local/bin` dal PATH (dove risiede l'eseguibile
 *      hermes reale) + `resetHermesProbeCache()` per invalidare la cache TTL
 *      30s del probe. Asserzioni: transcript contiene `<!-- engine: gsd
 *      (degradato da hermes: binario non disponibile) -->` per il researcher;
 *      analyst continua a usare gsd (nessun marker); outcome deterministico
 *      (non-error).
 *
 * Timing budget: `toolLimits.roundTimeoutMs = 90_000` (90s per turno) per
 * tollerare latenza di hermes contro LLM remoti; `rounds = 2` come da
 * piano. Total budget per test: ~60-90s su hermes reale.
 *
 * Pattern di fixture (analogo a discussion-arena-loop.test.ts): tmpdir con
 * `agent/discussion-arena/participants/*.md` (userdir-driven discovery),
 * `GSD_AGENT_DIR_ENV` punta lì. `captureStderr` silenzia i log dei limiti
 * risolti (`[discussion-arena] limits ...`) e l'eventuale warning D128 sul
 * watchdog-skip (emesso una volta per sessione da hermes-runner quando
 * `eventTimeoutMs > 0`).
 *
 * Differenza strutturale vs gli altri test E2E del repo:
 *  - Non mocka `runTurn`: usa il default `dispatchParticipantTurn` (S03/T01)
 *    che decide engine-by-engine. Quindi `runParticipantTurnViaHermes`
 *    spawna davvero `hermes -z ...` e `runParticipantTurn` spawna davvero
 *    `gsd --mode json -p ...`. Dipendenze esterne reali = hermes + gsd reali.
 *  - PATH override nel Test 2 NON sostituisce `gsd` con fake-gsd: rimuove
 *    solo `.local/bin` (dove c'è hermes) e lascia intatto il path nvm dove
 *    `gsd` reale risiede. Così `analyst` continua a girare sul runner gsd
 *    reale, verificando che il degradation path NON rompe il partner gsd.
 */

import { test, afterEach, before, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { runDiscussionArena } from "../index.js";
import {
	isHermesAvailable,
	resetHermesProbeCache,
} from "../src/hermes-readiness.js";
import { GSD_AGENT_DIR_ENV } from "./fixtures/pi-coding-agent-stub.js";

// ─── Helpers (analogo a discussion-arena-loop.test.ts:59) ─────────────────

/**
 * Scrive un participant .md minimale (name/role/description + righe extra di
 * frontmatter) in `dir`. Usato per popolare `userDir` con `researcher.md` e
 * `analyst.md` senza dipendere dal bundled (che non è esposto al discovery
 * quando GSD_AGENT_DIR punta a un tmpdir esterno). Il body è un system prompt
 * short ma sufficiente per elicitare una risposta dell'LLM reale.
 */
function writeMdParticipant(
	dir: string,
	filename: string,
	opts: {
		name: string;
		role: string;
		description?: string;
		body?: string;
		extraRows?: string[];
	},
): void {
	const rows = [
		`name: ${opts.name}`,
		`role: ${opts.role}`,
		`description: ${opts.description ?? opts.name}`,
		...(opts.extraRows ?? []),
	];
	const body =
		opts.body ??
		`Sei ${opts.name} del consiglio. Rispondi brevemente (1-3 frasi) al topic.`;
	fs.writeFileSync(
		path.join(dir, filename),
		`---\n${rows.join("\n")}\n---\n\n${body}\n`,
		"utf-8",
	);
}

interface Fixture {
	root: string;
	userDir: string;
	cwd: string;
}

/**
 * Crea un tmpdir con struttura `agent/discussion-arena/participants/` per la
 * discovery utente. Sufficiente: `cwd` resta privo di `.gsd/discussion-arena/`
 * participants/, quindi `discoverParticipants` trova SOLO i participant scritti
 * qui + eventuali bundled che NON corrispondono per nome. Cleanup in
 * `afterEach` via la lista `activeFixtures`.
 */
function makeFixture(): Fixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-e2e-real-hermes-"));
	const userDir = path.join(root, "agent", "discussion-arena", "participants");
	fs.mkdirSync(userDir, { recursive: true });
	return { root, userDir, cwd: root };
}

const activeFixtures: string[] = [];
function track(root: string): void {
	activeFixtures.push(root);
}
afterEach(() => {
	for (const root of activeFixtures.splice(0)) {
		try {
			fs.rmSync(root, { recursive: true, force: true });
		} catch {
			/* best-effort cleanup */
		}
	}
	// Ripristina sempre GSD_AGENT_DIR per non inquinare altri test della suite
	// (anche se il file viene cancellato, l'env var resta se non eliminata).
	delete process.env[GSD_AGENT_DIR_ENV];
	resetHermesProbeCache();
});

/** Silenzia `process.stderr.write` durante `fn` (log S02/S04 + warning D128). */
async function captureStderr<T>(fn: () => Promise<T>): Promise<T> {
	const original = process.stderr.write.bind(process.stderr);
	process.stderr.write = (() => true) as unknown as typeof process.stderr.write;
	try {
		return await fn();
	} finally {
		process.stderr.write = original;
	}
}

// ─── Test 1: E2E gated hermes reale (R049) ─────────────────────────────────

test("E2E real-path R049: hermes reale disponibile -> dispatch hermes esegue end-to-end", async (t) => {
	resetHermesProbeCache();
	if (!isHermesAvailable()) {
		t.skip(
			"hermes non disponibile nel PATH — test gated R049 skippato (CI senza hermes install)",
		);
		return;
	}

	const f = makeFixture();
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");

	// researcher: engine hermes, NO model/provider override (hermes usa il
	// default dal suo config.yaml: claude-sonnet-5 + anthropic). toolsets
	// ridotti per minimizzare il tempo end-to-end. round_timeout_ms ampio
	// (90s) per tollerare latenza hermes contro LLM remoti.
	writeMdParticipant(f.userDir, "researcher.md", {
		name: "researcher",
		role: "Ricercatore",
		description:
			"Indaga, raccoglie dati e cita fonti a supporto o contro le posizioni in discussione",
		extraRows: [
			"engine: hermes",
			"hermes_toolsets: web,research",
			"round_timeout_ms: 90000",
			"soft_deadline_ms: 30000",
		],
		body: "Sei il Ricercatore del consiglio. Rispondi in 1-3 frasi citando il topic.",
	});

	// analyst: engine default (gsd). Modello ereditato dal provider di default
	// di gsd (minimax-m3 via freeinference_efrem, già verificato end-to-end).
	writeMdParticipant(f.userDir, "analyst.md", {
		name: "analyst",
		role: "Business Analyst",
		description:
			"Chiarisce requisiti, obiettivi di business e vincoli prima che si discuta di soluzioni tecniche",
		extraRows: ["model: minimax/minimax-m3"],
		body: "Sei l'Analyst del consiglio. Rispondi in 1-3 frasi citando il topic.",
	});

	const topic = "tradeoffs architetturali tra dispatcher hermes e gsd in M015";

	const out = await captureStderr(() =>
		runDiscussionArena(
			topic,
			["researcher", "analyst"],
			2,
			f.cwd,
			undefined, // signal
			() => {}, // onProgress (no-op: il transcript finale ci basta)
			undefined, // onRoundComplete
			undefined, // continuation
			undefined, // modelOverride
			{ roundTimeoutMs: 90_000 }, // toolLimits (ampio per hermes)
			undefined, // runTurn (default: dispatchParticipantTurn)
			false, // eventLog
		),
	);

	// ── Asserzioni R049 ──────────────────────────────────────────────────
	// Transcript non vuoto: la run deve aver prodotto almeno 2 entry
	// (researcher + analyst al round 1).
	assert.ok(
		out.transcript.length > 0,
		`transcript non deve essere vuoto; got: '${out.transcript.slice(0, 200)}'`,
	);

	// Entry del round 1 per researcher con marker hermes (R041).
	assert.ok(
		out.transcript.includes("### Round 1 — researcher (Ricercatore)"),
		`transcript deve contenere entry Round 1 researcher; got: '${out.transcript.slice(0, 800)}'`,
	);
	assert.ok(
		out.transcript.includes("<!-- engine: hermes -->"),
		`transcript deve contenere marker engine hermes per researcher (R041); got: '${out.transcript.slice(0, 1200)}'`,
	);

	// Entry del round 1 per analyst (default gsd, no marker).
	assert.ok(
		out.transcript.includes("### Round 1 — analyst (Business Analyst)"),
		`transcript deve contenere entry Round 1 analyst; got: '${out.transcript.slice(0, 800)}'`,
	);
	// analyst NON deve avere marker engine (engine undefined -> retrocompat
	// pre-S03): il marker engine si applica SOLO a engine === "hermes" via
	// dispatcher, e l'engineMarker è assente per engine "gsd"/undefined.
	// Nessuna entry analyst deve contenere `<!-- engine:` per assenza marker.
	const analystSection =
		out.transcript.split("### Round 1 — analyst (Business Analyst)")[1] ?? "";
	const analystRound1Section = analystSection.split("###")[0] ?? "";
	assert.ok(
		!analystRound1Section.includes("<!-- engine:"),
		`analyst (engine undefined) non deve avere engine marker; got section: '${analystRound1Section.slice(0, 400)}'`,
	);

	// totalCost >= 0 (R049: usage potrebbe essere 0 se hermes restituisce
	// usage vuoto — assertion non-negativa, non positivo).
	assert.ok(
		out.totalCost >= 0,
		`totalCost deve essere >= 0; got ${out.totalCost}`,
	);

	// outcome in {complete, partial}. "error" non è un valore del return type
	// di runDiscussionArena (è solo "complete" o "partial"), ma rendiamo la
	// assertion type-safe ed esplicita.
	assert.ok(
		out.outcome === "complete" || out.outcome === "partial",
		`outcome deve essere 'complete' o 'partial'; got '${out.outcome}'`,
	);

	// participantsUsed: deve contenere entrambi i nomi richiesti.
	assert.deepEqual(
		[...out.participantsUsed].sort(),
		["analyst", "researcher"],
		`participantsUsed deve contenere entrambi; got ${JSON.stringify(out.participantsUsed)}`,
	);
});

// ─── Test 2: Degradation R045 (hermes rimosso dal PATH) ─────────────────────

test("E2E real-path R045: hermes rimosso dal PATH -> dispatch degrada a gsd con marker 'degradato da hermes'", async (t) => {
	// PATH override: rimuoviamo `.local/bin` (dove risiede hermes) preservando
	// `gsd` reale (che vive in nvm bin `/home/opengsd/.nvm/.../bin`). Così
	// `analyst` continua a usare gsd reale mentre `researcher` (engine hermes)
	// non trova il binario e cade sul fallback `runParticipantTurn` con marker
	// di degradazione. Cache invalidata PRIMA del probe.
	const originalPath = process.env.PATH;
	const pathSep = path.delimiter;
	const pathDirs = (originalPath ?? "").split(pathSep).filter(Boolean);
	const filteredDirs = pathDirs.filter(
		(p) => !p.includes(".local/bin") && !p.includes("/.local/bin"),
	);
	process.env.PATH = filteredDirs.join(pathSep);
	resetHermesProbeCache();

	try {
		if (isHermesAvailable()) {
			// Sanity check: dopo PATH override la cache invalidata e il nuovo
			// PATH non contengono hermes. Se invece hermes è ancora disponibile,
			// l'ambiente è invalido per questo test (es. hermes installato in
			// un path NON-.local). Skip esplicito per evitare falsi positivi.
			t.skip(
				"hermes ancora disponibile dopo override PATH — environment non adatto al test degradation R045",
			);
			return;
		}
		// Il fallback di questo test si appoggia sul binario `gsd` reale (non
		// mockato — vedi commento di testa del file). Se `gsd` non è sul PATH
		// (es. runner CI che non lo installa globalmente in questo job), il
		// fallback fallisce con spawn ENOENT indipendentemente da hermes.
		try {
			execFileSync("gsd", ["--version"], { stdio: "ignore" });
		} catch {
			t.skip(
				"gsd non disponibile nel PATH — test gated skippato (CI senza gsd install)",
			);
			return;
		}

		const f = makeFixture();
		track(f.root);
		process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");

		writeMdParticipant(f.userDir, "researcher.md", {
			name: "researcher",
			role: "Ricercatore",
			description:
				"Indaga, raccoglie dati e cita fonti a supporto o contro le posizioni in discussione",
			extraRows: [
				"engine: hermes",
				"hermes_toolsets: web,research",
				"round_timeout_ms: 90000",
				"soft_deadline_ms: 30000",
			],
			body: "Sei il Ricercatore del consiglio. Rispondi in 1-3 frasi citando il topic.",
		});
		writeMdParticipant(f.userDir, "analyst.md", {
			name: "analyst",
			role: "Business Analyst",
			description:
				"Chiarisce requisiti, obiettivi di business e vincoli prima che si discuta di soluzioni tecniche",
			extraRows: ["model: minimax/minimax-m3"],
			body: "Sei l'Analyst del consiglio. Rispondi in 1-3 frasi citando il topic.",
		});

		const topic = "degradation path: cosa succede quando hermes non c'è";

		const out = await captureStderr(() =>
			runDiscussionArena(
				topic,
				["researcher", "analyst"],
				2,
				f.cwd,
				undefined,
				() => {},
				undefined,
				undefined,
				undefined,
				{ roundTimeoutMs: 90_000 },
				undefined,
				false,
			),
		);

		// ── Asserzioni R045 ───────────────────────────────────────────────
		// Transcript non vuoto: anche col degradation, il fallback `gsd` ha
		// eseguito researcher. Verifichiamo sia l'entry sia il marker.
		assert.ok(
			out.transcript.length > 0,
			`transcript non deve essere vuoto; got: '${out.transcript.slice(0, 200)}'`,
		);

		// Entry researcher Round 1 (caduta su gsd con marker degradation).
		assert.ok(
			out.transcript.includes("### Round 1 — researcher (Ricercatore)"),
			`transcript deve contenere entry Round 1 researcher (caduta su gsd); got: '${out.transcript.slice(0, 800)}'`,
		);

		// Marker degradation (R045) — verifica LESSICALE ESATTA: il marker è
		// una stringa cablata nel dispatcher e iniettata verbatim nel
		// transcript. Qualsiasi drift è una regressione del dispatcher.
		assert.ok(
			out.transcript.includes(
				"<!-- engine: gsd (degradato da hermes: binario non disponibile) -->",
			),
			`transcript deve contenere marker degradation R045 per researcher; got: '${out.transcript.slice(0, 1200)}'`,
		);

		// Negative assertion: il marker hermes NON deve essere presente
		// (hermes non è stato eseguito, quindi niente `<!-- engine: hermes -->`).
		assert.ok(
			!out.transcript.includes("<!-- engine: hermes -->"),
			`transcript NON deve contenere marker hermes (engine non eseguito); got: '${out.transcript.slice(0, 1200)}'`,
		);

		// Entry analyst Round 1 (engine default gsd, mai degradation: il
		// degradation marker si applica SOLO se engine === "hermes" e binario
		// mancante).
		assert.ok(
			out.transcript.includes("### Round 1 — analyst (Business Analyst)"),
			`transcript deve contenere entry Round 1 analyst; got: '${out.transcript.slice(0, 800)}'`,
		);

		// totalCost >= 0 (gsd reale produce usage valorizzato, hermes-degradato
		// usa gsd real-path quindi usage popolato).
		assert.ok(
			out.totalCost >= 0,
			`totalCost deve essere >= 0; got ${out.totalCost}`,
		);

		// Outcome deterministico (non-error): "complete" o "partial". Nessun
		// crash perché il degradation path instrada correttamente su gsd.
		assert.ok(
			out.outcome === "complete" || out.outcome === "partial",
			`outcome deve essere 'complete' o 'partial'; got '${out.outcome}'`,
		);
	} finally {
		// Ripristina PATH originale + cache (best-effort anche su fail).
		process.env.PATH = originalPath;
		resetHermesProbeCache();
	}
});

// ─── Header metadata: assicura che `before`/`after` siano import-callable ──
// (Node:test richiede import statici; questo no-op aiuta il module resolver
// a mantenere l'ordine di valutazione rispetto agli altri test della suite.)
before(() => {
	/* suite-level setup hook (vuoto: ogni test gestisce il proprio PATH) */
});
after(() => {
	/* suite-level teardown hook (cleanup gestito da afterEach) */
});
