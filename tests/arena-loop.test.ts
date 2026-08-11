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
 *
 * I marker sono verificati per uguaglianza esatta di stringa contro
 * `formatFailureMarker` (contratto S01), non solo presenza/assenza — per la
 * componente timestamp (non deterministica) il valore viene estratto dal
 * transcript e riusato per ricostruire il marker atteso, così l'uguaglianza
 * resta esatta sui componenti deterministici (id, reason) senza dover
 * predire l'orologio di sistema.
 */

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { runDiscussionArena, type RunTurnFn } from "../index.js";
import { formatFailureMarker } from "../helpers.js";
import type { ParticipantTurnResult } from "../run-participant.js";
import { GSD_AGENT_DIR_ENV } from "./fixtures/pi-coding-agent-stub.js";

// ─── Fixture helpers (pattern participants.test.ts) ────────────────────────

/** Scrive un partecipante .md minimale (name/role/description) in `dir`. */
function writeParticipant(
	dir: string,
	filename: string,
	opts: { name: string; role: string; description?: string },
): void {
	const rows = [
		`name: ${opts.name}`,
		`role: ${opts.role}`,
		`description: ${opts.description ?? opts.name}`,
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
