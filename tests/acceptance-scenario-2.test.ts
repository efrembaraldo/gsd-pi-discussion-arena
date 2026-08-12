/**
 * Acceptance Scenario 2 (M004/S05/T03): coordination file per-progetto con
 * `rounds_default: 5` + ruolo virtuale `reviewer`, composti su una run reale
 * con subprocess gsd.
 *
 * Contratto (Scenario 2 del CONTEXT M004, must-have 2 di S03): il file
 * `.gsd/discussion-arena/discussion-arena-coordination.md` deve
 *  (a) alzare i round a 5 tramite la gerarchia rounds a 4 livelli
 *      (tool param > frontmatter > coordination.rounds_default > code
 *      DEFAULT_ROUNDS) — livello 3 vince sul livello 4;
 *  (b) far esistere un partecipante `reviewer` che NON ha alcun file in
 *      `participants/` (ruolo virtuale definito solo nel coordination file).
 *
 * Le due capacità sono coperte separatamente dagli unit test S03
 * (resolveRoundsDefault in tests/index.test.ts, virtual roles in
 * tests/participants.test.ts). Qui vengono COMPOSTE su un percorso reale:
 *  - la gerarchia è cablata con le stesse funzioni di produzione che usa il
 *    cablaggio `index.ts` execute — `resolveRoundsDefault` + clamp
 *    `MAX_ROUNDS` (livello 3 > livello 4, cap a 5) — e il risultato (5 round)
 *    è verificato ESEGUENDO 5 round col subprocess reale (il transcript
 *    contiene esattamente 10 entry `### Round N —`, round 1..5);
 *  - il reviewer virtuale è scoperto da `discoverParticipants` (log di
 *    trasparenza `virtual role applied: reviewer from <path>` su stderr) e
 *    partecipa a tutti i 5 round; il suo modello è il `model_default` del
 *    coordination file e il suo system prompt arriva al subprocess via
 *    `--append-system-prompt` (marker `REVIEWER-MARKER` riemesso dal modo
 *    echo-prompt del fixture fake-gsd, T01).
 *
 * Il control test chiude la prova per difetto: senza coordination file i
 * round restano DEFAULT_ROUNDS (2) e richiedere `reviewer` (che non esiste)
 * viene scartato silenziosamente da `selectParticipants`.
 *
 * Nessun mock: base `participants/analyst.md` + coordination file vivono in
 * un tmpdir per-progetto (makeAcceptanceFixture), il discovery walk-up dal
 * cwd li trova al primo livello e la dir utente è isolata via GSD_AGENT_DIR.
 */

import { test, before, after, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { runDiscussionArena, DEFAULT_ROUNDS, MAX_ROUNDS } from "../index.js";
import { discoverParticipants, resolveRoundsDefault } from "../participants.js";
import {
	installFakeGsdInPath,
	restoreFakeGsdPath,
	makeAcceptanceFixture,
	cleanupFixture,
	writeParticipantMd,
	writeCoordinationMd,
	captureStderrChunks,
	type AcceptanceFixture,
} from "./fixtures/acceptance-fixture.js";

// Subprocess reali: il fixture fake-gsd in testa a PATH deve vincere sul
// binario `gsd` reale (pattern discussion-arena-loop.test.ts sezione (h)).
before(installFakeGsdInPath);
after(restoreFakeGsdPath);

const activeFixtures: string[] = [];
afterEach(() => {
	for (const root of activeFixtures.splice(0)) cleanupFixture(root);
});

/**
 * Topic con la direttiva per-nome per ENTRAMBI i partecipanti: `buildRoundPrompt`
 * include il topic nel prompt di OGNI round (round 0 e successivi), quindi il
 * fake gsd risolve la propria mode da `DIRECTIVE:<name>:<mode>` a ogni spawn.
 */
const ECHO_PROMPT_TOPIC =
	"DIRECTIVE:analyst:echo-prompt DIRECTIVE:reviewer:echo-prompt — valuta la proposta";

/**
 * Cabla la gerarchia rounds esattamente come il cablaggio `index.ts` execute:
 * `Math.min(resolveRoundsDefault(tool, coordination.roundsDefault,
 * DEFAULT_ROUNDS), MAX_ROUNDS)`. Nel test il tool param non è passato
 * (undefined, come un utente che non specifica round): il livello 3
 * (coordination) deve vincere sul livello 4 (code default).
 */
function resolveRoundsLikeTool(
	coordinationRoundsDefault: number | undefined,
): number {
	return Math.min(
		resolveRoundsDefault(
			undefined,
			coordinationRoundsDefault,
			DEFAULT_ROUNDS,
		),
		MAX_ROUNDS,
	);
}

test(
	"Scenario 2: coordination rounds_default=5 + ruolo virtuale reviewer composti su una run reale (5 round, model_default ereditato)",
	{ timeout: 30_000 },
	async () => {
		const f: AcceptanceFixture = makeAcceptanceFixture();
		activeFixtures.push(f.root);

		// Base project: SOLO analyst con model proprio (indipendente dal
		// model_default) — il reviewer NON ha file in participants/.
		writeParticipantMd(f.participantsDir, "analyst.md", {
			name: "analyst",
			role: "Analyst",
			model: "analyst-model-marker",
			body: "ANALYST-MARKER system prompt di analyst.",
		});

		// Coordination file: rounds_default 5, model_default, reviewer virtuale.
		const coordinationPath = writeCoordinationMd(f.arenaDir, {
			roundsDefault: 5,
			modelDefault: "claude-opus-5",
			rolesVirtuals: [
				{
					key: "reviewer",
					name: "reviewer",
					role: "External Reviewer",
					description: "Revisore esterno definito solo nel coordination file",
					systemPrompt:
						"REVIEWER-MARKER system prompt del reviewer virtuale.",
				},
			],
		});

		// Precondizione dello scenario: nessun file reviewer in participants/.
		assert.ok(
			!fs.existsSync(path.join(f.participantsDir, "reviewer.md")),
			"il reviewer esiste SOLO come ruolo virtuale, nessun file in participants/",
		);

		// (a) Discovery reale: la coordination è letta via walk-up dal cwd.
		const probe = await captureStderrChunks(async () =>
			discoverParticipants(f.cwd),
		);
		const disc = probe.value;
		assert.equal(
			disc.coordinationPath,
			coordinationPath,
			"coordination file risolto dal walk-up dal cwd",
		);
		assert.equal(
			disc.coordination.roundsDefault,
			5,
			"rounds_default letto dal coordination file (livello 3)",
		);
		assert.equal(disc.coordination.modelDefault, "claude-opus-5");

		const reviewer = disc.participants.find((p) => p.name === "reviewer");
		assert.ok(reviewer, "reviewer scoperto senza file in participants/");
		assert.equal(reviewer.source, "virtual", "source virtual");
		assert.equal(
			reviewer.filePath,
			coordinationPath,
			"filePath del virtual role = coordination file",
		);
		assert.equal(
			reviewer.model,
			"claude-opus-5",
			"model_default ereditato dal virtual role (non ha campo model)",
		);
		assert.equal(
			reviewer.systemPrompt,
			"REVIEWER-MARKER system prompt del reviewer virtuale.",
			"system prompt del reviewer dal coordination file",
		);
		assert.ok(
			probe.chunks
				.join("")
				.includes(
					`[discussion-arena] virtual role applied: reviewer from ${coordinationPath}`,
				),
			"log di trasparenza virtual role applied con path reale (discovery esplicita)",
		);

		// (b) Gerarchia rounds cablata come il tool: livello 3 > livello 4.
		const rounds = resolveRoundsLikeTool(disc.coordination.roundsDefault);
		assert.equal(
			rounds,
			5,
			"rounds_default=5 vince sul code default (gerarchia a 4 livelli, clamp MAX_ROUNDS=5)",
		);

		// Run reale con subprocess: 5 round x 2 partecipanti = 10 turni.
		const { value: out, chunks } = await captureStderrChunks(() =>
			runDiscussionArena(
				ECHO_PROMPT_TOPIC,
				["analyst", "reviewer"],
				rounds,
				f.cwd,
				undefined,
				() => {},
			),
		);
		const stderr = chunks.join("");
		assert.ok(
			stderr.includes(
				`[discussion-arena] virtual role applied: reviewer from ${coordinationPath}`,
			),
			"log di trasparenza virtual role applied anche sulla run reale",
		);
		assert.equal(
			out.outcome,
			"complete",
			"outcome complete con 5 round eseguiti",
		);
		assert.deepEqual(
			out.participantsUsed,
			["analyst", "reviewer"],
			"entrambi i ruoli selezionati e usati",
		);
		assert.ok(
			Math.abs(out.totalCost - 0.015) < 1e-9,
			`10 turni echo-prompt contati (5 round x 2 partecipanti), totalCost=${out.totalCost}`,
		);

		// Transcript: esattamente 5 round, entrambi i partecipanti presenti.
		const entries = out.transcript.match(/### Round \d+ — /g) ?? [];
		assert.equal(
			entries.length,
			10,
			"10 entry di round (5 round x 2 partecipanti)",
		);
		assert.ok(
			out.transcript.includes("### Round 1 — analyst (Analyst)"),
			"round 1 di analyst",
		);
		assert.ok(
			out.transcript.includes("### Round 1 — reviewer (External Reviewer)"),
			"round 1 del reviewer virtuale (partecipa dal primo round)",
		);
		assert.ok(
			out.transcript.includes("### Round 5 — analyst (Analyst)"),
			"round 5 di analyst eseguito",
		);
		assert.ok(
			out.transcript.includes("### Round 5 — reviewer (External Reviewer)"),
			"round 5 del reviewer eseguito (5 round reali)",
		);
		assert.ok(
			!out.transcript.includes("### Round 6 —"),
			"nessun round 6 (rounds_default=5 rispettato)",
		);

		// Il reviewer ha ricevuto model_default e il system prompt del
		// coordination file (marker echo-prompt del fixture, T01).
		assert.ok(
			out.transcript.includes("model=claude-opus-5"),
			"--model claude-opus-5 arrivato al subprocess del reviewer (model_default)",
		);
		assert.ok(
			out.transcript.includes("systemPrompt=REVIEWER-MARKER"),
			"system prompt del reviewer arrivato al subprocess (dal coordination file)",
		);
		// L'analyst mantiene il PROPRIO model e system prompt: model_default
		// è solo un fallback, non sovrascrive i model espliciti.
		assert.ok(
			out.transcript.includes("model=analyst-model-marker"),
			"analyst mantiene il proprio model (model_default è fallback)",
		);
		assert.ok(
			out.transcript.includes("systemPrompt=ANALYST-MARKER"),
			"analyst mantiene il proprio system prompt",
		);

		// Invariante fixture: lo stderr dei subprocess non contamina il transcript.
		assert.ok(
			!out.transcript.includes("fixture-stderr"),
			"lo stderr del subprocess non contamina il transcript",
		);
	},
);

test(
	"Control: senza coordination file i round restano DEFAULT_ROUNDS (2) e il reviewer virtuale non esiste",
	{ timeout: 20_000 },
	async () => {
		const f: AcceptanceFixture = makeAcceptanceFixture();
		activeFixtures.push(f.root);

		// Solo la base project: nessun coordination file in arenaDir.
		writeParticipantMd(f.participantsDir, "analyst.md", {
			name: "analyst",
			role: "Analyst",
			model: "analyst-model-marker",
			body: "ANALYST-MARKER system prompt di analyst.",
		});

		const probe = await captureStderrChunks(async () =>
			discoverParticipants(f.cwd),
		);
		const disc = probe.value;
		assert.equal(
			disc.coordinationPath,
			null,
			"nessun coordination file risolto",
		);
		assert.equal(
			disc.coordination.roundsDefault,
			undefined,
			"nessun rounds_default senza coordination file",
		);
		assert.ok(
			!disc.participants.some((p) => p.name === "reviewer"),
			"reviewer non esiste senza coordination file",
		);
		assert.ok(
			!probe.chunks.join("").includes("virtual role applied"),
			"nessun log virtual role applied senza coordination file",
		);

		// Gerarchia cablata come il tool: nessun livello esplicito -> code default.
		const rounds = resolveRoundsLikeTool(disc.coordination.roundsDefault);
		assert.equal(
			rounds,
			DEFAULT_ROUNDS,
			"senza coordination i round restano il code default",
		);

		// Richiedere un reviewer inesistente: scartato silenziosamente.
		const { value: out, chunks } = await captureStderrChunks(() =>
			runDiscussionArena(
				ECHO_PROMPT_TOPIC,
				["analyst", "reviewer"],
				rounds,
				f.cwd,
				undefined,
				() => {},
			),
		);
		assert.ok(
			!chunks.join("").includes("virtual role applied"),
			"nessun virtual role applicato sulla run senza coordination",
		);
		assert.equal(out.outcome, "complete", "la run senza coordination completa");
		assert.deepEqual(
			out.participantsUsed,
			["analyst"],
			"reviewer inesistente scartato da selectParticipants",
		);
		const entries = out.transcript.match(/### Round \d+ — /g) ?? [];
		assert.equal(
			entries.length,
			2,
			"2 round (DEFAULT_ROUNDS) x 1 partecipante",
		);
		assert.ok(
			out.transcript.includes("### Round 2 — analyst (Analyst)"),
			"round 2 eseguito",
		);
		assert.ok(
			!out.transcript.includes("### Round 1 — reviewer"),
			"nessuna entry del reviewer (non esiste)",
		);
		assert.ok(
			!out.transcript.includes("### Round 3 —"),
			"nessun round 3 (cap a DEFAULT_ROUNDS)",
		);
	},
);
