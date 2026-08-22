/**
 * tests/integration/availability-only-regression.test.ts — M011/S05/T01.
 *
 * Test anti-drift BIT-IDENTICO sulla modalità availability-only della
 * discussion-arena (R026 — Vision v2 §7.9, DoD-regressione).
 *
 * Scenario Tier A (D023): tier classification `available-only`, decision
 * `available-only`, source `fallback`. Il runner `runDiscussionArena` deve
 * produrre output canonico (transcript, participantsUsed, totalCost,
 * outcome) bit-identico tra run successivi, indipendentemente da fattori
 * non-deterministici (timestamp, UUID, scelte di default del modello).
 *
 * Strategia (riusa pattern S03 — decisioni D103 + D004):
 *   1. `runTurn` mockato via injection (11° parametro di runDiscussionArena):
 *      niente binario `gsd` spawnato, niente subprocess reali, niente
 *      tempi di rete. Il testo del turno è deterministico (`<name> risponde
 *      deterministically`) — unica fonte di non-determinismo eliminata.
 *   2. Topic fisso, nessun timestamp/UUID nel transcript: il canonical dello
 *      snapshot resta bit-identico riga-per-riga tra run successivi.
 *   3. Baseline committato in `tests/__snapshots__/availability-only-regression.json`
 *      (NON gitignored) per CI reproducibility.
 *   4. Rigenerabile via `UPDATE_SNAPSHOTS=1` (zero deps npm, nessun flag
 *      CLI bespoke — D004).
 *
 * Se il percorso availability-only della discussion-arena muta (nuovo
 * header round, ordine dei partecipanti alterato, marker diverso,
 * costo arrotondato diversamente, …), `npm test` exit != 0 in modalità
 * strict con diff unificato leggibile (60 righe di contesto). Il pre-flight
 * check in CI blocca il merge (vedi `.github/workflows/ci.yml#build`).
 *
 * Come rigenerare il baseline dopo una modifica intenzionale:
 *
 *   ```bash
 *   UPDATE_SNAPSHOTS=1 node --import ./tests/ts-esm-loader.mjs \
 *     --test tests/integration/availability-only-regression.test.ts
 *   ```
 *
 * Convenzioni (D103):
 *   - Variabile d'ambiente `UPDATE_SNAPSHOTS=1` (NON un flag CLI bespoke).
 *   - Baseline committato in `tests/__snapshots__/availability-only-regression.json`
 *     (NON gitignored) per CI reproducibility.
 */

import "../ts-esm-loader.mjs";
import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { runDiscussionArena, type RunTurnFn } from "../../index.js";
import type { ParticipantTurnResult } from "../../run-participant.js";
import { GSD_AGENT_DIR_ENV } from "../fixtures/pi-coding-agent-stub.js";
import { assertSnapshot } from "../_helpers/snapshot.js";

// ─── Fixture helpers (pattern event-log.test.ts / discussion-arena-loop.test.ts) ───

interface Fixture {
	root: string;
	userDir: string;
	cwd: string;
}

/**
 * Fixture su tmpdir: cwd della discussion arena è la tmpdir, quindi i file
 * osservabili (event log se opt-in) finiscono sotto `<tmpdir>/.gsd/` — il
 * `.gsd/` del repo non viene mai toccato. userDir è la directory dei
 * partecipanti utente risolta da `getAgentDir()` via env `GSD_AGENT_DIR`
 * (vedi stub in tests/fixtures/pi-coding-agent-stub.ts).
 */
function makeFixture(): Fixture {
	const root = fs.mkdtempSync(
		path.join(os.tmpdir(), "gsd-discussion-arena-availability-only-"),
	);
	const userDir = path.join(root, "agent", "discussion-arena", "participants");
	fs.mkdirSync(userDir, { recursive: true });
	return { root, userDir, cwd: root };
}

/** Scrive un partecipante .md minimale (frontmatter name/role/description) in `dir`. */
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

const activeFixtures: string[] = [];
function track(root: string): void {
	activeFixtures.push(root);
}

afterEach(() => {
	// L'env guida il discovery dei partecipanti utente (fixture): va ripulita
	// anche quando il singolo test non l'ha impostata, per non inquinare i
	// test successivi della suite.
	delete process.env[GSD_AGENT_DIR_ENV];
	for (const root of activeFixtures.splice(0)) {
		try {
			fs.rmSync(root, { recursive: true, force: true });
		} catch {
			// best-effort: la fixture è in os.tmpdir() e verrà pulita dal
			// sistema a prescindere; nessuna throw che sporchi il test result.
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

/** Turno di successo deterministico per un dato partecipante (costo 0.001). */
function okTurn(name: string, role: string): ParticipantTurnResult {
	return {
		participant: name,
		role,
		exitCode: 0,
		text: `${name} risponde deterministically`,
		usage: { input: 1, output: 1, cost: 0.001, turns: 1 },
		stderr: "",
		durationMs: 0,
	};
}

// ─── Test anti-drift bit-identico sulla modalità availability-only ─────────

test("availability-only regression: runDiscussionArena Tier A è bit-identico al baseline", async (t) => {
	const f = makeFixture();
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");

	// 2 partecipanti deterministici (analyst Analyst + dev Developer).
	writeParticipant(f.userDir, "analyst.md", {
		name: "analyst",
		role: "Analyst",
		description: "Availability-only Analyst",
	});
	writeParticipant(f.userDir, "dev.md", {
		name: "dev",
		role: "Developer",
		description: "Availability-only Developer",
	});

	// Mock runTurn: evita lo spawn del binario gsd (niente subprocess, niente
	// tempi di rete, niente modello). Stesso pattern di tests/event-log.test.ts.
	const runTurn: RunTurnFn = async (participant) => okTurn(participant.name, participant.role);

	// 11 argomenti: topic, requestedNames, rounds, cwd, signal, onProgress,
	// onRoundComplete (undefined), continuation (undefined), modelOverride
	// (undefined), toolLimits (undefined), runTurn. eventLog omesso (default
	// false) → discussionArenaId assente dal return (firma retrocompatibile).
	const out = await captureStderr(() =>
		runDiscussionArena(
			"availability-only regression snapshot baseline",
			["analyst", "dev"],
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

	// Snapshot bit-identico: transcript, participantsUsed, totalCost, outcome.
	// 4° argomento omesso → opts default {}; 5° argomento default =
	// import.meta.url → il path del baseline è risolto relativamente a
	// questo file di test, così l'helper è riusabile da qualunque profondità.
	assertSnapshot(
		t,
		"availability-only-regression",
		{
			transcript: out.transcript,
			participantsUsed: out.participantsUsed,
			totalCost: out.totalCost,
			outcome: out.outcome,
		},
	);

	// Asserzioni aggiuntive di diagnosi (NON bit-identità): verificano che il
	// path canonico (mock injection + transcript generation + selectParticipants
	// order preservation) produce il transcript atteso. Se una di queste
	// fallisce PRIMA dello snapshot, è un bug nel setup del test, non un
	// drift del codice sotto esame.
	assert.equal(out.participantsUsed.length, 2, "2 partecipanti usati");
	assert.equal(out.outcome, "complete", "outcome = complete");
	assert.match(
		out.transcript,
		/### Round 1 — analyst \(Analyst\)/,
		"header round 1 analyst presente con ruolo",
	);
	assert.match(
		out.transcript,
		/### Round 1 — dev \(Developer\)/,
		"header round 1 dev presente con ruolo",
	);
});
