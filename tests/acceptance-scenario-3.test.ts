/**
 * Acceptance Scenario 3 (M004/S05/T04): override orfano bloccante +
 * scansione naming estesa ai file untracked.
 *
 * Contratto (must-have 3 della slice, Scenario 3 del CONTEXT M004):
 *  (a) un override orfano `.gsd/discussion-arena/participants-overrides/
 *      pippobaudo.md` (nessun corrispondente base in project ∪ user ∪
 *      bundled ∪ virtual) deve FERMARE la run: `runDiscussionArena` rigetta
 *      con il messaggio canonico esatto
 *      `override target 'pippobaudo' not found in participants/ — create
 *      participants/pippobaudo.md or remove the override file` e il log di
 *      trasparenza `[discussion-arena] override target 'pippobaudo' not
 *      found in participants/` è su stderr PRIMA del throw. Nessun turno e
 *      nessun subprocess vengono eseguiti: la rigettazione avviene nella
 *      prima riga di `runDiscussionArena` (discoverParticipants);
 *  (b) il criterio "nessun residuo del termine legacy fuori allowlist" vale
 *      su un perimetro COMBINATO: file tracciati (`git ls-files`) E file
 *      untracked non-ignorati (`git ls-files --others --exclude-standard`).
 *      Questo chiude la known limitation esplicita del summary S04 — la
 *      guardia precedente scandiva solo i file tracciati, quindi i file
 *      appena creati da una slice (untracked fino al commit di chiusura)
 *      sfuggivano alla scansione. La POLICY è estratta in
 *      `tests/fixtures/naming-scan.ts` (una sola fonte di verità per token,
 *      allowlist e perimetri), riusata qui e dalla guardia
 *      tests/naming-residue.test.ts senza duplicare l'allowlist.
 *
 * Control del punto (a): lo stesso fixture SENZA il file orfano (sola base
 * analyst.md) completa la run con subprocess reale echo-prompt — il blocco è
 * causato dall'orfano, non dalla fixture.
 *
 * Nessun mock: l'override orfano e la base vivono in un tmpdir per-progetto
 * (makeAcceptanceFixture), il discovery walk-up dal cwd li trova al primo
 * livello e la dir utente è isolata via GSD_AGENT_DIR.
 */

import { test, before, after, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { runDiscussionArena } from "../index.js";
import { scanResidues, allSourceFiles } from "./fixtures/naming-scan.js";
import {
	installFakeGsdInPath,
	restoreFakeGsdPath,
	makeAcceptanceFixture,
	cleanupFixture,
	writeParticipantMd,
	captureStderrChunks,
	type AcceptanceFixture,
} from "./fixtures/acceptance-fixture.js";

// Subprocess reali nel control: il fixture fake-gsd in testa a PATH deve
// vincere sul binario `gsd` reale (pattern discussion-arena-loop.test.ts).
before(installFakeGsdInPath);
after(restoreFakeGsdPath);

const activeFixtures: string[] = [];
afterEach(() => {
	for (const root of activeFixtures.splice(0)) cleanupFixture(root);
});

/** Messaggio canonico esatto del throw bloccante per override orfano (S02). */
const ORPHAN_ERROR_MESSAGE =
	"override target 'pippobaudo' not found in participants/ — " +
	"create participants/pippobaudo.md or remove the override file";

/** Topic con la direttiva per-nome del fixture (usato solo dal control). */
const ECHO_PROMPT_TOPIC = "DIRECTIVE:analyst:echo-prompt — valuta la direttiva";

test(
	"Scenario 3a: override orfano pippobaudo.md -> runDiscussionArena rigetta col messaggio canonico esatto, nessun turno e nessun subprocess",
	{ timeout: 15_000 },
	async () => {
		const f: AcceptanceFixture = makeAcceptanceFixture();
		activeFixtures.push(f.root);

		// Solo l'override orfano: NESSUNA base in participants/ (project), la
		// dir utente è vuota (isolata via GSD_AGENT_DIR) e nessun bundled
		// dell'estensione si chiama pippobaudo.
		writeParticipantMd(f.overridesDir, "pippobaudo.md", {
			name: "pippobaudo",
			role: "Ghost",
			body: "Override senza base: deve fermare la run.",
		});

		// Il throw avviene in discoverParticipants, PRIMA riga di
		// runDiscussionArena: il try/catch DENTRO la callback di
		// captureStderrChunks cattura l'errore mantenendo le chunks stderr.
		const { value: err, chunks } = await captureStderrChunks(async () => {
			try {
				await runDiscussionArena(
					"valuta questa proposta",
					["analyst"],
					1,
					f.cwd,
					undefined,
					() => {},
				);
				return null; // mai raggiunto: discoverParticipants lancia
			} catch (caught) {
				return caught instanceof Error
					? caught
					: new Error(String(caught));
			}
		});

		// (a) Messaggio canonico ESATTO, con l'azione correttiva.
		assert.ok(err instanceof Error, "la run rigetta con un Error");
		assert.equal(
			err.message,
			ORPHAN_ERROR_MESSAGE,
			"messaggio canonico esatto (em-dash + azione correttiva)",
		);

		// Log di trasparenza su stderr PRIMA del throw, con prefisso canonico.
		const stderr = chunks.join("");
		assert.ok(
			stderr.includes(
				"[discussion-arena] override target 'pippobaudo' not found in participants/",
			),
			`log canonico not found su stderr, stderr: ${stderr}`,
		);

		// Nessun turno è partito: niente log limits per-partecipante, niente
		// fixture-stderr di subprocess, niente evento discussionArena.complete.
		assert.ok(
			!stderr.includes("[discussion-arena] limits "),
			"nessun turno avviato (nessun log limits)",
		);
		assert.ok(
			!stderr.includes("fixture-stderr:"),
			"nessun subprocess spawnato (il fake gsd non ha mai girato)",
		);
		assert.ok(
			!stderr.includes("discussionArena.complete"),
			"la run non arriva mai al completamento",
		);
	},
);

test(
	"Control 3a: lo stesso fixture senza il file orfano completa la run (il blocco è causato dall'orfano)",
	{ timeout: 15_000 },
	async () => {
		const f: AcceptanceFixture = makeAcceptanceFixture();
		activeFixtures.push(f.root);

		// Base analyst valida, NESSUN override: la run parte e completa.
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
			!stderr.includes("override target 'pippobaudo' not found"),
			"nessun log not-found senza il file orfano",
		);
		assert.equal(out.outcome, "complete", "la run senza orfano completa");
		assert.deepEqual(
			out.participantsUsed,
			["analyst"],
			"analyst selezionato e usato",
		);
		assert.ok(
			out.transcript.includes("echo-prompt-reply"),
			"subprocess reale eseguito (modo echo-prompt del fixture)",
		);
		assert.ok(
			out.transcript.includes("model=base-model-marker"),
			"model della base arrivato al subprocess",
		);
	},
);

test(
	"Scenario 3b: la scansione naming copre tracked E untracked non-ignorati — zero residui fuori allowlist (known limitation S04 chiusa)",
	{ timeout: 10_000 },
	() => {
		const combined = allSourceFiles();
		const residues = scanResidues(combined);
		const detail = residues
			.map((r) => `${r.file}:${r.line}: ${r.text}`)
			.join("\n");

		// Criterio demo della slice ("nessun residuo") reso eseguibile sul
		// perimetro COMPLETO: tracciati e untracked non-ignorati.
		assert.deepEqual(
			residues,
			[],
			`residui di naming fuori allowlist (${residues.length}):\n${detail}`,
		);

		// Chiusura della known limitation S04: i file S05 appena creati sono
		// nel perimetro della scansione in QUALUNQUE stato git (tracked ora,
		// untracked fino al commit di chiusura della slice) — la guardia li
		// copre comunque, senza duplicare la allowlist (policy unica in
		// tests/fixtures/naming-scan.ts).
		for (const expected of [
			"tests/acceptance-scenario-3.test.ts",
			"tests/fixtures/naming-scan.ts",
			"tests/fixtures/acceptance-fixture.ts",
			"tests/acceptance-scenario-1.test.ts",
			"tests/acceptance-scenario-2.test.ts",
		]) {
			assert.ok(
				combined.includes(expected),
				`file S05 assente dal perimetro combinato: ${expected}`,
			);
		}
	},
);
