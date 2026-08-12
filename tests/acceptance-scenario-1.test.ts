/**
 * Acceptance Scenario 1 (M004/S05/T02): override per-participant reale
 * applicato al subprocess gsd end-to-end.
 *
 * Contratto (must-have 1 della slice): un override reale
 * `.gsd/discussion-arena/participants-overrides/analyst.md` deve essere
 * applicato da `runDiscussionArena` con subprocess REALE (runTurn omesso ->
 * default `runParticipantTurn`, fixture fake-gsd risolta via PATH prepend):
 *  - log di trasparenza `[discussion-arena] override applied: analyst from <path>`
 *    su stderr (canale process.stderr, catturato con captureStderrChunks);
 *  - il transcript contiene `### Round 1 — analyst (Analyst)` e i marker echo
 *    del fixture (`echo-prompt-reply`, `model=claude-opus-5`,
 *    `systemPrompt=...OVERRIDE-MARKER...`) che provano che `--model` e
 *    `--append-system-prompt` hanno trasportato il MODELLO e il SYSTEM PROMPT
 *    dell'override, non quelli della base (sostituzione totale, S02);
 *  - `outcome === "complete"` e `totalCost > 0` (il turno reale è contato).
 *
 * Il control test (stesso percorso senza override) chiude la prova per
 * difetto: senza override arriva al subprocess il model e il system prompt
 * della base — il fixture echo-prompt riflette la configurazione risolta,
 * non un valore hardcoded.
 *
 * Nessun mock: la base `participants/analyst.md` e l'override vivono in un
 * tmpdir per-progetto (makeAcceptanceFixture) e il discovery walk-up dal cwd
 * li trova al primo livello. La dir utente è isolata via GSD_AGENT_DIR.
 */

import { test, before, after, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { runDiscussionArena } from "../index.js";
import {
	installFakeGsdInPath,
	restoreFakeGsdPath,
	makeAcceptanceFixture,
	cleanupFixture,
	writeParticipantMd,
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
 * Topic con la direttiva per-nome del fixture: `buildRoundPrompt` include il
 * topic nel prompt del round 0 e il fake gsd risolve la propria mode da
 * `DIRECTIVE:<name>:<mode>` (pattern sezione (h) del loop test).
 */
const ECHO_PROMPT_TOPIC = "DIRECTIVE:analyst:echo-prompt — valuta la direttiva";

test(
	"Scenario 1: override analyst.md reale -> log override applied + model e system prompt dell'override arrivano al subprocess",
	{ timeout: 15_000 },
	async () => {
		const f: AcceptanceFixture = makeAcceptanceFixture();
		activeFixtures.push(f.root);

		// Base project: model e system prompt DISTINTI dalla base — il transcript
		// non deve contenere alcun residuo di questo file quando l'override è
		// attivo (la sostituzione è totale, S02).
		writeParticipantMd(f.participantsDir, "analyst.md", {
			name: "analyst",
			role: "Analyst",
			model: "base-model-marker",
			body: "BASE-MARKER system prompt della base analyst.",
		});

		// Override tier 0: stesso name, model e system prompt dell'override.
		const overridePath = writeParticipantMd(f.overridesDir, "analyst.md", {
			name: "analyst",
			role: "Analyst",
			model: "claude-opus-5",
			body: "OVERRIDE-MARKER system prompt dell'override analyst.",
		});

		const { value: out, chunks } = await captureStderrChunks(() =>
			runDiscussionArena(
				ECHO_PROMPT_TOPIC,
				["analyst"],
				1,
				f.cwd,
				undefined,
				() => {},
			),
		);

		// Log di trasparenza: override applicato col path reale del file.
		const stderr = chunks.join("");
		assert.ok(
			stderr.includes(
				`[discussion-arena] override applied: analyst from ${overridePath}`,
			),
			`log canonico override applied con path reale, stderr: ${stderr}`,
		);

		// Il subprocess reale ha completato: outcome complete e costo contato.
		assert.equal(out.outcome, "complete", "outcome complete con subprocess reale");
		assert.equal(out.totalCost, 0.0015, "un turno echo-prompt completo (usage cost 0.0015)");
		assert.ok(out.totalCost > 0, "totalCost > 0 (must-have 1)");
		assert.deepEqual(out.participantsUsed, ["analyst"], "solo analyst selezionato");

		// Transcript: entry del round + marker echo del fixture.
		assert.ok(
			out.transcript.includes("### Round 1 — analyst (Analyst)"),
			"entry del round 1 di analyst nel transcript",
		);
		assert.ok(
			out.transcript.includes("echo-prompt-reply"),
			"marker echo-prompt nel transcript (modo del fixture attivo)",
		);
		// Il modello e il system prompt RICEVUTI dal subprocess sono quelli
		// dell'override, non quelli della base.
		assert.ok(
			out.transcript.includes("model=claude-opus-5"),
			"--model claude-opus-5 arrivato al subprocess (model dell'override)",
		);
		assert.ok(
			out.transcript.includes("OVERRIDE-MARKER"),
			"system prompt dell'override arrivato al subprocess (OVERRIDE-MARKER)",
		);
		assert.ok(
			!out.transcript.includes("BASE-MARKER"),
			"nessun residuo del system prompt della base (sostituzione totale)",
		);
		assert.ok(
			!out.transcript.includes("base-model-marker"),
			"nessun residuo del model della base",
		);

		// Lo stderr del subprocess (fixture-stderr:echo-prompt) resta nel
		// canale stderr del turno e non contamina il transcript (contratto
		// fixture fake-gsd).
		assert.ok(
			!out.transcript.includes("fixture-stderr"),
			"lo stderr del subprocess non contamina il transcript",
		);
	},
);

test(
	"Control: senza override il subprocess riceve model e system prompt della base (nessun log override applied)",
	{ timeout: 15_000 },
	async () => {
		const f: AcceptanceFixture = makeAcceptanceFixture();
		activeFixtures.push(f.root);

		// Solo la base project: nessun file in participants-overrides/.
		writeParticipantMd(f.participantsDir, "analyst.md", {
			name: "analyst",
			role: "Analyst",
			model: "base-model-marker",
			body: "BASE-MARKER system prompt della base analyst.",
		});

		const { value: out, chunks } = await captureStderrChunks(() =>
			runDiscussionArena(
				ECHO_PROMPT_TOPIC,
				["analyst"],
				1,
				f.cwd,
				undefined,
				() => {},
			),
		);

		const stderr = chunks.join("");
		assert.ok(
			!stderr.includes("override applied"),
			"nessun log override applied senza override",
		);

		assert.equal(out.outcome, "complete", "la base senza override completa");
		assert.ok(
			out.transcript.includes("model=base-model-marker"),
			"--model della base arrivato al subprocess",
		);
		assert.ok(
			out.transcript.includes("systemPrompt=BASE-MARKER"),
			"system prompt della base arrivato al subprocess",
		);
		assert.ok(
			!out.transcript.includes("OVERRIDE-MARKER"),
			"nessun marker dell'override senza override",
		);
	},
);
