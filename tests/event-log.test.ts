/**
 * Test dell'event log JSONL della discussion arena (M003/S07/T03).
 *
 * Suite formale annunciata in S07/T02 (Q7): verifica la superficie di
 * osservabilità persistente introdotta da T01 (replay.ts) e T02 (index.ts) —
 * eventi su disco, JSONL valido riga-per-riga, replay senza subprocess,
 * identità del transcript ri-derivato e comportamento fail-safe.
 *
 * Pattern:
 * - Fixture su `fs.mkdtempSync(os.tmpdir())` (pattern arena-loop.test.ts
 *   D022/D020): il `cwd` dell'arena è la tmpdir, quindi l'event log viene
 *   scritto in `<tmpdir>/.gsd/arena/events/<arenaId>.jsonl` — nessun test
 *   legge o scrive il `.gsd/` gitignorato del repository (Proof Level slice).
 * - `runTurn` mockato via injection (12° parametro di runDiscussionArena):
 *   nessun subprocess `gsd` reale viene spawnato, né durante la run né
 *   durante il replay (Pitfall 2 del RESEARCH: `replayArena` NON chiama
 *   `runTurn` — verificato contando le invocazioni del mock).
 * - Identità del transcript ri-derivato: per RESEARCH M003/S07 il replay non
 *   è byte-for-byte identico alla run (l'header ri-derivato omette il ruolo
 *   `(role)` che la run intercala nei blocchi `### Round N — id (role)`) —
 *   contiene però esattamente gli stessi messaggi/marker, lo stesso numero
 *   di round e gli stessi participantId nello stesso ordine di apparizione.
 *   `extractBlocks` normalizza il suffisso ruolo e confronta i blocchi
 *   (round, id, body) tra run e replay.
 */

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { runDiscussionArena, type RunTurnFn } from "../index.js";
import { arenaEventLogPath, replayArena, reconstructTranscript } from "../replay.js";
import type { ArenaEvent } from "../helpers.js";
import type { ParticipantTurnResult } from "../run-participant.js";
import { GSD_AGENT_DIR_ENV } from "./fixtures/pi-coding-agent-stub.js";

// ─── Fixture helpers (pattern arena-loop.test.ts / participants.test.ts) ───

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
 * Fixture su tmpdir: il cwd dell'arena è la tmpdir, quindi l'event log
 * JSONL finisce in `<tmpdir>/.gsd/arena/events/` e il `.gsd/` del repo
 * non viene mai toccato (Proof Level slice).
 */
function makeFixture(): Fixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-arena-eventlog-"));
	const userDir = path.join(root, "agent", "discussion-arena", "participants");
	fs.mkdirSync(userDir, { recursive: true });
	return { root, userDir, cwd: root };
}

const activeFixtures: string[] = [];
function track(root: string): void {
	activeFixtures.push(root);
}
afterEach(() => {
	// La env guida il discovery dei partecipanti utente (fixture): va ripulita
	// anche quando il singolo test non l'ha impostata (replay pure).
	delete process.env[GSD_AGENT_DIR_ENV];
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

/** Intercetta process.stderr.write durante `fn` e ritorna le righe catturate. */
async function collectStderr<T>(
	fn: () => Promise<T>,
): Promise<{ value: T; lines: string[] }> {
	const original = process.stderr.write.bind(process.stderr);
	const lines: string[] = [];
	process.stderr.write = ((chunk: unknown) => {
		lines.push(String(chunk));
		return true;
	}) as unknown as typeof process.stderr.write;
	try {
		const value = await fn();
		return { value, lines };
	} finally {
		process.stderr.write = original;
	}
}

/** Turno di successo deterministico per un dato partecipante (costo 0.001). */
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

interface Block {
	round: number;
	id: string;
	body: string;
}

/**
 * Estrae i blocchi `### Round N — id\n<corpo>` da un transcript. Il suffisso
 * `(role)` presente solo nel transcript della run originale viene
 * normalizzato (strippato), così run e replay diventano confrontabili
 * (RESEARCH M003/S07: identità contenutistica, non byte-for-byte).
 */
function extractBlocks(transcript: string): Block[] {
	const blocks: Block[] = [];
	for (const block of transcript.split(/\n\n(?=### Round \d+)/)) {
		const m = block.match(/^### Round (\d+) — (.+)$/m);
		if (!m) continue;
		const nl = block.indexOf("\n");
		const body = nl === -1 ? "" : block.slice(nl + 1);
		const id = m[2]!.replace(/\s*\([^)]*\)\s*$/, "").trim();
		blocks.push({ round: Number(m[1]), id, body });
	}
	return blocks;
}

// ─── Demo: 1 round / 1 partecipante ────────────────────────────────────────

/** Run deterministica 1 round / 1 partecipante con eventLog: true. */
async function runDemoArena(): Promise<{
	f: Fixture;
	out: Awaited<ReturnType<typeof runDiscussionArena>>;
	calls: string[];
}> {
	const f = makeFixture();
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");
	writeParticipant(f.userDir, "alice.md", { name: "alice", role: "Analyst" });
	const calls: string[] = [];
	const runTurn: RunTurnFn = async (participant) => {
		calls.push(participant.name);
		return okTurn(participant.name, participant.role);
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
			undefined,
			runTurn,
			true,
		),
	);
	return { f, out, calls };
}

test("demo: 1 round / 1 partecipante con eventLog: true scrive l'event log JSONL completo su disco", async () => {
	const { f, out, calls } = await runDemoArena();

	// arenaId UUID nel return (opt-in eventLog).
	assert.match(out.arenaId ?? "", UUID_RE, "arenaId presente e in formato UUID");
	assert.equal(calls.length, 1, "runTurn invocato una volta sola (1 round, 1 partecipante)");

	const filePath = arenaEventLogPath(f.cwd, out.arenaId!);
	assert.ok(fs.existsSync(filePath), `event log presente sul disco: ${filePath}`);

	const { raw, events } = readEventLines(filePath);
	assert.equal(raw.length, 7, "sequenza demo: 7 eventi");

	// Ogni riga del file è JSON valido con ts/type stringa (validità
	// riga-per-riga richiesta dal must-have slice).
	for (const [i, line] of raw.entries()) {
		const parsed = JSON.parse(line) as Record<string, unknown>;
		assert.equal(typeof parsed.ts, "string", `riga ${i}: ts stringa`);
		assert.equal(typeof parsed.type, "string", `riga ${i}: type stringa`);
	}

	assert.deepEqual(
		events.map((e) => e.type),
		[
			"arena_start",
			"round_start",
			"participant_start",
			"participant_message",
			"cost_update",
			"round_end",
			"arena_done",
		],
		"sequenza eventi della demo (T02)",
	);

	// Contenuto degli eventi chiave.
	const arenaStart = events[0]!;
	assert.equal(arenaStart.type, "arena_start");
	assert.equal(arenaStart.arenaId, out.arenaId);
	assert.equal(arenaStart.topic, "topic test");
	assert.deepEqual(arenaStart.participants, ["alice"]);
	assert.equal(arenaStart.rounds, 1);
	assert.equal(arenaStart.roundOffset, 0);

	const msg = events[3]!;
	assert.equal(msg.type, "participant_message");
	assert.equal(msg.participantId, "alice");
	assert.equal(msg.round, 1);
	assert.equal(msg.text, "alice risponde");
	assert.equal(msg.cost, 0.001);
	assert.equal(msg.totalCost, 0.001);

	const cost = events[4]!;
	assert.equal(cost.type, "cost_update");
	assert.equal(cost.participantId, "alice");
	assert.equal(cost.round, 1);
	assert.equal(cost.cost, 0.001);
	assert.equal(cost.totalCost, 0.001);

	const done = events[6]!;
	assert.equal(done.type, "arena_done");
	assert.equal(done.arenaId, out.arenaId);
	assert.equal(done.totalCost, 0.001);
	assert.equal(done.outcome, "complete");
	assert.deepEqual(done.participantsUsed, ["alice"]);
	assert.equal(
		done.transcript,
		out.transcript,
		"l'evento arena_done porta il transcript completo come riferimento",
	);
});

test("replay: reconstructTranscript ri-deriva il transcript della run senza rieseguire subprocess", async () => {
	const { f, out, calls } = await runDemoArena();
	const callsAfterRun = calls.length;

	const replay = await replayArena(out.arenaId!, f.cwd);
	assert.ok(replay !== null, "replay disponibile per un'arena con log");
	assert.equal(replay.eventCount, 7, "eventCount = numero di righe del log");
	assert.equal(
		replay.transcript,
		"### Round 1 — alice\nalice risponde",
		"transcript ri-derivato: header senza ruolo (RESEARCH: identità contenutistica, non byte-for-byte)",
	);
	assert.equal(
		calls.length,
		callsAfterRun,
		"replay NON invoca runTurn — nessun subprocess rieseguito (Pitfall 2 RESEARCH)",
	);

	// Identità contenutistica con la run: stessi blocchi round/partecipante/
	// corpo, nello stesso ordine (suffisso ruolo normalizzato).
	assert.deepEqual(extractBlocks(replay.transcript), extractBlocks(out.transcript));
});

test("event log valido: jq -c . esce 0 su ogni riga (skip se jq assente)", async (t) => {
	const { f, out } = await runDemoArena();
	const filePath = arenaEventLogPath(f.cwd, out.arenaId!);

	const result = await new Promise<{
		error: NodeJS.ErrnoException | null;
		stdout: string;
	}>((resolve) => {
		execFile(
			"jq",
			["-c", ".", filePath],
			{ maxBuffer: 16 * 1024 * 1024 },
			(error, stdout) => {
				resolve({ error: error as NodeJS.ErrnoException | null, stdout });
			},
		);
	});

	if (result.error?.code === "ENOENT") {
		t.skip("jq non presente nell'ambiente");
		return;
	}
	assert.equal(
		result.error,
		null,
		`jq -c . esce 0 su JSONL valido (errore: ${result.error?.message ?? "nessuno"})`,
	);
	const lines = result.stdout.split("\n").filter((l) => l.trim() !== "");
	assert.equal(lines.length, 7, "jq restituisce una riga per evento");
});

// ─── Guardrail: marker FAILED/TIMEOUT + skip persistiti e riprodotti ────────

test("guardrail: marker FAILED/TIMEOUT e participant_skip persistiti nell'event log e riprodotti dal replay", async () => {
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
		if (participant.name === "carol") {
			return {
				...okTurn(participant.name, participant.role),
				failureKind: "timeout_round" as const,
				failureReason: "round_timeout_ms superato",
			};
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
			true,
		),
	);
	assert.equal(out.outcome, "partial", "bob crash e carol timeout -> partial");
	// alice 2 round, bob 1 invocazione (crash r1, skip r2), carol 1 (timeout r1, skip r2).
	assert.equal(calls.length, 4, "alice x2 + bob x1 + carol x1");

	const filePath = arenaEventLogPath(f.cwd, out.arenaId!);
	const { raw, events } = readEventLines(filePath);

	// Marker di guardrail persistiti: FAILED (S03) e TIMEOUT (S04).
	const markers = events.filter((e) => e.type === "marker");
	assert.equal(markers.length, 2, "2 marker: kind failed + kind timeout_round");
	const failedMarker = markers.find((m) => m.kind === "failed");
	const timeoutMarker = markers.find((m) => m.kind === "timeout_round");
	assert.ok(failedMarker, "marker FAILED presente");
	assert.equal(failedMarker!.participantId, "bob");
	assert.equal(failedMarker!.round, 1);
	assert.match(String(failedMarker!.marker), /^\[PARTICIPANT FAILED: bob crash simulato /, "marker FAILED canonico");
	assert.ok(timeoutMarker, "marker TIMEOUT presente");
	assert.equal(timeoutMarker!.participantId, "carol");
	assert.equal(timeoutMarker!.round, 1);
	assert.match(String(timeoutMarker!.marker), /^\[TIMEOUT: carol round_timeout /, "marker TIMEOUT canonico");

	// Skip persistiti (S03): al round 2 bob/carol sono morti -> participant_skip.
	const skips = events.filter((e) => e.type === "participant_skip");
	assert.equal(skips.length, 2, "2 participant_skip (bob e carol al round 2)");
	const bobSkip = skips.find((s) => s.participantId === "bob");
	const carolSkip = skips.find((s) => s.participantId === "carol");
	assert.equal(bobSkip!.round, 2);
	assert.equal(bobSkip!.reason, "failed");
	assert.equal(bobSkip!.marker, "[PARTICIPANT SKIPPED: bob]");
	assert.equal(carolSkip!.round, 2);
	assert.equal(carolSkip!.reason, "timeout_round");
	assert.equal(carolSkip!.marker, "[PARTICIPANT SKIPPED: carol]");

	// Replay: ri-deriva i marker esattamente come emessi (stesso testo) senza
	// rieseguire subprocess — prova post-mortem dei guardrail S03-S06.
	const callsAfterRun = calls.length;
	const replay = await replayArena(out.arenaId!, f.cwd);
	assert.ok(replay !== null, "replay disponibile");
	assert.equal(replay.eventCount, raw.length, "eventCount = righe del log");
	for (const m of [failedMarker, timeoutMarker]) {
		assert.ok(
			replay!.transcript.includes(String(m!.marker)),
			`replay include il marker: ${m!.marker}`,
		);
	}
	assert.ok(replay.transcript.includes("[PARTICIPANT SKIPPED: bob]"));
	assert.ok(replay.transcript.includes("[PARTICIPANT SKIPPED: carol]"));
	assert.equal(calls.length, callsAfterRun, "replay non esegue subprocess");

	// Identità contenutistica run vs replay (ruolo normalizzato).
	assert.deepEqual(extractBlocks(replay.transcript), extractBlocks(out.transcript));
});

// ─── Fail-safe: errore di scrittura ────────────────────────────────────────

test("fail-safe: errore di scrittura dell'event log -> warning su stderr, la run non si interrompe", async () => {
	const f = makeFixture();
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");
	writeParticipant(f.userDir, "alice.md", { name: "alice", role: "Analyst" });

	// Un file regolare su <cwd>/.gsd rende impossibile il mkdir ricorsivo di
	// <cwd>/.gsd/arena/events (ENOTDIR): ogni emitEvent fallisce con warning.
	fs.writeFileSync(
		path.join(f.cwd, ".gsd"),
		"sono un file, non una directory\n",
		"utf-8",
	);

	const calls: string[] = [];
	const runTurn: RunTurnFn = async (participant) => {
		calls.push(participant.name);
		return okTurn(participant.name, participant.role);
	};
	const { value: out, lines } = await collectStderr(() =>
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
			undefined,
			runTurn,
			true,
		),
	);

	// La run resta valida: outcome/transcript/costo identici alla run normale
	// (l'event log è osservabilità, non un requisito di correttezza).
	assert.equal(out.outcome, "complete");
	assert.ok(out.transcript.includes("### Round 1 — alice (Analyst)\nalice risponde"));
	assert.equal(out.totalCost, 0.001);
	assert.match(out.arenaId ?? "", UUID_RE, "arenaId comunque generato e ritornato");
	assert.equal(calls.length, 1, "il loop ha comunque eseguito il turno");

	// I fallimenti di scrittura sono visibili come warning su stderr
	// (superficie di diagnosi post-mortem richiesta dalla slice).
	assert.ok(
		lines.some((l) => l.includes("[discussion-arena] warning: appendEvent fallito:")),
		"warning 'appendEvent fallito' presente su stderr",
	);

	// Nessuna directory evento creata (la scrittura non è mai riuscita).
	assert.ok(
		!fs.existsSync(path.join(f.cwd, ".gsd", "arena")),
		"nessun .gsd/arena creato",
	);
});

// ─── Replay fail-safe su arena assente/vuota ───────────────────────────────

test("replay: arenaId inesistente o log vuoto -> null (fail-safe su ENOENT/vuoto)", async () => {
	const f = makeFixture();
	track(f.root);

	// Nessun file: readEvents -> iterable vuoto (ENOENT fail-safe) -> null.
	assert.equal(await replayArena("uuid-inesistente", f.cwd), null, "nessun file -> null");

	// File presente ma vuoto: readEvents -> zero eventi -> null.
	// (mkdir dei genitori: in questo test nessuna run ha creato le dir.)
	const emptyPath = arenaEventLogPath(f.cwd, "uuid-log-vuoto");
	fs.mkdirSync(path.dirname(emptyPath), { recursive: true });
	fs.writeFileSync(emptyPath, "", "utf-8");
	assert.equal(await replayArena("uuid-log-vuoto", f.cwd), null, "log vuoto -> null");
});

// ─── Opt-in: default off ───────────────────────────────────────────────────

test("opt-in: eventLog di default false -> nessun file, nessun arenaId (firma retrocompatibile)", async () => {
	const f = makeFixture();
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");
	writeParticipant(f.userDir, "alice.md", { name: "alice", role: "Analyst" });

	const calls: string[] = [];
	const runTurn: RunTurnFn = async (participant) => {
		calls.push(participant.name);
		return okTurn(participant.name, participant.role);
	};
	// 12° parametro omesso: eventLog = false (default).
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
			undefined,
			runTurn,
		),
	);

	assert.equal(out.arenaId, undefined, "senza eventLog: true niente arenaId nel return");
	assert.ok(
		!fs.existsSync(path.join(f.cwd, ".gsd")),
		"nessuna dir .gsd creata nel cwd (zero I/O event log)",
	);
	assert.ok(out.transcript.includes("### Round 1 — alice (Analyst)\nalice risponde"));
	assert.equal(out.totalCost, 0.001);
});

// ─── reconstructTranscript: funzione pura ──────────────────────────────────

test("reconstructTranscript pura: ignora eventi strutturali/sconosciuti, contributi solo da message/marker/skip", () => {
	const events: ArenaEvent[] = [
		{ ts: "t1", type: "arena_start", arenaId: "a", topic: "t", participants: ["p1"], rounds: 1 },
		{ ts: "t2", type: "round_start", round: 1 },
		{ ts: "t3", type: "participant_start", participantId: "p1", round: 1 },
		{ ts: "t4", type: "participant_message", participantId: "p1", round: 1, text: "Prima risposta" },
		{ ts: "t5", type: "cost_update", participantId: "p1", round: 1, cost: 0.001, totalCost: 0.001 },
		{ ts: "t6", type: "round_end", round: 1 },
		{
			ts: "t7",
			type: "marker",
			participantId: "p1",
			round: 2,
			marker: "[TIMEOUT: p1 round_timeout ts]",
			kind: "timeout_round",
		},
		{
			ts: "t8",
			type: "participant_skip",
			participantId: "p1",
			round: 3,
			reason: "timeout_round",
			marker: "[PARTICIPANT SKIPPED: p1]",
		},
		{ ts: "t9", type: "arena_done", arenaId: "a", totalCost: 0.001, outcome: "complete" },
		{ ts: "t10", type: "tipo_futuro_sconosciuto", foo: 1 },
	];

	assert.equal(
		reconstructTranscript(events),
		"### Round 1 — p1\nPrima risposta\n\n" +
			"### Round 2 — p1\n[TIMEOUT: p1 round_timeout ts]\n\n" +
			"### Round 3 — p1\n[PARTICIPANT SKIPPED: p1]",
		"solo participant_message/marker/participant_skip contribuiscono, in ordine; " +
			"strutturali e tipo sconosciuto ignorati in silenzio (nessun throw)",
	);
	assert.equal(reconstructTranscript([]), "", "nessun evento -> stringa vuota");
});

test("reconstructTranscript pura: payload malformati -> fallback senza throw; testo multi-riga preservato", () => {
	// participant_message/marker senza i campi attesi: fallback sui default
	// (round 0, id vuoto, testo vuoto) — fail-safe, nessun throw.
	const malformed: ArenaEvent[] = [
		{ ts: "t1", type: "participant_message" },
		{ ts: "t2", type: "marker" },
	];
	// Nota: ogni blocco con testo vuoto termina con '\n' (template
	// '### Round ${round} — ${id}\n${text}'), quindi il join di due blocchi
	// malformati produce tre newline tra loro — comportamento fail-safe
	// voluto, nessun throw.
	assert.equal(
		reconstructTranscript(malformed),
		"### Round 0 — \n\n\n### Round 0 — \n",
		"payload malformato: fallback, nessun throw",
	);

	// Il testo multi-riga di un messaggio è preservato integro.
	assert.equal(
		reconstructTranscript([
			{ ts: "t", type: "participant_message", participantId: "p", round: 1, text: "riga 1\nriga 2" },
		]),
		"### Round 1 — p\nriga 1\nriga 2",
		"testo multi-riga preservato",
	);
});
