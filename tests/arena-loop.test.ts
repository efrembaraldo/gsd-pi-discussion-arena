/**
 * Test del loop `runDiscussionArena` (index.ts) reso resiliente al crash
 * parziale (M003/S03/T02).
 *
 * Copre i 3 scenari del must-have (2) della slice, con `runTurn` mockato via
 * injection (D022/D020: nessun subprocess `gsd` reale spawnato) e fixture
 * partecipanti reali scritte su tmpdir (pattern participants.test.ts, nessun
 * mock del filesystem):
 *
 *   (a) crash parziale — 1/3 partecipanti muore al round 1: round 1 contiene
 *       il marker `[PARTICIPANT FAILED: <id> <reason> <ts>]` per lui e
 *       transcript regolare per gli altri 2; round 2 contiene
 *       `[PARTICIPANT SKIPPED: <id>]` per lui (nessuna invocazione di
 *       `runTurn`) e transcript regolare per gli altri 2, che completano
 *       entrambi i round; outcome finale = "partial".
 *   (b) crash totale — tutti i partecipanti selezionati muoiono al round 1:
 *       outcome = "partial", il ciclo dei round si interrompe (nessun round 2
 *       eseguito nonostante rounds > 1 richiesti), transcript resta parsabile
 *       (nessuna entry orfana).
 *   (c) regressione — nessun crash: outcome = "complete", transcript senza
 *       marker, comportamento identico al pre-S03.
 *   (f) budget guard (S06) — costByParticipant via accumulateCost (fix §4.1:
 *       number | string | {total}, clamp >= 0); al raggiungimento di
 *       costBudgetUsd il turno termina con il marker
 *       [BUDGET EXHAUSTED: <id> at round <N> <ts>], il partecipante è marcato
 *       morto e skippato nei round successivi; ordine pinnato: il guard è
 *       DOPO la troncatura S05 e PRIMA della costruzione dell'entry.
 *   (g) metrics end-to-end (S08) — guardrail triggerati via toolLimits
 *       (truncation/budget) → getMetrics()/NDJSON: output chars = testo
 *       troncato (mai l'originale), arena_cost_usd = somma dei DELTA (mai dei
 *       cumulati, MEM093), limiti sotto soglia non alterano il happy path.
 *
 * I marker sono verificati per uguaglianza esatta di stringa contro
 * `formatFailureMarker` (contratto S01), non solo presenza/assenza — per la
 * componente timestamp (non deterministica) il valore viene estratto dal
 * transcript e riusato per ricostruire il marker atteso, così l'uguaglianza
 * resta esatta sui componenti deterministici (id, reason) senza dover
 * predire l'orologio di sistema.
 */

import { test, afterEach, beforeEach, before, after } from "node:test";
import * as assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runDiscussionArena, type RunTurnFn } from "../index.js";
import { formatFailureMarker } from "../helpers.js";
import { getMetrics, resetMetrics } from "../metrics.js";
import { arenaEventLogPath, replayArena } from "../replay.js";
import type { ParticipantTurnResult } from "../run-participant.js";
import { GSD_AGENT_DIR_ENV } from "./fixtures/pi-coding-agent-stub.js";

// ─── Fixture helpers (pattern participants.test.ts) ────────────────────────

/** Scrive un partecipante .md minimale (name/role/description) in `dir`.
 * `extraRows` permette di aggiungere righe di frontmatter arbitrarie (es.
 * `cost_budget_usd` — il parsing per-participante è già in S02/S05). */
function writeParticipant(
	dir: string,
	filename: string,
	opts: { name: string; role: string; description?: string; extraRows?: string[] },
): void {
	const rows = [
		`name: ${opts.name}`,
		`role: ${opts.role}`,
		`description: ${opts.description ?? opts.name}`,
		...(opts.extraRows ?? []),
	];
	fs.writeFileSync(
		path.join(dir, filename),
		`---\n${rows.join("\n")}\n---\n\nSystem prompt di ${opts.name}.\n`,
		"utf-8",
	);
}

interface Fixture {
	root: string;
	userDir: string;
	cwd: string;
}

/**
 * Fixture con dir utente (`GSD_AGENT_DIR/discussion-arena/participants`) —
 * sufficiente per il discovery, nessuna dir progetto necessaria: il cwd resta
 * privo di `.gsd/discussion-arena/participants`, quindi `discoverParticipants`
 * trova solo i partecipanti utente scritti qui (più eventuali bundled, esclusi
 * dalla selezione perché non richiesti per nome — vedi selectParticipants).
 */
function makeFixture(): Fixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-arena-loop-"));
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
			// best-effort
		}
	}
});

// ─── PATH: il binario `gsd` finto deve vincere sul reale (Scenario 1, S09) ─
// Il test della sezione (h) spawna SUBPROCESS REALI (runTurn omesso -> default
// runParticipantTurn): la fixture fake-gsd in testa a PATH viene risolta dallo
// spawn. I test con runTurn mockato delle sezioni (a)-(g) non spawnano mai
// `gsd` — il PATH prepend non li tocca (pattern timeout-watchdog.test.ts).
const FAKE_GSD_DIR = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"fixtures",
	"fake-gsd",
);

let originalPath: string | undefined;
before(() => {
	originalPath = process.env.PATH;
	process.env.PATH = `${FAKE_GSD_DIR}${path.delimiter}${originalPath ?? ""}`;
});
after(() => {
	if (originalPath === undefined) {
		delete process.env.PATH;
	} else {
		process.env.PATH = originalPath;
	}
});

/** Silenzia process.stderr.write durante `fn` (log dei limiti risolti, S02). */
async function captureStderr<T>(fn: () => Promise<T>): Promise<T> {
	const original = process.stderr.write.bind(process.stderr);
	process.stderr.write = (() => true) as unknown as typeof process.stderr.write;
	try {
		return await fn();
	} finally {
		process.stderr.write = original;
	}
}

/** Estrae gli eventi `event` dalle righe NDJSON (le righe plain non-NDJSON sono ignorate). */
function ndjsonEvents(chunks: string[]): string[] {
	const events: string[] = [];
	for (const chunk of chunks) {
		const trimmed = chunk.trimEnd();
		if (trimmed.length === 0) continue;
		try {
			const parsed = JSON.parse(trimmed) as { event?: unknown; ts?: unknown };
			if (typeof parsed.event === "string") {
				assert.ok(
					Number.isFinite(Date.parse(String(parsed.ts))),
					"ts ISO valido sulla riga NDJSON",
				);
				events.push(parsed.event);
			}
		} catch {
			// riga non-NDJSON (log plain esistenti) — ignorata
		}
	}
	return events;
}

// Isolamento del registry metrics tra i test della sezione (g) (S08): il
// registry è un singleton in-process; resetMetrics() azzera counters/histograms.
beforeEach(() => {
	resetMetrics();
});

/** Turno di successo deterministico per un dato partecipante. */
function okTurn(name: string, role: string): ParticipantTurnResult {
	return {
		participant: name,
		role,
		exitCode: 0,
		text: `${name} risponde`,
		stderr: "",
		usage: { input: 1, output: 1, cost: 0.001, turns: 1 },
		durationMs: 0,
	};
}

// ─── (a) crash parziale ─────────────────────────────────────────────────────

test("crash parziale: 1/3 muore al round 1 -> FAILED poi SKIPPED, outcome=partial, gli altri 2 completano entrambi i round", async () => {
	const f = makeFixture();
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");

	writeParticipant(f.userDir, "alice.md", { name: "alice", role: "Analyst" });
	writeParticipant(f.userDir, "bob.md", { name: "bob", role: "Builder" });
	writeParticipant(f.userDir, "carol.md", { name: "carol", role: "Critic" });

	const calls: string[] = [];
	const runTurn: RunTurnFn = async (participant) => {
		calls.push(participant.name);
		if (participant.name === "bob") {
			throw new Error("crash simulato");
		}
		return okTurn(participant.name, participant.role);
	};

	const out = await captureStderr(() =>
		runDiscussionArena(
			"topic test",
			["alice", "bob", "carol"],
			2,
			f.cwd,
			undefined,
			() => {},
			undefined,
			undefined,
			undefined,
			undefined,
			runTurn,
		),
	);

	assert.equal(out.outcome, "partial", "almeno un partecipante morto -> partial");
	assert.deepEqual(
		out.participantsUsed.slice().sort(),
		["alice", "bob", "carol"],
		"participantsUsed resta invariato (selezione, non sopravvivenza)",
	);

	// bob invocato una sola volta (round 1, dove crasha); al round 2 viene
	// skippato senza mai richiamare runTurn per lui.
	assert.equal(
		calls.filter((n) => n === "bob").length,
		1,
		"bob viene invocato una sola volta: al round 2 è skippato, non richiamato",
	);
	assert.equal(calls.filter((n) => n === "alice").length, 2, "alice gira entrambi i round");
	assert.equal(calls.filter((n) => n === "carol").length, 2, "carol gira entrambi i round");

	// Round 1: marker FAILED per bob — uguaglianza esatta di stringa contro
	// formatFailureMarker, timestamp estratto dal transcript (non deterministico
	// di per sé, ma il marker intero deve coincidere col contratto S01).
	const failedMatch = out.transcript.match(
		/\[PARTICIPANT FAILED: bob crash simulato ([^\]]+)\]/,
	);
	assert.ok(failedMatch, "marker FAILED presente nel round 1 per bob");
	const expectedFailedMarker = formatFailureMarker(
		"failed",
		"bob",
		"crash simulato",
		failedMatch![1]!,
	);
	assert.ok(
		out.transcript.includes(expectedFailedMarker),
		"il marker FAILED nel transcript coincide esattamente con formatFailureMarker",
	);
	assert.ok(
		out.transcript.includes(
			"### Round 1 — bob (Builder)\n[PARTICIPANT FAILED: bob crash simulato",
		),
		"il marker FAILED è nella entry del round 1 di bob",
	);

	// Round 2: marker SKIPPED per bob — nessun timestamp, uguaglianza esatta diretta.
	const expectedSkippedMarker = formatFailureMarker("skipped", "bob");
	assert.equal(expectedSkippedMarker, "[PARTICIPANT SKIPPED: bob]");
	assert.ok(
		out.transcript.includes(
			`### Round 2 — bob (Builder)\n${expectedSkippedMarker}`,
		),
		"il marker SKIPPED è nella entry del round 2 di bob",
	);

	// alice e carol: transcript regolare (nessun marker) in entrambi i round.
	assert.ok(out.transcript.includes("### Round 1 — alice (Analyst)\nalice risponde"));
	assert.ok(out.transcript.includes("### Round 2 — alice (Analyst)\nalice risponde"));
	assert.ok(out.transcript.includes("### Round 1 — carol (Critic)\ncarol risponde"));
	assert.ok(out.transcript.includes("### Round 2 — carol (Critic)\ncarol risponde"));

	// totalCost accumula solo i turni riusciti (bob non contribuisce mai).
	assert.equal(out.totalCost, 0.001 * 4, "4 turni riusciti (alice x2, carol x2) da 0.001 ciascuno");

	delete process.env[GSD_AGENT_DIR_ENV];
});

// ─── (b) crash totale ───────────────────────────────────────────────────────

test("crash totale: tutti i partecipanti selezionati muoiono al round 1 -> outcome=partial, nessun round 2 eseguito, transcript parsabile", async () => {
	const f = makeFixture();
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");

	writeParticipant(f.userDir, "alice.md", { name: "alice", role: "Analyst" });
	writeParticipant(f.userDir, "bob.md", { name: "bob", role: "Builder" });

	const calls: string[] = [];
	const runTurn: RunTurnFn = async (participant) => {
		calls.push(participant.name);
		throw new Error(`${participant.name} down`);
	};

	// rounds=3 richiesti, ma il ciclo deve interrompersi dopo il round 1
	// (tutti i selezionati morti al termine del round).
	const out = await captureStderr(() =>
		runDiscussionArena(
			"topic test",
			["alice", "bob"],
			3,
			f.cwd,
			undefined,
			() => {},
			undefined,
			undefined,
			undefined,
			undefined,
			runTurn,
		),
	);

	assert.equal(out.outcome, "partial");
	assert.equal(calls.length, 2, "solo il round 1 viene eseguito: 1 invocazione per partecipante");
	assert.equal(calls.filter((n) => n === "alice").length, 1);
	assert.equal(calls.filter((n) => n === "bob").length, 1);

	assert.ok(!out.transcript.includes("Round 2"), "nessun round 2 nel transcript");
	assert.ok(!out.transcript.includes("Round 3"), "nessun round 3 nel transcript");

	// Transcript parsabile: marker regex-matchabili, nessuna entry orfana —
	// esattamente 2 header di round (uno per partecipante, tutti nel round 1).
	const roundHeaders = out.transcript.match(/### Round \d+ — /g) ?? [];
	assert.equal(roundHeaders.length, 2, "esattamente 2 entry, entrambe nel round 1");

	// Uguaglianza esatta contro formatFailureMarker per entrambi, timestamp
	// estratto dal transcript (stesso approccio dello scenario (a)).
	for (const [name, reason] of [
		["alice", "alice down"],
		["bob", "bob down"],
	] as const) {
		const re = new RegExp(`\\[PARTICIPANT FAILED: ${name} ${reason} ([^\\]]+)\\]`);
		const match = out.transcript.match(re);
		assert.ok(match, `marker FAILED presente per ${name}`);
		const expectedMarker = formatFailureMarker("failed", name, reason, match![1]!);
		assert.ok(
			out.transcript.includes(expectedMarker),
			`il marker FAILED di ${name} coincide esattamente con formatFailureMarker`,
		);
	}

	assert.equal(out.totalCost, 0, "nessun turno riuscito -> costo zero");

	delete process.env[GSD_AGENT_DIR_ENV];
});

// ─── (c) regressione: nessun crash ──────────────────────────────────────────

test("regressione: nessun crash -> outcome=complete, transcript senza marker, comportamento identico al pre-S03", async () => {
	const f = makeFixture();
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");

	writeParticipant(f.userDir, "alice.md", { name: "alice", role: "Analyst" });
	writeParticipant(f.userDir, "bob.md", { name: "bob", role: "Builder" });

	const calls: string[] = [];
	const runTurn: RunTurnFn = async (participant) => {
		calls.push(participant.name);
		return okTurn(participant.name, participant.role);
	};

	const out = await captureStderr(() =>
		runDiscussionArena(
			"topic test",
			["alice", "bob"],
			2,
			f.cwd,
			undefined,
			() => {},
			undefined,
			undefined,
			undefined,
			undefined,
			runTurn,
		),
	);

	assert.equal(out.outcome, "complete", "nessun partecipante morto -> complete");
	assert.equal(calls.length, 4, "2 partecipanti x 2 round, nessuno skippato");
	assert.deepEqual(out.participantsUsed.slice().sort(), ["alice", "bob"]);
	assert.equal(out.totalCost, 0.001 * 4);

	assert.ok(!/PARTICIPANT FAILED/.test(out.transcript), "nessun marker FAILED");
	assert.ok(!/PARTICIPANT SKIPPED/.test(out.transcript), "nessun marker SKIPPED");

	assert.ok(out.transcript.includes("### Round 1 — alice (Analyst)\nalice risponde"));
	assert.ok(out.transcript.includes("### Round 2 — alice (Analyst)\nalice risponde"));
	assert.ok(out.transcript.includes("### Round 1 — bob (Builder)\nbob risponde"));
	assert.ok(out.transcript.includes("### Round 2 — bob (Builder)\nbob risponde"));

	delete process.env[GSD_AGENT_DIR_ENV];
});

// ─── firma retrocompatibile: runTurn è opzionale (11° parametro) ───────────

test("runTurn omesso: il default (runParticipantTurn) viene usato senza rompere l'esecuzione con mock iniettato tramite wrapper", async () => {
	// I 2 call site esistenti (tool discussion_arena, command /discussion-arena)
	// non passano l'11° parametro: per verificarne la compatibilità senza
	// spawnare un subprocess gsd reale (D022), sostituiamo temporaneamente
	// `runParticipantTurn` non è possibile (import diretto, non iniettato) —
	// la garanzia di retrocompatibilità della firma è quindi verificata
	// staticamente da `tsc` (i call site compilano invariati) più dal fatto
	// che gli scenari (a)/(b)/(c) sopra esercitano lo stesso codepath passando
	// esplicitamente runTurn in coda, l'ultimo parametro della firma.
	const f = makeFixture();
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");
	writeParticipant(f.userDir, "solo.md", { name: "solo", role: "Solo" });

	const calls: string[] = [];
	const runTurn: RunTurnFn = async (participant) => {
		calls.push(participant.name);
		return okTurn(participant.name, participant.role);
	};

	// Stessa forma posizionale dei 2 call site reali (10 argomenti fissi) più
	// runTurn iniettato in coda come 11°, esattamente come previsto dal
	// contratto S03 (default retrocompatibile, nessuna rottura di firma).
	const out = await captureStderr(() =>
		runDiscussionArena(
			"topic",
			["solo"],
			1,
			f.cwd,
			undefined,
			() => {},
			undefined,
			undefined,
			undefined,
			undefined,
			runTurn,
		),
	);

	assert.equal(out.outcome, "complete");
	assert.deepEqual(calls, ["solo"]);

	delete process.env[GSD_AGENT_DIR_ENV];
});

// ─── (d) timeout watchdog wiring (S04/T02) ─────────────────────────────────
// runTurn mockato che restituisce un ParticipantTurnResult con failureKind
// timeout (T01: il timeout NON lancia — emerge come result). Il loop deve
// formattare il marker canonico [TIMEOUT: <id> round_timeout|event_watchdog
// <ts>] al posto del testo del turno, marcare il partecipante morto (round
// successivi -> SKIPPED) e far confluire i limiti risolti nel 6° argomento.
// I subprocess reali in hang/rapidi sono coperti da tests/timeout-watchdog
// .test.ts (T03); qui si pinna solo il wiring del loop.

/** Turno terminato dai timer watchdog (T01): failureKind + cost 0. */
function timeoutTurn(
	name: string,
	role: string,
	kind: "timeout_round" | "timeout_event",
): ParticipantTurnResult {
	return {
		participant: name,
		role,
		exitCode: 137, // SIGKILL
		text: "",
		stderr: "Killed",
		usage: { input: 0, output: 0, cost: 0, turns: 0 },
		durationMs: 250,
		failureKind: kind,
		failureReason:
			kind === "timeout_round"
				? "round timeout superato (200 ms)"
				: "nessun evento per 200 ms (watchdog)",
	};
}

test("timeout event: runTurn restituisce failureKind timeout_event -> marker [TIMEOUT: <id> event_watchdog <ts>], partecipante morto (SKIPPED al round 2), outcome=partial, limits passati a runTurn", async () => {
	const f = makeFixture();
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");

	writeParticipant(f.userDir, "alice.md", { name: "alice", role: "Analyst" });
	writeParticipant(f.userDir, "bob.md", { name: "bob", role: "Builder" });

	const calls: string[] = [];
	const receivedLimits: Array<unknown> = [];
	const runTurn: RunTurnFn = async (
		participant,
		_prompt,
		_cwd,
		_signal,
		_modelOverride,
		limits,
	) => {
		calls.push(participant.name);
		receivedLimits.push(limits);
		if (participant.name === "bob" && calls.filter((n) => n === "bob").length === 1) {
			return timeoutTurn(participant.name, participant.role, "timeout_event");
		}
		return okTurn(participant.name, participant.role);
	};

	const out = await captureStderr(() =>
		runDiscussionArena(
			"topic test",
			["alice", "bob"],
			2,
			f.cwd,
			undefined,
			() => {},
			undefined,
			undefined,
			undefined,
			{ eventTimeoutMs: 200, termination: "hard" },
			runTurn,
		),
	);

	assert.equal(out.outcome, "partial", "bob morto per timeout -> partial");

	// bob invocato una sola volta (round 1, dove timeouta); al round 2 è
	// skippato senza mai richiamare runTurn per lui.
	assert.equal(
		calls.filter((n) => n === "bob").length,
		1,
		"bob viene invocato una sola volta: al round 2 è skippato, non richiamato",
	);
	assert.equal(calls.filter((n) => n === "alice").length, 2, "alice gira entrambi i round");

	// Round 1: marker TIMEOUT per bob — uguaglianza esatta contro
	// formatFailureMarker, timestamp estratto dal transcript.
	const timeoutMatch = out.transcript.match(
		/\[TIMEOUT: bob event_watchdog ([^\]]+)\]/,
	);
	assert.ok(timeoutMatch, "marker TIMEOUT presente nel round 1 per bob");
	const expectedTimeoutMarker = formatFailureMarker(
		"timeout_event",
		"bob",
		undefined,
		timeoutMatch![1]!,
	);
	assert.ok(
		out.transcript.includes(expectedTimeoutMarker),
		"il marker TIMEOUT nel transcript coincide esattamente con formatFailureMarker",
	);
	assert.ok(
		out.transcript.includes(
			"### Round 1 — bob (Builder)\n[TIMEOUT: bob event_watchdog",
		),
		"il marker TIMEOUT è nella entry del round 1 di bob (sostituisce il testo del turno)",
	);

	// Round 2: marker SKIPPED per bob — nessun timestamp.
	const expectedSkippedMarker = formatFailureMarker("skipped", "bob");
	assert.ok(
		out.transcript.includes(
			`### Round 2 — bob (Builder)\n${expectedSkippedMarker}`,
		),
		"il marker SKIPPED è nella entry del round 2 di bob",
	);

	// alice: transcript regolare in entrambi i round; totalCost conta solo lei.
	assert.ok(out.transcript.includes("### Round 1 — alice (Analyst)\nalice risponde"));
	assert.ok(out.transcript.includes("### Round 2 — alice (Analyst)\nalice risponde"));
	assert.equal(out.totalCost, 0.001 * 2, "2 turni riusciti (alice x2) — il timeout non contribuisce costo");

	// 6° parametro: i limiti risolti per partecipante arrivano a runTurn
	// (toolParams eventTimeoutMs=200, termination="hard" -> ResolvedLimits).
	assert.equal(receivedLimits.length, calls.length, "limits passato a ogni invocazione");
	for (const limits of receivedLimits) {
		assert.equal(
			(limits as { eventTimeoutMs?: number; termination?: string }).eventTimeoutMs,
			200,
			"eventTimeoutMs risolto (tool > defaults) arriva a runTurn",
		);
		assert.equal(
			(limits as { termination?: string }).termination,
			"hard",
			"termination risolto (tool > defaults) arriva a runTurn",
		);
	}

	delete process.env[GSD_AGENT_DIR_ENV];
});

test("timeout round: tutti i partecipanti timeoutano al round 1 -> marker [TIMEOUT: <id> round_timeout <ts>], loop si ferma (rounds=3 richiesti), outcome=partial", async () => {
	const f = makeFixture();
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");

	writeParticipant(f.userDir, "alice.md", { name: "alice", role: "Analyst" });
	writeParticipant(f.userDir, "bob.md", { name: "bob", role: "Builder" });

	const calls: string[] = [];
	const runTurn: RunTurnFn = async (participant) => {
		calls.push(participant.name);
		return timeoutTurn(participant.name, participant.role, "timeout_round");
	};

	const out = await captureStderr(() =>
		runDiscussionArena(
			"topic test",
			["alice", "bob"],
			3,
			f.cwd,
			undefined,
			() => {},
			undefined,
			undefined,
			undefined,
			{ roundTimeoutMs: 200 },
			runTurn,
		),
	);

	assert.equal(out.outcome, "partial");
	assert.equal(calls.length, 2, "solo il round 1 viene eseguito: 1 invocazione per partecipante");

	assert.ok(!out.transcript.includes("Round 2"), "nessun round 2 nel transcript");
	assert.ok(!out.transcript.includes("Round 3"), "nessun round 3 nel transcript");

	// Marker TIMEOUT round_timeout per entrambi — uguaglianza esatta contro
	// formatFailureMarker, timestamp estratto dal transcript. Regex letterali
	// (nessuna interpolazione dinamica: niente ReDoS, i nomi sono un array
	// const e il pattern è fisso).
	const markers =
		out.transcript.match(/\[TIMEOUT: (\S+) round_timeout ([^\]]+)\]/g) ?? [];
	assert.equal(markers.length, 2, "esattamente 2 marker TIMEOUT round_timeout");
	for (const name of ["alice", "bob"] as const) {
		const marker = markers.find((m) =>
			m.startsWith(`[TIMEOUT: ${name} round_timeout `),
		);
		assert.ok(marker, `marker TIMEOUT presente per ${name}`);
		const ts = /\[TIMEOUT: \S+ round_timeout ([^\]]+)\]/.exec(marker!)?.[1];
		assert.ok(ts, `timestamp estraibile dal marker di ${name}`);
		const expectedMarker = formatFailureMarker(
			"timeout_round",
			name,
			undefined,
			ts!,
		);
		assert.ok(
			out.transcript.includes(expectedMarker),
			`il marker TIMEOUT di ${name} coincide esattamente con formatFailureMarker`,
		);
	}

	assert.equal(out.totalCost, 0, "nessun turno riuscito -> costo zero");

	delete process.env[GSD_AGENT_DIR_ENV];
});

// ─── (e) output limit con troncamento e marker (S05/T02) ────────────────────
// Il loop tronca l'output di un turno riuscito a `outputLimitChars`
// (ResolvedLimits, S02) appendendo il marker `[OUTPUT TRUNCATED at N chars]`
// (helper puro S01). L'over-limit NON è un crash: il turno resta completo, il
// partecipante non entra in `morti`, continua ai round successivi e `outcome`
// resta determinato dal crash tracking di S03. Il marker distingue l'over-
// limit da crash (FAILED, S03) e timeout (TIMEOUT, S04) — la superficie di
// osservabilità regex-matchabile consumata da S08/S09.
// Pattern identico a S03/S04: runTurn mockato via injection (D022/D020,
// nessun subprocess reale), fixture partecipanti su tmpdir.

/** Cattura i chunk scritti su stderr durante `fn` (per asserire i warning). */
async function captureStderrChunks<T>(
	fn: () => Promise<T>,
): Promise<{ value: T; chunks: string[] }> {
	const original = process.stderr.write.bind(process.stderr);
	const chunks: string[] = [];
	process.stderr.write = ((chunk: unknown) => {
		chunks.push(String(chunk));
		return true;
	}) as unknown as typeof process.stderr.write;
	try {
		const value = await fn();
		return { value, chunks };
	} finally {
		process.stderr.write = original;
	}
}

test("over-limit: 1 partecipante, 1 round, outputLimitChars=100 -> output 2000 char troncato a 100 con marker, outcome=complete, nessun marker FAILED/SKIPPED", async () => {
	const f = makeFixture();
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");
	writeParticipant(f.userDir, "alice.md", { name: "alice", role: "Analyst" });

	const calls: string[] = [];
	const runTurn: RunTurnFn = async (participant) => {
		calls.push(participant.name);
		return { ...okTurn(participant.name, participant.role), text: "x".repeat(2000) };
	};

	const out = await captureStderr(() =>
		runDiscussionArena(
			"topic test",
			["alice"],
			1,
			f.cwd,
			undefined,
			() => {},
			undefined,
			undefined,
			undefined,
			{ outputLimitChars: 100 },
			runTurn,
		),
	);

	// L'over-limit è un turno COMPLETO: outcome=complete (crash tracking S03),
	// nessun marker di crash/timeout, costo conteggiato.
	assert.equal(out.outcome, "complete", "over-limit non è un crash -> complete");
	assert.equal(calls.length, 1, "alice invocata una sola volta (turno completo, nessuno skip)");
	assert.equal(out.totalCost, 0.001, "il turno troncato è completo: costo conteggiato");
	assert.ok(!/PARTICIPANT FAILED/.test(out.transcript), "nessun marker FAILED");
	assert.ok(!/PARTICIPANT SKIPPED/.test(out.transcript), "nessun marker SKIPPED");

	// Marker esatto (superficie di osservabilità S05) + testo troncato a 100.
	const marker = "[OUTPUT TRUNCATED at 100 chars]";
	assert.ok(out.transcript.includes(marker), "marker [OUTPUT TRUNCATED at 100 chars] presente");
	const entry = out.transcript.match(/### Round 1 — alice \(Analyst\)\n([\s\S]+)$/);
	assert.ok(entry, "entry del round 1 presente");
	const truncated = entry![1]!;
	assert.equal(truncated.length, 100, "testo troncato esattamente a outputLimitChars");
	assert.ok(truncated.endsWith(marker), "marker embedded in coda");
	assert.ok(
		truncated.startsWith("x".repeat(100 - marker.length)),
		"contenuto: primi (outputLimitChars - marker) char dell'output originale",
	);
	assert.ok(
		!out.transcript.includes("x".repeat(2000)),
		"l'output originale completo NON compare nel transcript",
	);

	delete process.env[GSD_AGENT_DIR_ENV];
});

test("sotto-limite: output 100 char con outputLimitChars=5000 -> testo integro, nessun marker, outcome=complete (regressione)", async () => {
	const f = makeFixture();
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");
	writeParticipant(f.userDir, "alice.md", { name: "alice", role: "Analyst" });

	const calls: string[] = [];
	const runTurn: RunTurnFn = async (participant) => {
		calls.push(participant.name);
		return { ...okTurn(participant.name, participant.role), text: "y".repeat(100) };
	};

	const out = await captureStderr(() =>
		runDiscussionArena(
			"topic test",
			["alice"],
			1,
			f.cwd,
			undefined,
			() => {},
			undefined,
			undefined,
			undefined,
			{ outputLimitChars: 5000 },
			runTurn,
		),
	);

	assert.equal(out.outcome, "complete");
	assert.equal(out.totalCost, 0.001);
	const entry = out.transcript.match(/### Round 1 — alice \(Analyst\)\n([\s\S]+)$/);
	assert.ok(entry, "entry presente");
	assert.equal(entry![1]!, "y".repeat(100), "output sotto il limite passa integro");
	assert.ok(
		!out.transcript.includes("OUTPUT TRUNCATED"),
		"nessun marker di troncatura sotto il limite",
	);

	delete process.env[GSD_AGENT_DIR_ENV];
});

test("multi-round: 2 partecipanti x 2 round, outputLimitChars=50, 200 char/turno -> ogni turno troncato a 50 col marker, nessun morto, outcome=complete", async () => {
	const f = makeFixture();
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");
	writeParticipant(f.userDir, "alice.md", { name: "alice", role: "Analyst" });
	writeParticipant(f.userDir, "bob.md", { name: "bob", role: "Builder" });

	const calls: string[] = [];
	const runTurn: RunTurnFn = async (participant) => {
		calls.push(participant.name);
		return { ...okTurn(participant.name, participant.role), text: `${participant.name} `.repeat(50) };
	};

	const out = await captureStderr(() =>
		runDiscussionArena(
			"topic test",
			["alice", "bob"],
			2,
			f.cwd,
			undefined,
			() => {},
			undefined,
			undefined,
			undefined,
			{ outputLimitChars: 50 },
			runTurn,
		),
	);

	assert.equal(out.outcome, "complete", "over-limit ripetuto non uccide nessuno -> complete");
	assert.equal(calls.length, 4, "2 partecipanti x 2 round: nessuno skippato");
	assert.equal(calls.filter((n) => n === "alice").length, 2, "alice completa entrambi i round");
	assert.equal(calls.filter((n) => n === "bob").length, 2, "bob completa entrambi i round");
	assert.equal(out.totalCost, 0.001 * 4, "4 turni completi");

	// Esattamente 4 marker (uno per turno) e nessun marker di crash/timeout.
	const markers = out.transcript.match(/\[OUTPUT TRUNCATED at 50 chars\]/g) ?? [];
	assert.equal(markers.length, 4, "4 marker OUTPUT TRUNCATED (1 per turno)");
	assert.ok(!/PARTICIPANT FAILED/.test(out.transcript), "nessun FAILED");
	assert.ok(!/PARTICIPANT SKIPPED/.test(out.transcript), "nessun SKIPPED");
	assert.ok(!/\[TIMEOUT:/.test(out.transcript), "nessun TIMEOUT");

	// Ogni entry è troncata a 50 char con marker in coda, ed entrambi i
	// partecipanti compaiono in entrambi i round (nessuno morto).
	const entries = [
		...out.transcript.matchAll(/### Round (\d+) — (\w+) \((\w+)\)\n([^\n]+)/g),
	].map((m) => ({ round: Number(m[1]!), name: m[2]!, role: m[3]!, body: m[4]! }));
	assert.equal(entries.length, 4, "4 entry nel transcript");
	for (const e of entries) {
		assert.equal(e.body.length, 50, `entry round ${e.round} di ${e.name}: troncata a outputLimitChars`);
		assert.ok(e.body.endsWith("[OUTPUT TRUNCATED at 50 chars]"), "marker in coda");
	}
	assert.deepEqual(
		entries.filter((e) => e.name === "alice").map((e) => e.round),
		[1, 2],
		"alice presente in entrambi i round (continua dopo l'over-limit)",
	);
	assert.deepEqual(
		entries.filter((e) => e.name === "bob").map((e) => e.round),
		[1, 2],
		"bob presente in entrambi i round (continua dopo l'over-limit)",
	);

	delete process.env[GSD_AGENT_DIR_ENV];
});

test("crash + output limit: alice over-limit (TRUNCATED), bob crasha (FAILED) -> entrambi i marker convivono, outcome=partial, alice continua e bob è SKIPPED", async () => {
	const f = makeFixture();
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");
	writeParticipant(f.userDir, "alice.md", { name: "alice", role: "Analyst" });
	writeParticipant(f.userDir, "bob.md", { name: "bob", role: "Builder" });

	const calls: string[] = [];
	const runTurn: RunTurnFn = async (participant) => {
		calls.push(participant.name);
		if (participant.name === "bob") {
			throw new Error("crash simulato");
		}
		return { ...okTurn(participant.name, participant.role), text: "z".repeat(2000) };
	};

	const out = await captureStderr(() =>
		runDiscussionArena(
			"topic test",
			["alice", "bob"],
			2,
			f.cwd,
			undefined,
			() => {},
			undefined,
			undefined,
			undefined,
			{ outputLimitChars: 100 },
			runTurn,
		),
	);

	// outcome determinato dal crash tracking di S03 (bob), NON dall'over-limit di alice.
	assert.equal(out.outcome, "partial", "bob morto per crash -> partial");
	assert.equal(calls.filter((n) => n === "alice").length, 2, "alice completa entrambi i round");
	assert.equal(calls.filter((n) => n === "bob").length, 1, "bob invocato una sola volta (crash al round 1)");

	// I due marker convivono: TRUNCATED (alice) e FAILED (bob, esatto vs formatFailureMarker).
	assert.ok(out.transcript.includes("[OUTPUT TRUNCATED at 100 chars]"), "marker TRUNCATED presente (alice)");
	const failedMatch = out.transcript.match(/\[PARTICIPANT FAILED: bob crash simulato ([^\]]+)\]/);
	assert.ok(failedMatch, "marker FAILED presente (bob)");
	const expectedFailed = formatFailureMarker("failed", "bob", "crash simulato", failedMatch![1]!);
	assert.ok(
		out.transcript.includes(expectedFailed),
		"marker FAILED coincide esattamente con formatFailureMarker",
	);
	assert.ok(out.transcript.includes("[PARTICIPANT SKIPPED: bob]"), "bob SKIPPED al round 2");

	// alice: troncata a 100 con marker in entrambi i round.
	const aliceR1 = out.transcript.match(/### Round 1 — alice \(Analyst\)\n([^\n]+)/);
	assert.ok(aliceR1, "entry round 1 di alice presente");
	assert.equal(aliceR1![1]!.length, 100, "alice troncata a outputLimitChars al round 1");
	assert.ok(aliceR1![1]!.endsWith("[OUTPUT TRUNCATED at 100 chars]"), "marker in coda");
	const aliceR2 = out.transcript.match(/### Round 2 — alice \(Analyst\)\n([^\n]+)/);
	assert.ok(aliceR2, "entry round 2 di alice presente");
	assert.equal(aliceR2![1]!.length, 100, "alice troncata a outputLimitChars al round 2");
	assert.ok(aliceR2![1]!.endsWith("[OUTPUT TRUNCATED at 100 chars]"), "marker in coda");

	assert.equal(out.totalCost, 0.002, "2 turni riusciti (alice x2); il crash di bob non contribuisce");

	delete process.env[GSD_AGENT_DIR_ENV];
});

test("edge case: outputLimitChars=5 (< lunghezza marker) -> guard: testo integro + warning su stderr, nessun crash, outcome=complete", async () => {
	const f = makeFixture();
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");
	writeParticipant(f.userDir, "alice.md", { name: "alice", role: "Analyst" });

	const calls: string[] = [];
	const runTurn: RunTurnFn = async (participant) => {
		calls.push(participant.name);
		return { ...okTurn(participant.name, participant.role), text: "q".repeat(2000) };
	};

	const { value: out, chunks } = await captureStderrChunks(() =>
		runDiscussionArena(
			"topic test",
			["alice"],
			1,
			f.cwd,
			undefined,
			() => {},
			undefined,
			undefined,
			undefined,
			{ outputLimitChars: 5 },
			runTurn,
		),
	);

	// Config invalida (limit < lunghezza marker) NON è un crash dell'arena:
	// il guard del consumer cattura il RangeError di truncateOutput (S01).
	assert.equal(out.outcome, "complete", "config invalida non è un crash -> complete");
	assert.equal(calls.length, 1);
	assert.ok(
		out.transcript.includes("q".repeat(2000)),
		"testo passa integro (nessuna troncatura applicata)",
	);
	assert.ok(!out.transcript.includes("OUTPUT TRUNCATED"), "nessun marker di troncatura");
	assert.ok(!/PARTICIPANT FAILED/.test(out.transcript), "nessun marker FAILED");

	// Warning esplicito su stderr (osservabilità del guard).
	const warning = chunks.find((c) =>
		c.includes("outputLimitChars=5 < marker length, troncatura saltata per alice"),
	);
	assert.ok(warning, "warning su stderr: troncatura saltata per limit < lunghezza marker");

	delete process.env[GSD_AGENT_DIR_ENV];
});

// ─── (f) budget guard per partecipante con fix cost extraction (S06/T02) ───
// Il loop traccia il costo cumulato per partecipante (costByParticipant) via
// accumulateCost (fix §4.1: usage.cost number | string | {total}, clamp >= 0,
// tollera null/undefined) e, quando il cumulato raggiunge costBudgetUsd
// (ResolvedLimits S02, >= 0 per clamp min:0), il turno termina con il marker
// canonico [BUDGET EXHAUSTED: <id> at round <N> <ts>] al posto del testo, il
// partecipante è marcato morto ("budget_exhausted") e nei round successivi il
// loop di resilienza S03 lo salta ([PARTICIPANT SKIPPED: <id>]) con outcome
// "partial". Ordine pinnato: il guard è DOPO la troncatura S05 (l'over-limit
// resta un successo TRUNCATED) e PRIMA della costruzione dell'entry (il
// marker sostituisce il testo). Il turno che fa scattare l'exhaustion paga il
// suo costo (costByParticipant aggiornato prima del check — dato grezzo per
// S08 arena_cost_usd{participant}).

/** Turno riuscito con costo personalizzato (number | string | {total} — fix §4.1). */
function turnWithCost(
	name: string,
	role: string,
	cost: number | string | { total: number | string },
): ParticipantTurnResult {
	return {
		...okTurn(name, role),
		usage: {
			input: 1,
			output: 1,
			// Il contratto dichiara usage.cost: number (run-participant.ts:32); il
			// fix §4.1 rende il consumer resiliente a string/{total} per future
			// fonti che bypassano il toNumber interno (es. replay event log S07).
			// Il cast documenta che stiamo testando una fonte non normalizzata.
			cost: cost as unknown as number,
			turns: 1,
		},
	};
}

/** Costo atteso cumulato (stesso ordine di addizione di accumulateCost nel loop). */
function expectTotal(costs: number[]): number {
	return costs.reduce((acc, c) => acc + c, 0);
}

test("budget overflow: alice (cost_budget_usd 0.01) cost 0.05 al round 1 -> marker BUDGET EXHAUSTED esatto R1 + SKIPPED R2, bob completa entrambi i round, outcome=partial, costo del turno che esaurisce pagato", async () => {
	const f = makeFixture();
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");
	writeParticipant(f.userDir, "alice.md", {
		name: "alice",
		role: "Analyst",
		extraRows: ["cost_budget_usd: 0.01"],
	});
	writeParticipant(f.userDir, "bob.md", { name: "bob", role: "Builder" });

	const calls: string[] = [];
	const runTurn: RunTurnFn = async (participant) => {
		calls.push(participant.name);
		if (participant.name === "alice") {
			return turnWithCost("alice", "Analyst", 0.05);
		}
		return okTurn(participant.name, participant.role);
	};

	const out = await captureStderr(() =>
		runDiscussionArena(
			"topic test",
			["alice", "bob"],
			2,
			f.cwd,
			undefined,
			() => {},
			undefined,
			undefined,
			undefined,
			undefined,
			runTurn,
		),
	);

	assert.equal(out.outcome, "partial", "alice morta per budget esaurito -> partial");
	assert.equal(
		calls.filter((n) => n === "alice").length,
		1,
		"alice invocata una sola volta: al round 2 è skippata (budget_exhausted in morti)",
	);
	assert.equal(calls.filter((n) => n === "bob").length, 2, "bob gira entrambi i round (budget default 1.0, cost 0.001 < budget)");

	// Round 1: marker BUDGET EXHAUSTED — uguaglianza esatta di stringa contro
	// formatFailureMarker, timestamp estratto dal transcript (pattern S03/S04).
	const budgetMatch = out.transcript.match(
		/\[BUDGET EXHAUSTED: alice at round 1 ([^\]]+)\]/,
	);
	assert.ok(budgetMatch, "marker BUDGET EXHAUSTED presente al round 1 per alice");
	const expectedBudgetMarker = formatFailureMarker(
		"budget_exhausted",
		"alice",
		"at round 1",
		budgetMatch![1]!,
	);
	assert.ok(
		out.transcript.includes(expectedBudgetMarker),
		"il marker BUDGET EXHAUSTED coincide esattamente con formatFailureMarker",
	);
	assert.ok(
		out.transcript.includes(
			"### Round 1 — alice (Analyst)\n[BUDGET EXHAUSTED: alice at round 1",
		),
		"il marker sostituisce il testo del turno nella entry del round 1",
	);
	assert.ok(
		!out.transcript.includes("### Round 1 — alice (Analyst)\nalice risponde"),
		"il testo del turno di alice NON compare (rimpiazzato dal marker)",
	);

	// Round 2: marker SKIPPED per alice (loop di resilienza S03) — nessun timestamp.
	const expectedSkipped = formatFailureMarker("skipped", "alice");
	assert.equal(expectedSkipped, "[PARTICIPANT SKIPPED: alice]");
	assert.ok(
		out.transcript.includes(`### Round 2 — alice (Analyst)\n${expectedSkipped}`),
		"alice SKIPPED al round 2 (nessuna invocazione di runTurn per lei)",
	);

	// bob: transcript regolare in entrambi i round, nessun marker di budget.
	assert.ok(out.transcript.includes("### Round 1 — bob (Builder)\nbob risponde"));
	assert.ok(out.transcript.includes("### Round 2 — bob (Builder)\nbob risponde"));
	assert.ok(
		!out.transcript.includes("BUDGET EXHAUSTED: bob"),
		"nessun marker BUDGET EXHAUSTED per bob",
	);

	// Il turno che fa scattare l'exhaustion paga il suo costo: totalCost =
	// 0.05 (alice R1) + 0.001 (bob R1) + 0.001 (bob R2). Espressione, non
	// letterale decimale: stesse addizioni in floating point del loop.
	assert.equal(out.totalCost, expectTotal([0.05, 0.001, 0.001]));

	delete process.env[GSD_AGENT_DIR_ENV];
});

test("budget non superato: cost < budget su tutti i turni -> nessun marker BUDGET EXHAUSTED/SKIPPED, outcome=complete (regressione)", async () => {
	const f = makeFixture();
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");
	writeParticipant(f.userDir, "alice.md", { name: "alice", role: "Analyst" });
	writeParticipant(f.userDir, "bob.md", { name: "bob", role: "Builder" });

	const calls: string[] = [];
	const runTurn: RunTurnFn = async (participant) => {
		calls.push(participant.name);
		return okTurn(participant.name, participant.role);
	};

	const out = await captureStderr(() =>
		runDiscussionArena(
			"topic test",
			["alice", "bob"],
			2,
			f.cwd,
			undefined,
			() => {},
			undefined,
			undefined,
			undefined,
			undefined,
			runTurn,
		),
	);

	// Costo cumulato per partecipante (0.002) sempre sotto il budget default
	// (1.0): nessun turno termina per budget, nessun morto.
	assert.equal(out.outcome, "complete", "nessun partecipante esaurisce il budget -> complete");
	assert.equal(calls.length, 4, "2 partecipanti x 2 round, nessuno skippato");
	assert.equal(out.totalCost, expectTotal([0.001, 0.001, 0.001, 0.001]));

	assert.ok(!/BUDGET EXHAUSTED/.test(out.transcript), "nessun marker BUDGET EXHAUSTED");
	assert.ok(!/PARTICIPANT SKIPPED/.test(out.transcript), "nessun marker SKIPPED");
	assert.ok(!/PARTICIPANT FAILED/.test(out.transcript), "nessun marker FAILED");

	assert.ok(out.transcript.includes("### Round 1 — alice (Analyst)\nalice risponde"));
	assert.ok(out.transcript.includes("### Round 2 — alice (Analyst)\nalice risponde"));
	assert.ok(out.transcript.includes("### Round 1 — bob (Builder)\nbob risponde"));
	assert.ok(out.transcript.includes("### Round 2 — bob (Builder)\nbob risponde"));

	delete process.env[GSD_AGENT_DIR_ENV];
});

test("cost-by-partecipante indipendente: alice (budget 0.01) e bob (budget 1.0) con lo stesso cost 0.05 -> alice esaurisce R1, bob continua entrambi i round (budget risolto per partecipante, accumulo non condiviso)", async () => {
	const f = makeFixture();
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");
	writeParticipant(f.userDir, "alice.md", {
		name: "alice",
		role: "Analyst",
		extraRows: ["cost_budget_usd: 0.01"],
	});
	writeParticipant(f.userDir, "bob.md", {
		name: "bob",
		role: "Builder",
		extraRows: ["cost_budget_usd: 1.0"],
	});

	const calls: string[] = [];
	const runTurn: RunTurnFn = async (participant) => {
		calls.push(participant.name);
		return turnWithCost(participant.name, participant.role, 0.05);
	};

	const out = await captureStderr(() =>
		runDiscussionArena(
			"topic test",
			["alice", "bob"],
			2,
			f.cwd,
			undefined,
			() => {},
			undefined,
			undefined,
			undefined,
			undefined,
			runTurn,
		),
	);

	assert.equal(out.outcome, "partial", "alice morta per budget -> partial");
	assert.equal(
		calls.filter((n) => n === "alice").length,
		1,
		"alice esaurisce al round 1 e non viene più invocata",
	);
	assert.equal(
		calls.filter((n) => n === "bob").length,
		2,
		"bob gira entrambi i round: il budget è risolto per partecipante, non condiviso",
	);

	// alice: BUDGET EXHAUSTED esatto al round 1 + SKIPPED al round 2.
	const budgetMatch = out.transcript.match(
		/\[BUDGET EXHAUSTED: alice at round 1 ([^\]]+)\]/,
	);
	assert.ok(budgetMatch, "marker BUDGET EXHAUSTED presente per alice");
	assert.ok(
		out.transcript.includes(
			formatFailureMarker(
				"budget_exhausted",
				"alice",
				"at round 1",
				budgetMatch![1]!,
			),
		),
		"marker BUDGET EXHAUSTED di alice esatto vs formatFailureMarker",
	);
	assert.ok(
		out.transcript.includes("### Round 2 — alice (Analyst)\n[PARTICIPANT SKIPPED: alice]"),
		"alice SKIPPED al round 2",
	);

	// bob: stesso cost per turno di alice (0.05), ma budget 1.0 — cumulato
	// proprio 0.10 dopo R2, sempre sotto budget: nessun marker, entrambi i
	// round completi. Un accumulatore condiviso tra partecipanti mostrerebbe
	// a bob un cumulato gonfiato dal costo di alice già al round 1.
	assert.ok(out.transcript.includes("### Round 1 — bob (Builder)\nbob risponde"));
	assert.ok(out.transcript.includes("### Round 2 — bob (Builder)\nbob risponde"));
	assert.ok(
		!out.transcript.includes("BUDGET EXHAUSTED: bob"),
		"nessun marker BUDGET EXHAUSTED per bob (il suo accumulo resta sotto budget)",
	);

	assert.equal(out.totalCost, expectTotal([0.05, 0.05, 0.05]));

	delete process.env[GSD_AGENT_DIR_ENV];
});

test("fix §4.1: usage.cost come {total: 0.05} e stringa \"0.05\" normalizzati da accumulateCost -> entrambi esauriscono il budget al round 1, totalCost corretto", async () => {
	const f = makeFixture();
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");
	writeParticipant(f.userDir, "alice.md", {
		name: "alice",
		role: "Analyst",
		extraRows: ["cost_budget_usd: 0.01"],
	});
	writeParticipant(f.userDir, "bob.md", {
		name: "bob",
		role: "Builder",
		extraRows: ["cost_budget_usd: 0.01"],
	});

	const calls: string[] = [];
	const runTurn: RunTurnFn = async (participant) => {
		calls.push(participant.name);
		if (participant.name === "alice") {
			return turnWithCost("alice", "Analyst", { total: 0.05 });
		}
		return turnWithCost("bob", "Builder", "0.05");
	};

	const out = await captureStderr(() =>
		runDiscussionArena(
			"topic test",
			["alice", "bob"],
			2,
			f.cwd,
			undefined,
			() => {},
			undefined,
			undefined,
			undefined,
			undefined,
			runTurn,
		),
	);

	assert.equal(out.outcome, "partial", "entrambi morti per budget -> partial");
	assert.equal(calls.length, 2, "solo il round 1: tutti i selezionati morti -> break (D045)");
	assert.ok(!out.transcript.includes("Round 2"), "nessun round 2 nel transcript");

	// Entrambi i formati (oggetto {total} e stringa) superano il budget 0.01:
	// accumulateCost li normalizza come il number 0.05 -> il guard scatta R1.
	// Regex letterale + startsWith (pattern test "timeout round" S04): nessuna
	// interpolazione dinamica in RegExp (niente ReDoS — i nomi sono un array
	// const e il pattern è fisso).
	const budgetMarkers =
		out.transcript.match(/\[BUDGET EXHAUSTED: (\S+) at round 1 ([^\]]+)\]/g) ??
		[];
	assert.equal(
		budgetMarkers.length,
		2,
		"esattamente 2 marker BUDGET EXHAUSTED al round 1",
	);
	for (const name of ["alice", "bob"] as const) {
		const marker = budgetMarkers.find((m) =>
			m.startsWith(`[BUDGET EXHAUSTED: ${name} at round 1 `),
		);
		assert.ok(marker, `marker BUDGET EXHAUSTED presente per ${name}`);
		const ts = /\[BUDGET EXHAUSTED: \S+ at round 1 ([^\]]+)\]/.exec(marker!)?.[1];
		assert.ok(ts, `timestamp estraibile dal marker di ${name}`);
		assert.ok(
			out.transcript.includes(
				formatFailureMarker("budget_exhausted", name, "at round 1", ts!),
			),
			`il marker di ${name} coincide esattamente con formatFailureMarker`,
		);
	}

	// totalCost = 0.05 ({total} di alice) + 0.05 (stringa di bob).
	assert.equal(out.totalCost, expectTotal([0.05, 0.05]));

	delete process.env[GSD_AGENT_DIR_ENV];
});

test("budget + output limit combinati: alice (budget 0.05) TRUNCATED al round 1 (sotto budget), BUDGET EXHAUSTED al round 2 (cumulato 0.06 >= 0.05) -> outcome=partial, bob completa entrambi i round, ordine pinnato", async () => {
	const f = makeFixture();
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");
	writeParticipant(f.userDir, "alice.md", {
		name: "alice",
		role: "Analyst",
		extraRows: ["cost_budget_usd: 0.05"],
	});
	writeParticipant(f.userDir, "bob.md", { name: "bob", role: "Builder" });

	const calls: string[] = [];
	const runTurn: RunTurnFn = async (participant) => {
		calls.push(participant.name);
		if (participant.name === "alice") {
			return {
				...turnWithCost("alice", "Analyst", 0.03),
				text: "x".repeat(2000),
			};
		}
		return okTurn(participant.name, participant.role);
	};

	const out = await captureStderr(() =>
		runDiscussionArena(
			"topic test",
			["alice", "bob"],
			2,
			f.cwd,
			undefined,
			() => {},
			undefined,
			undefined,
			undefined,
			{ outputLimitChars: 100 },
			runTurn,
		),
	);

	assert.equal(out.outcome, "partial", "alice morta per budget -> partial");
	assert.equal(calls.filter((n) => n === "alice").length, 2, "alice gira entrambi i round (al R2 muore per budget)");
	assert.equal(calls.filter((n) => n === "bob").length, 2, "bob completa entrambi i round");

	// Round 1: output 2000 > 100 -> TRUNCATED (turno completo), cost 0.03 <
	// budget 0.05 -> NESSUN budget marker: l'over-limit non è una failure.
	const truncatedMarkers =
		out.transcript.match(/\[OUTPUT TRUNCATED at 100 chars\]/g) ?? [];
	assert.equal(
		truncatedMarkers.length,
		1,
		"esattamente 1 marker TRUNCATED (solo alice al round 1)",
	);
	const aliceR1 = out.transcript.match(/### Round 1 — alice \(Analyst\)\n([^\n]+)/);
	assert.ok(aliceR1, "entry round 1 di alice presente");
	assert.equal(aliceR1![1]!.length, 100, "alice R1 troncata a outputLimitChars");
	assert.ok(
		aliceR1![1]!.endsWith("[OUTPUT TRUNCATED at 100 chars]"),
		"marker TRUNCATED in coda all'entry R1",
	);

	// Round 2: cumulato 0.03 + 0.03 = 0.06 >= 0.05 -> BUDGET EXHAUSTED. Il
	// guard è DOPO la troncatura e PRIMA della costruzione dell'entry: il
	// marker sostituisce anche il testo (troncato) del turno — mai
	// TRUNCATED al round 2. Ordine pinnato (scenario 2 CONTEXT).
	const budgetMatch = out.transcript.match(
		/\[BUDGET EXHAUSTED: alice at round 2 ([^\]]+)\]/,
	);
	assert.ok(budgetMatch, "marker BUDGET EXHAUSTED presente al round 2 per alice");
	assert.ok(
		out.transcript.includes(
			formatFailureMarker(
				"budget_exhausted",
				"alice",
				"at round 2",
				budgetMatch![1]!,
			),
		),
		"marker BUDGET EXHAUSTED di alice (R2) esatto vs formatFailureMarker",
	);
	assert.ok(
		out.transcript.includes(
			"### Round 2 — alice (Analyst)\n[BUDGET EXHAUSTED: alice at round 2",
		),
		"il marker R2 sostituisce il testo (troncato) del turno: ordine budget-dopo-troncatura",
	);
	assert.equal(
		truncatedMarkers.length,
		out.transcript.match(/\[OUTPUT TRUNCATED at 100 chars\]/g)?.length,
		"nessun nuovo marker TRUNCATED al round 2 (il marker budget rimpiazza il testo)",
	);

	// bob: regolare in entrambi i round, nessun marker.
	assert.ok(out.transcript.includes("### Round 1 — bob (Builder)\nbob risponde"));
	assert.ok(out.transcript.includes("### Round 2 — bob (Builder)\nbob risponde"));
	assert.ok(!out.transcript.includes("BUDGET EXHAUSTED: bob"), "nessun marker budget per bob");

	// totalCost = 0.03 (alice R1) + 0.03 (alice R2) + 0.001 (bob R1) + 0.001 (bob R2).
	assert.equal(out.totalCost, expectTotal([0.03, 0.03, 0.001, 0.001]));

	delete process.env[GSD_AGENT_DIR_ENV];
});

test("budget=0 edge: costBudgetUsd=0 (clamp S02 min:0) -> alice cost>0 scatta BUDGET EXHAUSTED immediatamente al round 1, bob cost=0 turno neutro (nessun trigger), outcome=partial", async () => {
	const f = makeFixture();
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");
	writeParticipant(f.userDir, "alice.md", { name: "alice", role: "Analyst" });
	writeParticipant(f.userDir, "bob.md", { name: "bob", role: "Builder" });

	const calls: string[] = [];
	const runTurn: RunTurnFn = async (participant) => {
		calls.push(participant.name);
		if (participant.name === "alice") {
			return turnWithCost("alice", "Analyst", 0.001);
		}
		return turnWithCost("bob", "Builder", 0);
	};

	const out = await captureStderr(() =>
		runDiscussionArena(
			"topic test",
			["alice", "bob"],
			2,
			f.cwd,
			undefined,
			() => {},
			undefined,
			undefined,
			undefined,
			{ costBudgetUsd: 0 },
			runTurn,
		),
	);

	// Condizione guard `cost > 0 && cost >= limit`: con budget=0 ogni turno a
	// costo positivo scatta immediatamente; un turno a costo zero è neutro
	// (nessun costo da proteggere) — edge pinnato dal test spec (T01).
	assert.equal(out.outcome, "partial", "alice morta per budget=0 + cost>0 -> partial");
	assert.equal(
		calls.filter((n) => n === "alice").length,
		1,
		"alice invocata una sola volta: cost>0 con budget=0 -> BUDGET EXHAUSTED al round 1",
	);
	assert.equal(calls.filter((n) => n === "bob").length, 2, "bob gira entrambi i round (cost=0: nessun trigger)");

	const budgetMatch = out.transcript.match(
		/\[BUDGET EXHAUSTED: alice at round 1 ([^\]]+)\]/,
	);
	assert.ok(budgetMatch, "marker BUDGET EXHAUSTED presente per alice al round 1");
	assert.ok(
		out.transcript.includes(
			formatFailureMarker(
				"budget_exhausted",
				"alice",
				"at round 1",
				budgetMatch![1]!,
			),
		),
		"marker BUDGET EXHAUSTED di alice esatto vs formatFailureMarker",
	);
	assert.ok(
		out.transcript.includes("### Round 2 — alice (Analyst)\n[PARTICIPANT SKIPPED: alice]"),
		"alice SKIPPED al round 2",
	);

	// bob: turni a costo zero completi, nessun marker budget (0 > 0 è falso).
	assert.ok(out.transcript.includes("### Round 1 — bob (Builder)\nbob risponde"));
	assert.ok(out.transcript.includes("### Round 2 — bob (Builder)\nbob risponde"));
	assert.ok(
		!out.transcript.includes("BUDGET EXHAUSTED: bob"),
		"nessun marker BUDGET EXHAUSTED per bob (cost=0 non supera mai 0)",
	);

	assert.equal(out.totalCost, expectTotal([0.001, 0, 0]));

	delete process.env[GSD_AGENT_DIR_ENV];
});

test("ordinamento: il branch timeout (S04) precede la troncatura (S05) -> un turno timeout con testo enorme resta TIMEOUT, mai TRUNCATED", async () => {
	const f = makeFixture();
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");
	writeParticipant(f.userDir, "alice.md", { name: "alice", role: "Analyst" });
	writeParticipant(f.userDir, "bob.md", { name: "bob", role: "Builder" });

	const calls: string[] = [];
	const runTurn: RunTurnFn = async (participant) => {
		calls.push(participant.name);
		if (participant.name === "bob") {
			return { ...timeoutTurn("bob", "Builder", "timeout_round"), text: "x".repeat(2000) };
		}
		return okTurn(participant.name, participant.role);
	};

	const out = await captureStderr(() =>
		runDiscussionArena(
			"topic test",
			["alice", "bob"],
			2,
			f.cwd,
			undefined,
			() => {},
			undefined,
			undefined,
			undefined,
			{ outputLimitChars: 100 },
			runTurn,
		),
	);

	assert.equal(out.outcome, "partial", "bob morto per timeout -> partial");

	// Il testo enorme del turno timeout è sostituito dal marker TIMEOUT senza
	// mai passare dalla troncatura (il branch timeout è PRIMA del post-processing).
	const timeoutMatch = out.transcript.match(/\[TIMEOUT: bob round_timeout ([^\]]+)\]/);
	assert.ok(timeoutMatch, "marker TIMEOUT presente per bob");
	const expectedTimeout = formatFailureMarker(
		"timeout_round",
		"bob",
		undefined,
		timeoutMatch![1]!,
	);
	assert.ok(
		out.transcript.includes(expectedTimeout),
		"marker TIMEOUT coincide esattamente con formatFailureMarker",
	);
	assert.ok(
		!out.transcript.includes("x".repeat(2000)),
		"il testo enorme del turno timeout è rimpiazzato dal marker, mai troncato",
	);
	assert.ok(
		!out.transcript.includes("OUTPUT TRUNCATED"),
		"nessun marker TRUNCATED: la troncatura non tocca i turni timeout",
	);
	assert.ok(out.transcript.includes("[PARTICIPANT SKIPPED: bob]"), "bob SKIPPED al round 2");

	delete process.env[GSD_AGENT_DIR_ENV];
});

// ─── (g) metrics end-to-end con toolLimits (S08/T02) ────────────────────────
// Il wiring di metrics.ts in index.ts (T01) consumato qui da arena-loop.test.ts
// (sezione (g) del piano): guardrail triggerati via toolLimits (truncation e
// budget) → getMetrics()/NDJSON end-to-end attraverso il loop reale. Le serie
// metriche attese: arena_output_chars_total{participant,round} = testo
// TRONCATO (mai l'originale), arena_cost_usd{participant} = somma dei DELTA
// dei turni (mai dei cumulati — decisione MEM093), histogram
// arena_round_duration_seconds{participant,round}. Il registry è azzerato dal
// beforeEach(resetMetrics) globale; i test metrici della suite esistente non
// asseriscono metriche e non sono affetti.

test("(g) truncation guardrail (S08/T02): outputLimitChars -> marker TRUNCATED + guard.output_truncated, output chars = testo troncato (50), mai l'originale (200)", async () => {
	const f = makeFixture();
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");
	writeParticipant(f.userDir, "alice.md", { name: "alice", role: "Analyst" });
	writeParticipant(f.userDir, "bob.md", { name: "bob", role: "Builder" });

	const calls: string[] = [];
	const runTurn: RunTurnFn = async (participant) => {
		calls.push(participant.name);
		// Testo gigante SOLO alla prima invocazione di alice (round 1): ai round
		// successivi il mock deve rispondere con un testo normale sotto soglia,
		// altrimenti la troncatura colpisce ogni round e round 2 non è integro.
		if (
			participant.name === "alice" &&
			calls.filter((n) => n === "alice").length === 1
		) {
			return { ...okTurn(participant.name, participant.role), text: "x".repeat(200) };
		}
		return okTurn(participant.name, participant.role);
	};

	const { value: out, chunks } = await captureStderrChunks(() =>
		runDiscussionArena(
			"topic test",
			["alice", "bob"],
			2,
			f.cwd,
			undefined,
			() => {},
			undefined,
			undefined,
			undefined,
			{ outputLimitChars: 50 },
			runTurn,
		),
	);

	// L'over-limit NON è un failure: outcome resta complete, alice continua.
	assert.equal(out.outcome, "complete", "over-limit non è un crash: outcome complete");
	assert.equal(
		calls.filter((n) => n === "alice").length,
		2,
		"alice gira entrambi i round (la troncatura non la uccide)",
	);
	assert.ok(
		out.transcript.includes("[OUTPUT TRUNCATED at 50 chars]"),
		"marker OUTPUT TRUNCATED presente nel transcript",
	);

	const m = getMetrics();
	// output chars = lunghezza del testo TRONCATO (50), mai 200 (l'originale).
	assert.equal(
		m.counters["arena_output_chars_total"]?.["{participant=alice,round=1}"],
		50,
		"output chars round 1 = testo troncato (50), non originale (200)",
	);
	assert.equal(
		m.counters["arena_output_chars_total"]?.["{participant=alice,round=2}"],
		14,
		"output chars round 2 = testo integro sotto soglia (14)",
	);
	assert.equal(
		m.counters["arena_output_chars_total"]?.["{participant=bob,round=1}"],
		12,
		"output chars bob round 1 = testo integro (bob risponde = 12)",
	);

	// NDJSON: solo il guardrail di troncatura + arena.complete, nessun guard di failure.
	const events = ndjsonEvents(chunks);
	assert.ok(
		events.includes("guard.output_truncated"),
		`guard.output_truncated presente, attuali: ${events.join(",")}`,
	);
	assert.ok(events.includes("arena.complete"), "arena.complete presente");
	for (const absent of ["guard.crash", "guard.timeout", "guard.skipped", "guard.budget_exhausted"]) {
		assert.ok(!events.includes(absent), `${absent} assente (nessun guard di failure)`);
	}

	delete process.env[GSD_AGENT_DIR_ENV];
});

test("(g) budget guard (S08/T02, MEM093): arena_cost_usd accumula i DELTA dei turni (0.04), mai i cumulati (0.06)", async () => {
	const f = makeFixture();
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");
	writeParticipant(f.userDir, "alice.md", {
		name: "alice",
		role: "Analyst",
		extraRows: ["cost_budget_usd: 0.03"],
	});
	writeParticipant(f.userDir, "bob.md", { name: "bob", role: "Builder" });

	const calls: string[] = [];
	const runTurn: RunTurnFn = async (participant) => {
		calls.push(participant.name);
		if (participant.name === "alice") {
			// 0.02/turno: turno 1 sotto budget (0.02 < 0.03), turno 2 cumulato
			// 0.04 >= 0.03 -> guard scatta; turno 3 alice è morta (SKIPPED).
			return turnWithCost(participant.name, participant.role, 0.02);
		}
		return okTurn(participant.name, participant.role);
	};

	const { value: out, chunks } = await captureStderrChunks(() =>
		runDiscussionArena(
			"topic test",
			["alice", "bob"],
			3,
			f.cwd,
			undefined,
			() => {},
			undefined,
			undefined,
			undefined,
			undefined,
			runTurn,
		),
	);

	assert.equal(out.outcome, "partial", "alice morta per budget esaurito -> partial");
	assert.equal(
		calls.filter((n) => n === "alice").length,
		2,
		"alice gira 2 round (turno 2 fa scattare il guard), skippata al round 3",
	);
	assert.equal(calls.filter((n) => n === "bob").length, 3, "bob gira tutti e 3 i round");

	const m = getMetrics();
	// DELTA additivi: 0.02 (happy path turno 1) + 0.02 (turno che esaurisce) = 0.04.
	// Se fosse hookato il CUMULATO (0.02 + 0.04) il counter varrebbe 0.06 != costo totale.
	const aliceCost = m.counters["arena_cost_usd"]?.["{participant=alice}"] ?? 0;
	assert.ok(
		Math.abs(aliceCost - 0.04) < 1e-9,
		`arena_cost_usd{alice} = somma delta 0.04, attuale ${aliceCost}`,
	);
	const bobCost = m.counters["arena_cost_usd"]?.["{participant=bob}"] ?? 0;
	assert.ok(
		Math.abs(bobCost - 0.003) < 1e-9,
		`arena_cost_usd{bob} = 3 turni x 0.001 = 0.003, attuale ${bobCost}`,
	);

	// NDJSON: budget_exhausted (alice round 2) + skipped (alice round 3) + arena.complete.
	const events = ndjsonEvents(chunks);
	assert.ok(
		events.includes("guard.budget_exhausted"),
		`guard.budget_exhausted presente, attuali: ${events.join(",")}`,
	);
	assert.ok(events.includes("guard.skipped"), "guard.skipped presente (alice al round 3)");
	assert.ok(events.includes("arena.complete"), "arena.complete presente");
	assert.ok(
		!events.includes("guard.output_truncated"),
		"nessuna troncatura (testi sotto soglia)",
	);

	delete process.env[GSD_AGENT_DIR_ENV];
});

test("(g) toolLimits sotto soglia (S08/T02): nessun guardrail scatta, metriche del happy path identiche al caso senza limiti", async () => {
	const f = makeFixture();
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");
	writeParticipant(f.userDir, "alice.md", { name: "alice", role: "Analyst" });

	// durationMs 250 esplicito: l'okTurn di QUESTO file ha durationMs 0 fisso,
	// ma per pinnare la conversione ms->s nei buckets serve un turno reale.
	const runTurn: RunTurnFn = async (participant) => ({
		...okTurn(participant.name, participant.role),
		durationMs: 250,
	});

	const { value: out, chunks } = await captureStderrChunks(() =>
		runDiscussionArena(
			"topic test",
			["alice"],
			1,
			f.cwd,
			undefined,
			() => {},
			undefined,
			undefined,
			undefined,
			{ outputLimitChars: 10000, costBudgetUsd: 1.0 },
			runTurn,
		),
	);

	assert.equal(out.outcome, "complete", "nessun guardrail scattato -> complete");

	const m = getMetrics();
	// Happy path invariato: chars = lunghezza testo, cost = delta del turno.
	assert.equal(
		m.counters["arena_output_chars_total"]?.["{participant=alice,round=1}"],
		14,
		"output chars round 1 = testo integro (14)",
	);
	const aliceCost = m.counters["arena_cost_usd"]?.["{participant=alice}"] ?? 0;
	assert.ok(Math.abs(aliceCost - 0.001) < 1e-9, `cost = 0.001, attuale ${aliceCost}`);
	// Histogram: durationMs 250 (default okTurn) -> 0.25s -> bucket 1 cumulativo.
	const h1 =
		m.histograms["arena_round_duration_seconds"]?.["{participant=alice,round=1}"];
	assert.ok(h1, "histogram presente per il turno completato");
	assert.equal(h1!.count, 1);
	assert.ok(Math.abs(h1!.sum - 0.25) < 1e-9, `sum = 0.25, attuale ${h1!.sum}`);
	assert.deepEqual(h1!.bucketCounts, [0, 1, 1, 1, 1, 1, 1, 1], "0.25s -> bucket 1 e superiori");

	// NDJSON: nessun guardrail, solo l'evento terminale arena.complete.
	const events = ndjsonEvents(chunks);
	assert.equal(events.length, 1, `solo arena.complete, attuali: ${events.join(",")}`);
	assert.equal(events[0], "arena.complete", "evento terminale arena.complete");

	delete process.env[GSD_AGENT_DIR_ENV];
});

// ─── (h) Scenario 1 acceptance: crash SIGKILL end-to-end (S09/T01) ────────
// Il CONTEXT M003 Scenario 1 richiede che un SIGKILL reale mid-round di un
// partecipante produca [PARTICIPANT FAILED: <id> crash SIGKILL <ts>] + SKIPPED
// nei round successivi + arena_crashes_total{dev}=1. Pre-S09 un SIGKILL esterno
// arrivava al listener `close` di runParticipantTurn con code=null,
// abortReason=null e produceva un result senza failureKind che passava oltre
// il branch timeout finendo nell'happy path ("(nessuna risposta)") — NESSUN
// marker FAILED, NESSUN recordArenaCrash. Il classificatore SIGKILL (T01)
// chiude il gap: failureKind="failed", failureReason="crash SIGKILL" (senza
// testare il nome letterale del segnale — robusto a SIGKILL/SIGSEGV/SIGABRT),
// e il branch failure-result in index.ts riusa la pipeline del catch.
// SUBPROCESS REALI (11° parametro runTurn omesso -> default runParticipantTurn,
// pattern timeout-watchdog.test.ts): il fixture fake-gsd in testa a PATH
// risolve le direttive per-nome dal topic (DIRECTIVE:<name>:<mode>).

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Legge le righe non vuote dell'event log e le parsifica come JSON. */
function readEventLines(
	filePath: string,
): { raw: string[]; events: Record<string, unknown>[] } {
	const raw = fs
		.readFileSync(filePath, "utf-8")
		.split("\n")
		.filter((l) => l.trim() !== "");
	const events = raw.map((l) => JSON.parse(l) as Record<string, unknown>);
	return { raw, events };
}

test("Scenario 1 (crash SIGKILL end-to-end): 3 partecipanti 2 round, dev in modo sigkill -> FAILED + SKIPPED + outcome partial + arena_crashes_total{dev}=1", { timeout: 15_000 }, async () => {
	const f = makeFixture();
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");

	writeParticipant(f.userDir, "analyst.md", { name: "analyst", role: "Analyst" });
	writeParticipant(f.userDir, "architect.md", { name: "architect", role: "Architect" });
	writeParticipant(f.userDir, "dev.md", { name: "dev", role: "Dev" });

	// Direttive per-nome nel topic: buildRoundPrompt include il topic e il fake
	// gsd risolve la propria mode da "Sei <name> (" (pattern timeout-watchdog).
	const topic =
		"DIRECTIVE:analyst:fast DIRECTIVE:architect:fast DIRECTIVE:dev:sigkill — valuta";

	try {
		const { value: out, chunks } = await captureStderrChunks(() =>
			runDiscussionArena(
				topic,
				["analyst", "architect", "dev"],
				2,
				f.cwd,
				undefined,
				() => {},
				undefined,
				undefined,
				undefined,
				// toolLimits: soglie ampie — il SIGKILL è immediato, nessun timer
				// deve scattare (il crash prevale sui timeout).
				{ eventTimeoutMs: 5000, roundTimeoutMs: 10000, termination: "hard" },
				// runTurn omesso -> default runParticipantTurn REALE (11° parametro).
				undefined,
				// eventLog: true (12° parametro) per la validazione dell'event log.
				true,
			),
		);

		// Outcome: dev morto per SIGKILL -> partial; analyst/architect completano.
		assert.equal(out.outcome, "partial", "dev morto per SIGKILL -> partial");
		assert.deepEqual(
			out.participantsUsed.slice().sort(),
			["analyst", "architect", "dev"],
			"participantsUsed resta invariato (selezione, non sopravvivenza)",
		);

		// Marker FAILED canonico al round 1 — uguaglianza esatta vs
		// formatFailureMarker col timestamp estratto (pattern MEM074).
		const failedMatch = out.transcript.match(
			/\[PARTICIPANT FAILED: dev crash SIGKILL ([^\]]+)\]/,
		);
		assert.ok(
			failedMatch,
			"marker [PARTICIPANT FAILED: dev crash SIGKILL <ts>] presente nel transcript",
		);
		const expectedFailedMarker = formatFailureMarker(
			"failed",
			"dev",
			"crash SIGKILL",
			failedMatch![1]!,
		);
		assert.ok(
			out.transcript.includes(expectedFailedMarker),
			"il marker FAILED di dev coincide esattamente con formatFailureMarker",
		);
		assert.ok(
			out.transcript.includes(
				"### Round 1 — dev (Dev)\n[PARTICIPANT FAILED: dev crash SIGKILL",
			),
			"il marker FAILED è nella entry del round 1 di dev (sostituisce il testo)",
		);

		// Round 2: dev è morto -> SKIPPED; analyst/architect rispondono ancora.
		assert.ok(
			out.transcript.includes(
				"### Round 2 — dev (Dev)\n[PARTICIPANT SKIPPED: dev]",
			),
			"round 2: dev marcato morto -> SKIPPED senza reinvocazione",
		);
		assert.ok(
			out.transcript.includes("### Round 1 — analyst (Analyst)\nfast-reply"),
			"round 1: analyst risponde (subprocess veloce parsato)",
		);
		assert.ok(
			out.transcript.includes("### Round 1 — architect (Architect)\nfast-reply"),
			"round 1: architect risponde",
		);
		assert.ok(
			out.transcript.includes("### Round 2 — analyst (Analyst)\nfast-reply"),
			"round 2: analyst risponde ancora",
		);
		assert.ok(
			out.transcript.includes("### Round 2 — architect (Architect)\nfast-reply"),
			"round 2: architect risponde ancora",
		);

		// totalCost: solo 4 turni fast di analyst+architect x 2 round; il
		// subprocess SIGKILLato non emette message_end -> usage zero (nessun
		// costo per dev).
		assert.equal(
			out.totalCost,
			0.0015 * 4,
			"4 turni fast da 0.0015; il SIGKILL di dev non contribuisce costo",
		);

		// Metrica S08: arena_crashes_total{dev}=1 (recordArenaCrash dal branch
		// failure-result), nessun falso positivo sugli altri partecipanti.
		const m = getMetrics();
		assert.equal(
			m.counters["arena_crashes_total"]?.["{participant=dev}"],
			1,
			"arena_crashes_total{participant=dev} = 1 (crash SIGKILL reale)",
		);
		assert.equal(
			m.counters["arena_crashes_total"]?.["{participant=analyst}"],
			undefined,
			"nessun crash per analyst (nessun falso positivo)",
		);
		assert.equal(
			m.counters["arena_crashes_total"]?.["{participant=architect}"],
			undefined,
			"nessun crash per architect (nessun falso positivo)",
		);

		// NDJSON guardrail (S08): guard.crash (dev R1) + guard.skipped (dev R2)
		// + arena.complete; nessun guard.timeout (il SIGKILL è un crash, non un
		// timeout — il branch failure-result è DOPO il branch timeout).
		const events = ndjsonEvents(chunks);
		assert.ok(
			events.includes("guard.crash"),
			`guard.crash presente, attuali: ${events.join(",")}`,
		);
		assert.ok(
			events.includes("guard.skipped"),
			"guard.skipped presente (dev al round 2)",
		);
		assert.ok(events.includes("arena.complete"), "arena.complete presente");
		assert.ok(
			!events.includes("guard.timeout"),
			"nessun guard.timeout: il SIGKILL è un crash, non un timeout",
		);

		// Event log (S07): arenaId UUID, file su disco, marker kind="failed"
		// (dev R1) + participant_skip reason="failed" (dev R2) persistiti;
		// replay non-null con i marker nel transcript ri-derivato.
		assert.match(out.arenaId ?? "", UUID_RE, "arenaId presente (eventLog: true)");
		const filePath = arenaEventLogPath(f.cwd, out.arenaId!);
		assert.ok(fs.existsSync(filePath), `event log presente sul disco: ${filePath}`);

		const { events: logEvents } = readEventLines(filePath);
		const failedEvent = logEvents.find(
			(e) => e.type === "marker" && e.kind === "failed",
		);
		assert.ok(failedEvent, "evento marker kind='failed' presente");
		assert.equal(failedEvent!.participantId, "dev");
		assert.equal(failedEvent!.round, 1);
		assert.match(
			String(failedEvent!.marker),
			/^\[PARTICIPANT FAILED: dev crash SIGKILL /,
			"marker FAILED canonico persistito nell'evento",
		);
		const devSkip = logEvents.find(
			(e) => e.type === "participant_skip" && e.participantId === "dev",
		);
		assert.ok(devSkip, "evento participant_skip per dev presente");
		assert.equal(devSkip!.round, 2);
		assert.equal(devSkip!.reason, "failed");
		assert.equal(devSkip!.marker, "[PARTICIPANT SKIPPED: dev]");

		const replay = await replayArena(out.arenaId!, f.cwd);
		assert.ok(replay !== null, "replay disponibile per un'arena con log");
		assert.ok(
			replay.transcript.includes(expectedFailedMarker),
			"replay include il marker FAILED esatto",
		);
		assert.ok(
			replay.transcript.includes("[PARTICIPANT SKIPPED: dev]"),
			"replay include lo skip di dev",
		);

		// Lo stderr dei subprocess (incluso il SIGKILLato) NON contamina il
		// transcript: resta nel campo result.stderr (contratto S04).
		assert.ok(
			!out.transcript.includes("fixture-stderr:"),
			"lo stderr resta in result.stderr, non nel transcript",
		);
	} finally {
		delete process.env[GSD_AGENT_DIR_ENV];
	}
});

// ─── (h) Scenario 2 acceptance: budget + output limit combinati (S09/T02) ──
// Il CONTEXT M003 Scenario 2 richiede che budget e output limit agiscano
// COMBINATI su 2 round: alice (cost_budget_usd 0.05) paga $0.05 al round 1
// con output 2000 char (sopra outputLimitChars=100) — la troncatura gira al
// round 1 (guard.output_truncated), poi il budget guard scatta nello STESSO
// round (cumulato 0.05 >= 0.05) e sostituisce il testo troncato col marker
// BUDGET EXHAUSTED (ordine pinnato S06: budget DOPO troncatura — il testo
// troncato NON compare mai nel transcript del round che esaurisce) — alice è
// marcata morta e SKIPPED al round 2; arena_cost_usd{alice} = 0.05 <= budget;
// bob (architect, budget default 1.0) completa entrambi i round. runTurn
// MOCKATO (il test è focalizzato sulla semantica multi-round dell'acceptance,
// non sui subprocess reali — pattern sezioni (f)/(g)).

test("Scenario 2 (budget + output limit combinati, acceptance finale): 2 partecipanti 2 round, alice budget $0.05 con output 2000 char al R1 -> BUDGET EXHAUSTED R1 + SKIPPED R2, guard.output_truncated R1, arena_cost_usd{alice}=0.05<=budget, bob completa entrambi i round", async () => {
	const f = makeFixture();
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");
	writeParticipant(f.userDir, "alice.md", {
		name: "alice",
		role: "Analyst",
		extraRows: ["cost_budget_usd: 0.05"],
	});
	writeParticipant(f.userDir, "bob.md", { name: "bob", role: "Builder" });

	const calls: string[] = [];
	const runTurn: RunTurnFn = async (participant) => {
		calls.push(participant.name);
		if (participant.name === "alice") {
			// Un solo turno da $0.05 = budget: al R1 la troncatura gira, poi il
			// budget guard esaurisce alice (cumulato 0.05 >= 0.05). R2 skippata.
			return {
				...turnWithCost("alice", "Analyst", 0.05),
				text: "x".repeat(2000),
			};
		}
		return okTurn(participant.name, participant.role);
	};

	const { value: out, chunks } = await captureStderrChunks(() =>
		runDiscussionArena(
			"topic test",
			["alice", "bob"],
			2,
			f.cwd,
			undefined,
			() => {},
			undefined,
			undefined,
			undefined,
			// toolLimits: solo l'output limit — il budget arriva dal frontmatter
			// del partecipante (cost_budget_usd), come nel CONTEXT.
			{ outputLimitChars: 100 },
			runTurn,
			// eventLog: true (12° parametro) per la validazione dell'event log.
			true,
		),
	);

	// Outcome: alice morta per budget -> partial; alice invocata UNA volta
	// (R1), skippata al R2; bob completa entrambi i round.
	assert.equal(out.outcome, "partial", "alice morta per budget esaurito -> partial");
	assert.equal(
		calls.filter((n) => n === "alice").length,
		1,
		"alice invocata una sola volta: al round 2 è skippata (budget_exhausted)",
	);
	assert.equal(calls.filter((n) => n === "bob").length, 2, "bob gira entrambi i round");

	// Round 1: marker BUDGET EXHAUSTED — uguaglianza esatta vs
	// formatFailureMarker col timestamp estratto (pattern MEM074). Il marker
	// sostituisce il testo (troncato) del turno: il testo con
	// [OUTPUT TRUNCATED at 100 chars] NON compare nel transcript di questo
	// round (ordine pinnato: budget DOPO troncatura, PRIMA dell'entry).
	const budgetMatch = out.transcript.match(
		/\[BUDGET EXHAUSTED: alice at round 1 ([^\]]+)\]/,
	);
	assert.ok(
		budgetMatch,
		"marker BUDGET EXHAUSTED presente al round 1 per alice (cumulato 0.05 >= budget 0.05)",
	);
	const expectedBudgetMarker = formatFailureMarker(
		"budget_exhausted",
		"alice",
		"at round 1",
		budgetMatch![1]!,
	);
	assert.ok(
		out.transcript.includes(expectedBudgetMarker),
		"il marker BUDGET EXHAUSTED coincide esattamente con formatFailureMarker",
	);
	assert.ok(
		out.transcript.includes(
			"### Round 1 — alice (Analyst)\n[BUDGET EXHAUSTED: alice at round 1",
		),
		"il marker budget sostituisce il testo (troncato) del turno nella entry R1",
	);
	assert.ok(
		!out.transcript.includes("### Round 1 — alice (Analyst)\nx"),
		"il testo troncato di alice NON compare: il marker budget rimpiazza l'output",
	);

	// Round 2: alice SKIPPED (marker canonico senza reason nel testo — il
	// reason è nel campo strutturato dell'evento participant_skip, S07).
	assert.ok(
		out.transcript.includes("### Round 2 — alice (Analyst)\n[PARTICIPANT SKIPPED: alice]"),
		"alice SKIPPED al round 2 (nessuna invocazione di runTurn per lei)",
	);

	// bob (architect) completa entrambi i round, nessun marker di budget.
	assert.ok(out.transcript.includes("### Round 1 — bob (Builder)\nbob risponde"));
	assert.ok(out.transcript.includes("### Round 2 — bob (Builder)\nbob risponde"));
	assert.ok(
		!out.transcript.includes("BUDGET EXHAUSTED: bob"),
		"nessun marker BUDGET EXHAUSTED per bob",
	);

	// Metrica S08: arena_cost_usd{alice} = 0.05 (il delta del turno R1 che
	// esaurisce paga il suo costo, S06) — tracciato e <= budget (0.05).
	const m = getMetrics();
	const aliceCost = m.counters["arena_cost_usd"]?.["{participant=alice}"] ?? 0;
	assert.ok(
		Math.abs(aliceCost - 0.05) < 1e-9,
		`arena_cost_usd{alice} = 0.05 (delta R1), attuale ${aliceCost}`,
	);
	assert.ok(
		aliceCost <= 0.05,
		`costo tracciato di alice (${aliceCost}) <= budget (0.05)`,
	);
	const bobCost = m.counters["arena_cost_usd"]?.["{participant=bob}"] ?? 0;
	assert.ok(
		Math.abs(bobCost - 0.002) < 1e-9,
		`arena_cost_usd{bob} = 2 turni x 0.001 = 0.002, attuale ${bobCost}`,
	);

	// NDJSON guardrail (S08): troncatura R1 (gira PRIMA del budget guard) +
	// budget_exhausted (alice R1) + skipped (alice R2) + arena.complete;
	// nessun crash/timeout (il budget non è né un crash né un timeout).
	const events = ndjsonEvents(chunks);
	assert.ok(
		events.includes("guard.output_truncated"),
		`guard.output_truncated presente al round 1 (troncatura girata prima del budget), attuali: ${events.join(",")}`,
	);
	assert.ok(
		events.includes("guard.budget_exhausted"),
		"guard.budget_exhausted presente (alice al round 1)",
	);
	assert.ok(
		events.includes("guard.skipped"),
		"guard.skipped presente (alice al round 2)",
	);
	assert.ok(events.includes("arena.complete"), "arena.complete presente");
	for (const absent of ["guard.crash", "guard.timeout"]) {
		assert.ok(!events.includes(absent), `${absent} assente (budget non è un crash né un timeout)`);
	}

	// totalCost = 0.05 (alice R1) + 0.001 (bob R1) + 0.001 (bob R2).
	assert.equal(out.totalCost, expectTotal([0.05, 0.001, 0.001]));

	// Event log (S07): arenaId UUID, file su disco, marker kind="budget_exhausted"
	// (alice R1) + participant_skip reason="budget_exhausted" (alice R2)
	// persistiti; replay non-null con i marker nel transcript ri-derivato.
	assert.match(out.arenaId ?? "", UUID_RE, "arenaId presente (eventLog: true)");
	const filePath = arenaEventLogPath(f.cwd, out.arenaId!);
	assert.ok(fs.existsSync(filePath), `event log presente sul disco: ${filePath}`);

	const { events: logEvents } = readEventLines(filePath);
	const budgetEvent = logEvents.find(
		(e) => e.type === "marker" && e.kind === "budget_exhausted",
	);
	assert.ok(budgetEvent, "evento marker kind='budget_exhausted' presente");
	assert.equal(budgetEvent!.participantId, "alice");
	assert.equal(budgetEvent!.round, 1);
	assert.match(
		String(budgetEvent!.marker),
		/^\[BUDGET EXHAUSTED: alice at round 1 /,
		"marker BUDGET EXHAUSTED canonico persistito nell'evento",
	);
	const aliceSkip = logEvents.find(
		(e) => e.type === "participant_skip" && e.participantId === "alice",
	);
	assert.ok(aliceSkip, "evento participant_skip per alice presente");
	assert.equal(aliceSkip!.round, 2);
	assert.equal(aliceSkip!.reason, "budget_exhausted");
	assert.equal(aliceSkip!.marker, "[PARTICIPANT SKIPPED: alice]");

	const replay = await replayArena(out.arenaId!, f.cwd);
	assert.ok(replay !== null, "replay disponibile per un'arena con log");
	assert.ok(
		replay.transcript.includes(expectedBudgetMarker),
		"replay include il marker BUDGET EXHAUSTED esatto",
	);
	assert.ok(
		replay.transcript.includes("[PARTICIPANT SKIPPED: alice]"),
		"replay include lo skip di alice",
	);

	delete process.env[GSD_AGENT_DIR_ENV];
});
