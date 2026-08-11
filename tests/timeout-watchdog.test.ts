/**
 * Test end-to-end del timeout watchdog con subprocess REALI (M003/S04/T03).
 *
 * A differenza dei test S03 (runTurn mockato, nessun subprocess) e dei test
 * di wiring T02 (mock con failureKind), qui `runParticipantTurn` spawna un
 * vero subprocess `node` — il binario `gsd` finto in
 * tests/fixtures/fake-gsd/gsd, messo in testa a PATH dai test — che si
 * comporta secondo la direttiva `DIRECTIVE:<mode>` codificata nel prompt
 * (vedi la testata del fixture).
 *
 * I 6 scenari del contratto S04:
 *   1. event hard     — hang silenzioso + termination hard  -> SIGKILL entro
 *                       event_timeout_ms, failureKind=timeout_event.
 *   2. round          — attività continua (spam) che soddisfa il watchdog
 *                       event ma NON il cap round -> failureKind=timeout_round
 *                       (i due timer sono indipendenti).
 *   3. soft           — (a) SIGTERM + il processo si chiude da solo (exit 0,
 *                       nessun SIGKILL); (b) escalation: processo che ignora
 *                       SIGTERM viene SIGKILLato dopo la grace di 5s.
 *   4. hard + handler — SIGKILL immediato anche se il processo intercetta
 *                       SIGTERM: l'handler non gira mai.
 *   5. integrazione   — runDiscussionArena con runTurn REALE (default):
 *                       marker [TIMEOUT: <id> event_watchdog <ts>] nel
 *                       transcript, partecipante morto (SKIPPED al round 2),
 *                       outcome=partial, stderr non contamina il transcript.
 *   6. no-timeout     — subprocess veloce con soglie ampie: nessun failureKind,
 *                       exitCode 0, text/usage parsati dal protocollo JSON.
 *
 * Verifica anche la superficie che S08 consumerà: `durationMs` riflette la
 * durata effettiva del turno e il marker [TIMEOUT: ...] è regex-matchabile.
 */

import { test, before, after, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runDiscussionArena } from "../index.js";
import {
	runParticipantTurn,
	type ParticipantTurnResult,
} from "../run-participant.js";
import {
	formatFailureMarker,
	type ResolvedLimits,
} from "../helpers.js";
import type { ParticipantConfig } from "../participants.js";
import { GSD_AGENT_DIR_ENV } from "./fixtures/pi-coding-agent-stub.js";

// ─── PATH: il binario `gsd` finto deve vincere sul reale ───────────────────

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

// ─── Fixture helpers (pattern arena-loop.test.ts / participants.test.ts) ───

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

/** Fixture con dir utente (GSD_AGENT_DIR/discussion-arena/participants). */
function makeFixture(): Fixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-arena-watchdog-"));
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

// ─── Helper dei turni reali ────────────────────────────────────────────────

/** Limiti di base: soglie ampie, soft — i singoli scenari li sovrascrivono. */
function makeLimits(overrides: Partial<ResolvedLimits>): ResolvedLimits {
	return {
		roundTimeoutMs: 10_000,
		eventTimeoutMs: 1_000,
		outputLimitChars: 16_000,
		costBudgetUsd: 1.0,
		termination: "soft",
		...overrides,
	};
}

/** ParticipantConfig minimale per i test diretti (nessun discovery). */
function fixtureParticipant(name: string, role = "Tester"): ParticipantConfig {
	return {
		name,
		role,
		description: `fixture ${name}`,
		limits: {},
		systemPrompt: "",
		source: "user",
		filePath: "/dev/null",
	};
}

/**
 * Esegue un turno reale (subprocess) con la direttiva `DIRECTIVE:<mode>` nel
 * prompt. `signal` assente e `modelOverride` assente: si testa solo la
 * superficie timer/termination (T01), non il cancel esterno (S03).
 */
async function runTurnWithMode(
	mode: string,
	limits: ResolvedLimits,
	name = `t-${mode}`,
): Promise<ParticipantTurnResult> {
	return runParticipantTurn(
		fixtureParticipant(name),
		`DIRECTIVE:${mode} — prompt di test per ${name}`,
		process.cwd(),
		undefined,
		undefined,
		limits,
	);
}

// ─── 1. event watchdog + termination hard ──────────────────────────────────

test("event hard: subprocess in hang silenzioso viene SIGKILLato entro event_timeout_ms — failureKind=timeout_event, exitCode 1, durationMs entro budget, stderr trattenuta", { timeout: 10_000 }, async () => {
	const result = await runTurnWithMode(
		"hang",
		makeLimits({ eventTimeoutMs: 200, termination: "hard" }),
	);

	assert.equal(result.failureKind, "timeout_event");
	assert.match(
		result.failureReason ?? "",
		/nessun evento per 200 ms \(watchdog\)/,
		"failureReason riporta la soglia superata",
	);
	assert.equal(result.exitCode, 1, "SIGKILL -> close code null -> exitCode 1");
	assert.ok(
		result.durationMs >= 150 && result.durationMs < 2000,
		`durationMs=${result.durationMs} entro [150,2000): kill entro event_timeout_ms (200) + grace di polling`,
	);
	assert.equal(result.text, "", "nessun message_end parsato: hang silenzioso");
	assert.equal(result.usage.turns, 0, "nessun messaggio assistant");
	assert.equal(result.usage.cost, 0);
	assert.ok(
		result.stderr.includes("fixture-stderr:hang"),
		"lo stderr del subprocess killato resta in result.stderr",
	);
});

// ─── 2. round timeout (timer indipendente dal watchdog event) ──────────────

test("round: subprocess che emette eventi continui (spam) soddisfa il watchdog event ma scatta il round timer — failureKind=timeout_round", { timeout: 10_000 }, async () => {
	// eventTimeoutMs=200 < roundTimeoutMs=400: se il watchdog misurasse dallo
	// spawn (e non dall'ultimo evento) scatterebbe PRIMA del round — la
	// discriminazione del kind prova l'indipendenza dei due timer.
	const result = await runTurnWithMode(
		"spam",
		makeLimits({ roundTimeoutMs: 400, eventTimeoutMs: 200, termination: "hard" }),
	);

	assert.equal(result.failureKind, "timeout_round");
	assert.match(
		result.failureReason ?? "",
		/round timeout superato \(400 ms\)/,
		"failureReason riporta il cap round superato",
	);
	assert.equal(result.exitCode, 1, "SIGKILL -> exitCode 1");
	assert.ok(
		result.durationMs >= 300 && result.durationMs < 1500,
		`durationMs=${result.durationMs} ~ roundTimeoutMs(400): il round scatta separatamente dal watchdog`,
	);
	assert.equal(result.usage.cost, 0, "gli eventi spam non sono message_end: nessun costo accumulato");
	assert.equal(result.usage.turns, 0);
	assert.ok(result.stderr.includes("fixture-stderr:spam"));
});

// ─── 3. soft termination: SIGTERM + 5s grace + SIGKILL ─────────────────────

test("soft: SIGTERM + grace (5s) — il processo può chiudersi da solo, altrimenti SIGKILL di escalation", { timeout: 15_000 }, async (t) => {
	await t.test(
		"processo che gestisce SIGTERM si chiude da solo: exitCode 0, nessun SIGKILL (durationMs « grace)",
		{ timeout: 10_000 },
		async () => {
			const result = await runTurnWithMode(
				"sigterm-graceful",
				makeLimits({ eventTimeoutMs: 200, termination: "soft" }),
			);

			assert.equal(
				result.failureKind,
				"timeout_event",
				"l'abort resta un timeout: il processo ha solo cooperato alla terminazione",
			);
			assert.equal(
				result.exitCode,
				0,
				"exit 0: il processo si è chiuso da solo su SIGTERM, NON è stato SIGKILLato",
			);
			assert.ok(
				result.stderr.includes("graceful-shutdown"),
				"l'handler SIGTERM del processo ha girato (chiusura cooperativa)",
			);
			assert.ok(
				result.durationMs < 4000,
				`durationMs=${result.durationMs} < grace (5000): nessuna attesa del SIGKILL di escalation`,
			);
		},
	);

	await t.test(
		"processo che ignora SIGTERM viene SIGKILLato dopo la grace di 5s: exitCode 1, durationMs ~ event+grace",
		{ timeout: 15_000 },
		async () => {
			const result = await runTurnWithMode(
				"sigterm-ignore",
				makeLimits({ eventTimeoutMs: 200, termination: "soft" }),
			);

			assert.equal(result.failureKind, "timeout_event");
			assert.equal(
				result.exitCode,
				1,
				"SIGKILL dopo la grace -> close code null -> exitCode 1",
			);
			assert.ok(
				result.durationMs >= 4500 && result.durationMs < 9000,
				`durationMs=${result.durationMs} ~ eventTimeoutMs(200) + SOFT_TERMINATION_GRACE_MS(5000)`,
			);
			assert.ok(
				result.stderr.includes("fixture-stderr:sigterm-ignore"),
				"il processo è partito ed è stato killato (non spawn-fallito)",
			);
		},
	);
});

// ─── 4. hard termination: SIGKILL immediato, non intercettabile ─────────────

test("hard + handler: SIGKILL immediato anche se il processo intercetta SIGTERM — l'handler non gira mai", { timeout: 10_000 }, async () => {
	const result = await runTurnWithMode(
		"sigterm-graceful",
		makeLimits({ eventTimeoutMs: 200, termination: "hard" }),
	);

	assert.equal(result.failureKind, "timeout_event");
	assert.equal(result.exitCode, 1, "SIGKILL immediato -> exitCode 1");
	assert.ok(
		result.durationMs < 2000,
		`durationMs=${result.durationMs} < 2000: nessuna attesa della grace soft`,
	);
	assert.ok(
		result.stderr.includes("fixture-stderr:sigterm-graceful"),
		"il processo è partito (lo stderr del fixture è stato catturato)",
	);
	assert.ok(
		!result.stderr.includes("graceful-shutdown"),
		"l'handler SIGTERM NON è mai girato: SIGKILL non è intercettabile",
	);
});

// ─── 5. integrazione: loop runDiscussionArena con runTurn REALE ────────────

test("integrazione: runDiscussionArena con subprocess reali — partecipante in hang timeouta, marker [TIMEOUT: <id> event_watchdog <ts>] nel transcript, outcome=partial, stderr non contamina il transcript", { timeout: 15_000 }, async () => {
	const f = makeFixture();
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");

	// Le direttive per-nome stanno nel topic: il prompt buildRoundPrompt la
	// include e il fake gsd risolve la propria mode da "Sei <name> (".
	const topic =
		"DIRECTIVE:hang-one:hang DIRECTIVE:fast-one:fast — valuta questa architettura";

	try {
		writeParticipant(f.userDir, "hang-one.md", {
			name: "hang-one",
			role: "HangBot",
		});
		writeParticipant(f.userDir, "fast-one.md", {
			name: "fast-one",
			role: "FastBot",
		});

		const out = await captureStderr(() =>
			runDiscussionArena(
				topic,
				["hang-one", "fast-one"],
				2,
				f.cwd,
				undefined,
				() => {},
				undefined,
				undefined,
				undefined,
				// toolLimits: i ResolvedLimits per-partecipante arrivano al
				// runTurn reale (6° parametro, T01) e i timer scattano davvero.
				{ eventTimeoutMs: 200, termination: "hard" },
				// runTurn omesso -> default runParticipantTurn REALE.
			),
		);

		assert.equal(out.outcome, "partial", "hang-one morto per timeout -> partial");
		assert.deepEqual(
			out.participantsUsed.slice().sort(),
			["fast-one", "hang-one"],
			"participantsUsed resta invariato (selezione, non sopravvivenza)",
		);
		assert.equal(
			out.totalCost,
			0.0015 * 2,
			"totalCost = solo fast-one (2 round da 0.0015): il timeout non contribuisce costo",
		);

		// Marker canonico [TIMEOUT: <id> event_watchdog <ts>] al round 1 —
		// regex-matchabile (parsabile downstream, contratto S04) e uguale
		// esattamente a formatFailureMarker col timestamp estratto.
		const timeoutMatch = out.transcript.match(
			/\[TIMEOUT: hang-one event_watchdog ([^\]]+)\]/,
		);
		assert.ok(
			timeoutMatch,
			"marker [TIMEOUT: hang-one event_watchdog <ts>] presente nel transcript",
		);
		const expectedTimeoutMarker = formatFailureMarker(
			"timeout_event",
			"hang-one",
			undefined,
			timeoutMatch![1]!,
		);
		assert.ok(
			out.transcript.includes(expectedTimeoutMarker),
			"il marker TIMEOUT coincide esattamente con formatFailureMarker",
		);
		assert.ok(
			out.transcript.includes(
				"### Round 1 — hang-one (HangBot)\n[TIMEOUT: hang-one event_watchdog",
			),
			"il marker TIMEOUT sostituisce il testo del turno nella entry del round 1",
		);

		// Round 2: hang-one è morto -> SKIPPED; fast-one risponde ancora
		// (il loop di resilienza S03 non si ferma: non tutti sono morti).
		assert.ok(
			out.transcript.includes(
				"### Round 2 — hang-one (HangBot)\n[PARTICIPANT SKIPPED: hang-one]",
			),
			"round 2: hang-one marcato morto -> SKIPPED senza reinvocazione",
		);
		assert.ok(
			out.transcript.includes("### Round 1 — fast-one (FastBot)\nfast-reply"),
			"round 1: fast-one risponde (subprocess veloce parsato)",
		);
		assert.ok(
			out.transcript.includes("### Round 2 — fast-one (FastBot)\nfast-reply"),
			"round 2: fast-one risponde ancora",
		);

		// Lo stderr del subprocess killato NON contamina il transcript: resta
		// nel campo result.stderr (contratto S04).
		assert.ok(
			!out.transcript.includes("fixture-stderr:"),
			"lo stderr del subprocess resta in result.stderr, non nel transcript",
		);
	} finally {
		delete process.env[GSD_AGENT_DIR_ENV];
	}
});

// ─── 6. no-timeout: subprocess veloce con soglie ampie ─────────────────────

test("no-timeout: subprocess veloce (message_end + exit 0) con soglie ampie — failureKind assente, exitCode 0, text/usage parsati, durationMs riflette la durata reale", { timeout: 10_000 }, async () => {
	const result = await runTurnWithMode(
		"fast",
		makeLimits({ eventTimeoutMs: 1000, roundTimeoutMs: 1000 }),
	);

	assert.equal(result.failureKind, undefined, "nessun timeout");
	assert.equal(result.exitCode, 0, "exitCode 0");
	assert.equal(result.text, "fast-reply", "text parsato dal protocollo JSON");
	assert.deepEqual(
		result.usage,
		{ input: 10, output: 20, cost: 0.0015, turns: 1 },
		"usage parsato dal message_end",
	);
	assert.ok(
		result.durationMs < 1000,
		`durationMs=${result.durationMs} < 1000: il turno veloce non paga i timer`,
	);
	assert.ok(result.stderr.includes("fixture-stderr:fast"));
});
