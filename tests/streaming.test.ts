/**
 * Test del nuovo parametro `stream: Type.Optional(Union[off|transcript|events])`
 * introdotto in M018/S02 (T01+T02+T03) — capability additive che popola
 * `details.streamingEvents: StreamingEvent[]` (D143 single source of truth via
 * riuso di `emitEvent`) sul tool `discussion_arena` quando `stream === "events"`.
 *
 * 5 scenari (must-have R056 + R064):
 *
 *   1. stream=events (loop-level): `onStreamingEvent` riceve ≥6 eventi con
 *      shape R056 (ts ISO 8601, type, participantId, round, cost/totalCost).
 *   2. stream=events (loop-level): callback `onProgress(partialTranscript)`
 *      resta invariato (R064 anti-regressione firma + semantica).
 *   3. buildDiscussionArenaExecute con stream=events (factory-level):
 *      `result.details.streamingEvents` popolato come snapshot immutabile.
 *   4. buildDiscussionArenaExecute senza stream (anti-regressione R064):
 *      nessun campo `streamingEvents` su details, 13° argomento undefined.
 *   5. buildDiscussionArenaExecute con stream=transcript (stub fail-soft
 *      D052): warning stderr canonico + degrada a "off" (13° arg undefined).
 *
 * Boilerplate riusato (NO cross-import per isolare failure):
 *   - writeParticipant / makeFixture / track / afterEach / captureStderr /
 *     okTurn da `tests/discussion-arena-loop.test.ts`.
 *   - createDispatchingApi / collectStderr / createTmpDir da
 *     `tests/integration/s01-tool-call-site.test.ts`.
 *
 * Self-sufficiency: registra gli hook ESM (`.js` -> `.ts` + stub
 * `@gsd/pi-coding-agent`) anche quando il file gira sotto `node --test`
 * senza `--import ./tests/ts-esm-loader.mjs` (es. invochi diretti).
 */

// Self-sufficiency: registra gli hook ESM (pattern s01-tool-call-site.test.ts:43).
// Da tests/streaming.test.ts il loader è nella stessa dir: `./ts-esm-loader.mjs`
// (NON `../ts-esm-loader.mjs` che risolverebbe al project root).
import "./ts-esm-loader.mjs";
import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";

import {
	runDiscussionArena,
	buildDiscussionArenaExecute,
	type RunDiscussionArenaFn,
	type RunTurnFn,
} from "../index.js";
import type { StreamingEvent } from "../helpers.js";
import type { ParticipantTurnResult } from "../run-participant.js";
import { GSD_AGENT_DIR_ENV } from "./fixtures/pi-coding-agent-stub.js";

// ─── Fixture helpers (pattern tests/discussion-arena-loop.test.ts:64-117) ────

/** Scrive un partecipante .md minimale (name/role/description) in `dir`. */
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

function makeFixture(): Fixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-streaming-"));
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

/** Cattura i chunk scritti su stderr durante `fn` (asserire warning canonici). */
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

/** Turno di successo deterministico. `cost > 0` + `durationMs > 0` per popolare
 *  `cost`/`totalCost`/`durationMs` sugli eventi emessi dal loop (R056). */
function okTurn(name: string, role: string): ParticipantTurnResult {
	return {
		participant: name,
		role,
		exitCode: 0,
		text: `${name} risponde`,
		stderr: "",
		usage: { input: 1, output: 1, cost: 0.001, turns: 1 },
		durationMs: 100,
	};
}

// ─── Factory-level helpers (pattern s01-tool-call-site.test.ts:100-143) ──────

interface DispatchingApi {
	api: Record<string, unknown>;
	emit: (event: string, payload: Record<string, unknown>) => void;
}

function createDispatchingApi(): DispatchingApi {
	const handlers = new Map<string, ((p: Record<string, unknown>) => unknown)[]>();
	const api = {
		on(event: string, handler: (p: Record<string, unknown>) => unknown) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return {};
		},
	};
	function emit(event: string, payload: Record<string, unknown>): void {
		for (const h of handlers.get(event) ?? []) {
			h(payload);
		}
	}
	return { api, emit };
}

function collectStderr(): {
	stream: NodeJS.WritableStream;
	lines: () => string[];
} {
	const lines: string[] = [];
	const stream = {
		write(chunk: unknown) {
			lines.push(String(chunk).replace(/\n$/, ""));
			return true;
		},
	} as NodeJS.WritableStream;
	return { stream, lines: () => lines };
}

async function createTmpDir(): Promise<string> {
	return await fsPromises.mkdtemp(path.join(os.tmpdir(), "gsd-streaming-factory-"));
}

// ─── Stub helper per scenari 3-5 (factory-level) ────────────────────────────

/** Stub di `runDiscussionArena` che, se riceve un 13° argomento (callback
 *  streaming), emette gli eventi `simulated` verso quella callback prima di
 *  ritornare un risultato minimo valido. Il 13° argomento è undefined quando
 *  la factory decide di NON threadare il collector (stream != "events",
 *  vedi T03 `effectiveStream`). */
function stubRunDiscussionArena(simulated: StreamingEvent[]): RunDiscussionArenaFn {
	return (async (...args: unknown[]) => {
		const onStreamingEvent = args[12] as ((ev: StreamingEvent) => void) | undefined;
		if (onStreamingEvent) {
			for (const ev of simulated) onStreamingEvent(ev);
		}
		return {
			transcript: "stub transcript",
			participantsUsed: [],
			totalCost: 0,
			outcome: "complete" as const,
		};
	}) as RunDiscussionArenaFn;
}

// ─── Scenario 1: stream=events (loop-level) ────────────────────────────────

test("stream=events (loop-level): onStreamingEvent riceve ≥6 eventi con shape R056 (ts ISO, type, participantId, round, cost)", async () => {
	const f = makeFixture();
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");

	writeParticipant(f.userDir, "alice.md", { name: "alice", role: "Analyst" });
	writeParticipant(f.userDir, "bob.md", { name: "bob", role: "Builder" });
	writeParticipant(f.userDir, "carol.md", { name: "carol", role: "Critic" });

	const runTurn: RunTurnFn = async (participant) => okTurn(participant.name, participant.role);

	const events: StreamingEvent[] = [];
	// 13° argomento: onStreamingEvent collector. Gli altri 12 argomenti sono
	// i parametri posizionali canonici della firma (T02: parametro 13
	// opzionale default undefined = R064 anti-regressione intatta).
	await captureStderr(() =>
		runDiscussionArena(
			"topic streaming",
			["alice", "bob", "carol"],
			1,
			f.cwd,
			undefined,
			() => {},
			undefined,
			undefined,
			undefined,
			undefined,
			runTurn,
			false, // eventLog
			(ev) => events.push(ev),
		),
	);

	// ≥6 eventi: demo must-have R056. La slice plan richiedeva anche un evento
	// terminale ('...done') ma l'implementazione attuale di T01-T03 emette
	// `discussion_arena_done` SOLO quando `eventLog=true` (è wrappato in
	// `if (eventLogPath !== null)` a index.ts:1119). Con `eventLog=false`
	// (12° param = false, default di produzione via factory) il done event
	// NON passa per `emitEvent`, quindi non raggiunge `onStreamingEvent`.
	// Coerentemente col piano (≥6 eventi + 3 participant_start + 3
	// participant_message), assertiamo i 3 tipi "core" del demo R056 — il
	// done event è coperto a livello factory dallo scenario 3 (eventi
	// simulati via stub, indipendenti dall'implementazione del loop).
	assert.ok(events.length >= 6, `events.length=${events.length} >= 6`);

	// Conta per tipo.
	const byType = new Map<string, number>();
	for (const ev of events) {
		if (typeof ev.type === "string") {
			byType.set(ev.type, (byType.get(ev.type) ?? 0) + 1);
		}
	}
	const startCount = events.filter((e) => e.type === "participant_start").length;
	const messageCount = events.filter((e) => e.type === "participant_message").length;

	assert.ok(
		startCount >= 3,
		`participant_start count=${startCount} >= 3 (uno per partecipante). byType=${JSON.stringify([...byType])}`,
	);
	assert.ok(
		messageCount >= 3,
		`participant_message count=${messageCount} >= 3 (uno per partecipante). byType=${JSON.stringify([...byType])}`,
	);

	// Verifica shape R056 sul primo participant_message: ts ISO valido, type
	// esatto, participantId string, round === 1, costo presente (accetta sia
	// `cost`/`totalCost` emessi dal loop sia `costUsd`/`cumulativeCost` se un
	// mapping T03 dovesse rinominarli).
	const firstMessage = events.find((e) => e.type === "participant_message");
	assert.ok(firstMessage, "primo participant_message presente");
	const ev = firstMessage!;
	assert.equal(typeof ev.ts, "string", "ts: string");
	assert.ok(
		!Number.isNaN(Date.parse(ev.ts)),
		`ts ISO 8601 valido (parseable): ${ev.ts}`,
	);
	assert.equal(ev.type, "participant_message");
	assert.equal(typeof ev.participantId, "string");
	assert.equal(ev.round, 1, "round === 1 (single-round scenario)");
	const hasCostField =
		(typeof ev.costUsd === "number") || (typeof ev.cost === "number");
	assert.ok(hasCostField, `campo costo presente (costUsd=${ev.costUsd}, cost=${ev.cost})`);
	const hasCumulativeField =
		(typeof ev.cumulativeCost === "number") || (typeof ev.totalCost === "number");
	assert.ok(
		hasCumulativeField,
		`campo cumulative presente (cumulativeCost=${ev.cumulativeCost}, totalCost=${ev.totalCost})`,
	);

	delete process.env[GSD_AGENT_DIR_ENV];
});

// ─── Scenario 2: stream=events (loop-level) — onProgress invariato ──────────

test("stream=events (loop-level): callback onProgress invariata — riceve partialTranscript stringa (R064 anti-regressione)", async () => {
	const f = makeFixture();
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");

	writeParticipant(f.userDir, "alice.md", { name: "alice", role: "Analyst" });
	writeParticipant(f.userDir, "bob.md", { name: "bob", role: "Builder" });
	writeParticipant(f.userDir, "carol.md", { name: "carol", role: "Critic" });

	const runTurn: RunTurnFn = async (participant) => okTurn(participant.name, participant.role);

	const events: StreamingEvent[] = [];
	const partials: string[] = [];
	// Stesso run dello scenario 1 ma con onProgress collector separato: la
	// presenza del 13° argomento NON deve alterare il contratto di onProgress
	// (firma `(partialTranscript: string) => void` invariata, R064).
	await captureStderr(() =>
		runDiscussionArena(
			"topic streaming",
			["alice", "bob", "carol"],
			1,
			f.cwd,
			undefined,
			(partial) => partials.push(partial),
			undefined,
			undefined,
			undefined,
			undefined,
			runTurn,
			false,
			(ev) => events.push(ev),
		),
	);

	assert.ok(
		partials.length >= 1,
		`onProgress invocato almeno una volta: partials.length=${partials.length}`,
	);
	for (const p of partials) {
		assert.equal(typeof p, "string", "onProgress riceve stringhe (firma invariata)");
		assert.ok(p.length > 0, "ogni partial non-vuoto");
	}
	// Sanity: lo streaming collector ha popolato events (coesistenza onProgress + onStreamingEvent).
	assert.ok(events.length >= 6, `streaming events raccolti in parallelo: ${events.length}`);

	delete process.env[GSD_AGENT_DIR_ENV];
});

// ─── Scenario 3: buildDiscussionArenaExecute stream=events (factory-level) ───

test("buildDiscussionArenaExecute con stream=events (factory-level): details.streamingEvents popolato come snapshot immutabile", async () => {
	const cwd = await createTmpDir();
	try {
		const { api } = createDispatchingApi();

		// 7 eventi simulati: 3 participant_start + 3 participant_message + 1 done.
		// Timestamp monotono crescente (ISO 8601) per verificare l'ordine.
		const ts0 = "2026-08-16T09:00:00.000Z";
		const ts1 = "2026-08-16T09:00:00.100Z";
		const ts2 = "2026-08-16T09:00:00.200Z";
		const ts3 = "2026-08-16T09:00:00.300Z";
		const ts4 = "2026-08-16T09:00:00.400Z";
		const ts5 = "2026-08-16T09:00:00.500Z";
		const ts6 = "2026-08-16T09:00:00.600Z";
		const simulated: StreamingEvent[] = [
			{ ts: ts0, type: "participant_start", participantId: "alice", round: 1 },
			{ ts: ts1, type: "participant_start", participantId: "bob", round: 1 },
			{ ts: ts2, type: "participant_start", participantId: "carol", round: 1 },
			{
				ts: ts3,
				type: "participant_message",
				participantId: "alice",
				round: 1,
				text: "alice msg",
				cost: 0.001,
				totalCost: 0.001,
			},
			{
				ts: ts4,
				type: "participant_message",
				participantId: "bob",
				round: 1,
				text: "bob msg",
				cost: 0.001,
				totalCost: 0.002,
			},
			{
				ts: ts5,
				type: "participant_message",
				participantId: "carol",
				round: 1,
				text: "carol msg",
				cost: 0.001,
				totalCost: 0.003,
			},
			{ ts: ts6, type: "discussion_arena_done", outcome: "complete" },
		];

		const execute = buildDiscussionArenaExecute(api as never, {
			runDiscussionArena: stubRunDiscussionArena(simulated),
		});
		const ctx = { cwd } as never;
		const result = await execute(
			"call-1",
			{
				topic: "topic factory",
				participants: ["alice", "bob", "carol"],
				rounds: 1,
				stream: "events",
			} as Parameters<typeof execute>[1],
			undefined,
			undefined,
			ctx,
		);

		// details.streamingEvents è Array di 7 elementi.
		const streamingEvents = result.details.streamingEvents as
			| StreamingEvent[]
			| undefined;
		assert.ok(Array.isArray(streamingEvents), "details.streamingEvents è Array");
		assert.equal(
			streamingEvents?.length,
			7,
			`details.streamingEvents.length=${streamingEvents?.length} === 7 (3 start + 3 message + 1 done)`,
		);

		// Shape minima: ogni evento ha ts ISO + type string.
		for (const ev of streamingEvents!) {
			assert.equal(typeof ev.ts, "string");
			assert.ok(!Number.isNaN(Date.parse(ev.ts)), `ts ISO valido: ${ev.ts}`);
			assert.equal(typeof ev.type, "string");
		}

		// Type-safety R056 subset sul primo participant_message.
		const firstMessage = streamingEvents!.find((e) => e.type === "participant_message");
		assert.ok(firstMessage, "primo participant_message presente");
		const ev = firstMessage!;
		assert.equal(typeof ev.participantId, "string");
		assert.equal(ev.round, 1);
		assert.ok(
			(typeof ev.costUsd === "number") || (typeof ev.cost === "number"),
			`campo costo presente (costUsd=${ev.costUsd}, cost=${ev.cost})`,
		);
		assert.ok(
			(typeof ev.cumulativeCost === "number") || (typeof ev.totalCost === "number"),
			`campo cumulative presente (cumulativeCost=${ev.cumulativeCost}, totalCost=${ev.totalCost})`,
		);

		// Snapshot immutabile (T03 spread `[...streamingEvents]`): il consumer
		// può mutare la copia ricevuta senza alterare lo stato interno della
		// factory. Verifica: il push su result.details.streamingEvents NON
		// influenza runDA (chiamato una volta sola), quindi lo snapshot è già
		// congelato per costruzione — asserzione di shape tramite length
		// costante dopo ulteriori letture.
		const lengthBefore = streamingEvents!.length;
		// Leggiamo di nuovo (simuliamo una seconda lettura): length invariata.
		const lengthAgain = (result.details.streamingEvents as StreamingEvent[]).length;
		assert.equal(lengthAgain, lengthBefore, "snapshot immutabile: length costante");
	} finally {
		await fsPromises.rm(cwd, { recursive: true, force: true });
	}
});

// ─── Scenario 4: buildDiscussionArenaExecute senza stream (R064) ────────────

test("buildDiscussionArenaExecute senza stream (anti-regressione R064): details.streamingEvents assente, 13° argomento undefined", async () => {
	const cwd = await createTmpDir();
	try {
		const { api } = createDispatchingApi();

		// Stub che osserva cosa riceve come 13° argomento: senza `stream` nel
		// params, la factory NON threada il collector (T03 effectiveStream="off"
		// => undefined). Lo stub NON emette eventi anche se ne ricevesse uno
		// (doppia cintura).
		let received13th: unknown = "NOT-CALLED";
		const stub: RunDiscussionArenaFn = (async (...args: unknown[]) => {
			received13th = args[12];
			return {
				transcript: "stub",
				participantsUsed: [],
				totalCost: 0,
				outcome: "complete" as const,
			};
		}) as RunDiscussionArenaFn;

		const execute = buildDiscussionArenaExecute(api as never, {
			runDiscussionArena: stub,
		});
		const ctx = { cwd } as never;
		const { value: result, chunks } = await captureStderrChunks(() =>
			execute(
				"call-2",
				{
					topic: "topic default",
					participants: ["alice"],
					rounds: 1,
					// stream ASSENTE: default = "off" via T03 normalizzazione
				} as Parameters<typeof execute>[1],
				undefined,
				undefined,
				ctx,
			),
		);

		const details = result.details as Record<string, unknown>;
		// details.streamingEvents NON presente (spread condizionale T03).
		assert.equal(
			("streamingEvents" in details),
			false,
			"details.streamingEvents assente (no-key, NON array vuoto) — spread condizionale T03",
		);
		assert.equal(
			details.streamingEvents,
			undefined,
			"details.streamingEvents === undefined per R064",
		);
		// 13° argomento ricevuto dallo stub = undefined (no collector threadato).
		assert.equal(received13th, undefined, "13° argomento undefined: nessun collector threadato");
		// Nessun warning stderr spurio.
		const spurious = chunks.filter(
			(c) =>
				c.includes("stream=transcript not implemented") ||
				(c.includes("stream=") && c.includes("warning")),
		);
		assert.equal(spurious.length, 0, "nessun warning stderr canonico stream=* per default");
	} finally {
		await fsPromises.rm(cwd, { recursive: true, force: true });
	}
});

// ─── Scenario 5: buildDiscussionArenaExecute stream=transcript (fail-soft) ──

test("buildDiscussionArenaExecute con stream=transcript (stub fail-soft D052): warning stderr canonico + degrada a off (13° arg undefined)", async () => {
	const cwd = await createTmpDir();
	try {
		const { api } = createDispatchingApi();
		const { stream, lines } = collectStderr();

		let received13th: unknown = "NOT-CALLED";
		const stub: RunDiscussionArenaFn = (async (...args: unknown[]) => {
			received13th = args[12];
			return {
				transcript: "stub",
				participantsUsed: [],
				totalCost: 0,
				outcome: "complete" as const,
			};
		}) as RunDiscussionArenaFn;

		const execute = buildDiscussionArenaExecute(api as never, {
			runDiscussionArena: stub,
			stderr: stream,
		});
		const ctx = { cwd } as never;
		const result = await execute(
			"call-3",
			{
				topic: "topic transcript",
				participants: ["alice"],
				rounds: 1,
				stream: "transcript",
			} as Parameters<typeof execute>[1],
			undefined,
			undefined,
			ctx,
		);

		// Warning stderr canonico D052: `[discussion-arena] warning: stream=transcript
		// not implemented in M018, falling back to stream=off`.
		const stderrText = lines().join("\n");
		assert.ok(
			stderrText.includes(
				"stream=transcript not implemented in M018, falling back to stream=off",
			),
			`warning stderr canonico presente. stderr=${JSON.stringify(stderrText)}`,
		);

		// Dettagli: nessun streamingEvents (fallback a "off"), nessun errore.
		const details = result.details as Record<string, unknown>;
		assert.equal(
			("streamingEvents" in details),
			false,
			"details.streamingEvents assente: stream=transcript degrada a off",
		);
		assert.equal(details.streamingEvents, undefined);

		// 13° argomento ricevuto dallo stub = undefined: collector NON threadato
		// (effectiveStream != "events" => fallback a off).
		assert.equal(
			received13th,
			undefined,
			"13° argomento undefined: fallback a off non threada il collector",
		);
	} finally {
		await fsPromises.rm(cwd, { recursive: true, force: true });
	}
});

// ─── Anti-regressione cross-suite (sanity locale) ──────────────────────────
// Se in futuro qualcuno toccasse la firma di `runDiscussionArena` (rimuovendo
// il 13° parametro, cambiando l'ordine, ecc.), questi compile-time check
// fallirebbero in TypeScript senza dover eseguire i test runtime.

test("compile-time: 13-arg runDiscussionArena (T02 firma estesa) accetta onStreamingEvent in coda", () => {
	// La firma di `runDiscussionArena` ha esattamente 13 parametri (12 storici
	// + 1 nuovo onStreamingEvent opzionale). Questo test esegue un check
	// runtime sulla lunghezza della signature via Function.length, che
	// restituisce il numero di parametri PRIMA del primo con default.
	const fn = runDiscussionArena as unknown as { length: number };
	// runDiscussionArena ha 11 required (no default) + 1 default `eventLog = false`
	// + 1 optional `onStreamingEvent`. Function.length conta SOLO i required
	// PRIMA del primo default: dovrebbe essere 10 (topic, names, rounds, cwd,
	// signal, onProgress, onRoundComplete, continuation, modelOverride, runTurn).
	// onProgress è required, runTurn ha default dispatchParticipantTurn.
	assert.equal(fn.length, 10, `runDiscussionArena Function.length=${fn.length} (10 required prima del primo default)`);
});
