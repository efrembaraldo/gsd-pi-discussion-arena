/**
 * tests/buildround-prompt-softdeadline.test.ts — Unit test di buildRoundPrompt
 * esteso (M015/S03 T02): soft deadline (R042) + durationMs recovery block
 * (R043). Funzione PURA (nessun I/O, nessun subprocess spawn) — copertura
 * diretta della firma estesa con sesto parametro opzionale
 * `previousDurationByParticipant?: Map<string, number>`.
 *
 * Copertura (6 test, definiti dal task plan):
 *
 *  (1) engine=hermes, round=0, previous qualsiasi -> SOLO blocco soft
 *      deadline. Round 0 non emette mai il blocco recovery perché
 *      `roundIndex > 0` è precondizione.
 *
 *  (2) engine=hermes, round>0, previous nel budget (<= softDeadlineMs) ->
 *      SOLO blocco soft deadline. Il blocco recovery richiede
 *      previous > softDeadlineMs.
 *
 *  (3) engine=hermes, round>0, previous over budget (> softDeadlineMs) ->
 *      blocco soft deadline + blocco recovery formattato.
 *      Verifica anche la forma del blocco recovery: include
 *      "Nel round precedente hai impiegato" + "<Xm Ys>" + "Contieni questo turno".
 *
 *  (4) engine="gsd" o undefined, round>0, previous over -> NESSUN blocco
 *      (né soft deadline né recovery). Retrocompat pre-M015: prompt
 *      identico al baseline (no frammenti hermes aggiunti).
 *
 *  (5) Calcolo `<N>` minuti: 300_000ms -> "~5 minuti"; 1_800_000ms ->
 *      "~30 minuti". Verifica la conversione Math.round.
 *
 *  (6) Formattazione recovery `<Xm Ys>`: 500_000ms -> "8m 20s";
 *      60_000ms -> "1m 0s"; 59_000ms -> "0m 59s".
 *
 * Convenzioni:
 *  - Tutti i ParticipantConfig sono creati con `makeParticipant(...)` che
 *    minimizza i campi richiesti dal parser tipi di index.ts. I campi
 *    `engine`/`softDeadlineMs` sono aggiunti solo quando servono al test.
 *  - I topic/transcript sono costanti stringa (no fixture su disco):
 *    M001 (fixture sintetiche, nessun PII/secret).
 *  - buildRoundPrompt è importato come export di ../index.js (modulo
 *    principale) — il pattern di import è identico a tests/index.test.ts.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { buildRoundPrompt } from "../index.js";
import type { ParticipantConfig } from "../participants.js";

const TOPIC = "Valutazione di un'architettura event-driven";

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Costruisce un ParticipantConfig minimale valido per buildRoundPrompt.
 * `engine` e `softDeadlineMs` sono OPZIONALI: passarli solo quando il test
 * li richiede. Il cast a ParticipantConfig è necessario perché il tipo
 * richiede molti altri campi (description/systemPrompt/source/filePath/limits)
 * che buildRoundPrompt non legge.
 */
function makeParticipant(
	name: string,
	role: string,
	options: { engine?: "hermes" | "gsd"; softDeadlineMs?: number } = {},
): ParticipantConfig {
	return {
		name,
		role,
		description: "",
		systemPrompt: "",
		source: "bundled",
		filePath: "",
		limits: {},
		...options,
	} as unknown as ParticipantConfig;
}

// ── Test 1: round 0 + hermes -> solo soft deadline (mai recovery) ────────────

test("buildRoundPrompt hermes round 0: solo blocco soft deadline, no recovery", () => {
	const p = makeParticipant("researcher", "Ricercatore", {
		engine: "hermes",
		softDeadlineMs: 300_000,
	});
	// previousDurationByParticipant popolato con durata > budget: NON deve
	// emettere recovery perché roundIndex=0 è precondizione negativa del
	// blocco recovery (R043). Anche se la Map fosse vuota il test passerebbe.
	const previous = new Map<string, number>([["researcher", 600_000]]);

	const prompt = buildRoundPrompt(TOPIC, 0, "", p, previous);

	assert.ok(
		prompt.includes("Budget di tempo per questo turno: ~5 minuti"),
		"round 0 + hermes + softDeadlineMs=300_000 -> blocco soft deadline presente",
	);
	assert.ok(
		prompt.includes("Non è un limite rigido"),
		"verifica la parte discorsiva del blocco soft deadline (R042)",
	);
	assert.ok(
		prompt.includes("Preferisci una risposta completa e leggermente in ritardo a una troncata"),
		"chiusura del blocco soft deadline",
	);
	assert.ok(
		!prompt.includes("Nel round precedente hai impiegato"),
		"round 0 NON emette recovery block (roundIndex>0 è precondizione)",
	);
	assert.ok(
		!prompt.includes("Contieni questo turno"),
		"recovery completamente assente al round 0",
	);
});

// ── Test 2: round > 0 + previous nel budget -> solo soft deadline ────────────

test("buildRoundPrompt hermes round>0 previous nel budget: solo soft deadline", () => {
	const p = makeParticipant("researcher", "Ricercatore", {
		engine: "hermes",
		softDeadlineMs: 300_000,
	});
	// previous=60_000 (1 minuto) < softDeadlineMs=300_000 (5 min) -> dentro budget.
	const previous = new Map<string, number>([["researcher", 60_000]]);

	const prompt = buildRoundPrompt(TOPIC, 1, "## Round 1: analisi iniziale.", p, previous);

	assert.ok(
		prompt.includes("Budget di tempo per questo turno: ~5 minuti"),
		"blocco soft deadline sempre presente (engine=hermes + softDeadlineMs>0)",
	);
	assert.ok(
		!prompt.includes("Nel round precedente hai impiegato"),
		"previous dentro budget -> NO blocco recovery",
	);
	assert.ok(
		!prompt.includes("Contieni questo turno"),
		"conferma assenza completa del blocco recovery",
	);
	// Verifica che il prompt mantenga i suoi componenti standard.
	assert.ok(
		prompt.includes("Transcript finora:"),
		"round > 0 continua a includere il transcript",
	);
	assert.ok(
		prompt.includes("## Round 1: analisi iniziale."),
		"il transcript passato è incorporato verbatim",
	);
});

// ── Test 3: round > 0 + previous over budget -> soft deadline + recovery ─────

test("buildRoundPrompt hermes round>0 previous over budget: soft deadline + recovery", () => {
	const p = makeParticipant("researcher", "Ricercatore", {
		engine: "hermes",
		softDeadlineMs: 300_000,
	});
	// previous=500_000 (8m 20s) > softDeadlineMs=300_000 (5 min) -> over budget.
	const previous = new Map<string, number>([["researcher", 500_000]]);

	const prompt = buildRoundPrompt(TOPIC, 1, "## Round 1: ricerca lunga.", p, previous);

	assert.ok(
		prompt.includes("Budget di tempo per questo turno: ~5 minuti"),
		"blocco soft deadline presente",
	);
	assert.ok(
		prompt.includes("Nel round precedente hai impiegato 8m 20s a fronte di un budget di ~5 minuti"),
		"recovery block formatta <Xm Ys> + budget <N> minuti (R043 verbatim)",
	);
	// N/2 = Math.round(5/2) = 3 (arrotondamento integer). Verifica che il
	// budget di recupero richiesto sia effettivamente ~3 minuti (non 2.5).
	assert.ok(
		prompt.includes("Contieni questo turno entro ~3 minuti"),
		"recovery dimezza il budget: 5/2 -> ~3 minuti (Math.round)",
	);
	assert.ok(
		prompt.includes("riusa quanto hai già raccolto invece di riaprire la ricerca"),
		"chiusura del blocco recovery (R043 verbatim)",
	);
});

// ── Test 4: engine=gsd/undefined round>0 previous over -> nessun blocco ─────

test("buildRoundPrompt engine=gsd o undefined round>0 previous over: nessun blocco", () => {
	// Caso A: engine="gsd" esplicito.
	const pGsd = makeParticipant("analyst", "Business Analyst", {
		engine: "gsd",
		softDeadlineMs: 300_000, // presente ma engine != "hermes" -> ignorato
	});
	const previousOverGsd = new Map<string, number>([["analyst", 600_000]]);
	const promptGsd = buildRoundPrompt(
		TOPIC,
		1,
		"## Round 1: ...", pGsd, previousOverGsd,
	);

	assert.ok(
		!promptGsd.includes("Budget di tempo per questo turno"),
		"engine=gsd NON riceve blocco soft deadline",
	);
	assert.ok(
		!promptGsd.includes("Nel round precedente hai impiegato"),
		"engine=gsd NON riceve blocco recovery (R043 explicita engine=gsd -> nessun blocco)",
	);
	assert.ok(
		!promptGsd.includes("Contieni questo turno"),
		"conferma assenza completa dei blocchi hermes",
	);
	assert.ok(
		promptGsd.includes("Transcript finora:"),
		"engine=gsd mantiene il prompt standard pre-S03",
	);

	// Caso B: engine undefined (retrocompat pre-M015).
	const pLegacy = makeParticipant("legacy", "Legacy Role"); // no engine
	const previousOverLegacy = new Map<string, number>([["legacy", 600_000]]);
	const promptLegacy = buildRoundPrompt(
		TOPIC,
		1,
		"## Round 1: ...", pLegacy, previousOverLegacy,
	);

	assert.ok(
		!promptLegacy.includes("Budget di tempo per questo turno"),
		"engine undefined NON riceve blocco soft deadline (retrocompat pre-M015)",
	);
	assert.ok(
		!promptLegacy.includes("Nel round precedente hai impiegato"),
		"engine undefined NON riceve blocco recovery",
	);
});

// ── Test 5: conversione ms -> minuti (Math.round) ───────────────────────────

test("buildRoundPrompt conversione softDeadlineMs -> minuti (Math.round)", () => {
	// 300_000ms = 5 minuti esatti.
	const pExact = makeParticipant("researcher", "Ricercatore", {
		engine: "hermes",
		softDeadlineMs: 300_000,
	});
	const promptExact = buildRoundPrompt(TOPIC, 0, "", pExact);
	assert.ok(
		promptExact.includes("~5 minuti"),
		"300_000ms esatti -> '~5 minuti'",
	);

	// 1_800_000ms = 30 minuti esatti.
	const p30 = makeParticipant("researcher", "Ricercatore", {
		engine: "hermes",
		softDeadlineMs: 1_800_000,
	});
	const prompt30 = buildRoundPrompt(TOPIC, 0, "", p30);
	assert.ok(
		prompt30.includes("~30 minuti"),
		"1_800_000ms esatti -> '~30 minuti'",
	);

	// 1_650_000ms = 27.5 minuti -> Math.round -> 28 minuti.
	const pRound = makeParticipant("researcher", "Ricercatore", {
		engine: "hermes",
		softDeadlineMs: 1_650_000,
	});
	const promptRound = buildRoundPrompt(TOPIC, 0, "", pRound);
	assert.ok(
		promptRound.includes("~28 minuti"),
		"1_650_000ms (27.5m) -> Math.round -> '~28 minuti'",
	);

	// 30_000ms (mezzo minuto) -> Math.round(0.5) = 1 -> minimo 1 minuto (clamp).
	const pClamp = makeParticipant("researcher", "Ricercatore", {
		engine: "hermes",
		softDeadlineMs: 30_000,
	});
	const promptClamp = buildRoundPrompt(TOPIC, 0, "", pClamp);
	assert.ok(
		promptClamp.includes("~1 minuti"),
		"30_000ms (0.5m) clampato a Math.max(1, Math.round) -> '~1 minuti'",
	);
});

// ── Test 6: formattazione recovery `<Xm Ys>` ────────────────────────────────

test("buildRoundPrompt formattazione recovery: previousDurationMs -> '<Xm Ys>'", () => {
	// NOTA: il blocco recovery richiede previousDurationMs > softDeadlineMs
	// (strict). Per esercitare la formattazione con TUTTI i valori del test
	// (inclusi casi sotto il minuto e 1 secondo) uso un softDeadlineMs molto
	// basso (500ms) che è comunque > 0 (attiva i blocchi) ma inferiore a
	// ogni previousDurationMs del test. Verifica inoltre che la conversione
	// ms -> minuti (R042) accetti softDeadlineMs bassi (la conversione è
	// fatta dal prompt builder, non dal test).
	const make = (prev: number) =>
		buildRoundPrompt(
			TOPIC,
			1,
			"## Round 1: ...",
			makeParticipant("researcher", "Ricercatore", {
				engine: "hermes",
				softDeadlineMs: 500, // 500ms: > 0 (blocchi attivi) < tutti i previous del test
			}),
			new Map<string, number>([["researcher", prev]]),
		);

	// 500_000ms = 8 minuti e 20 secondi -> "8m 20s".
	const prompt500k = make(500_000);
	assert.ok(
		prompt500k.includes("Nel round precedente hai impiegato 8m 20s"),
		"500_000ms -> '8m 20s'",
	);

	// 60_000ms = 1 minuto esatto -> "1m 0s".
	const prompt60k = make(60_000);
	assert.ok(
		prompt60k.includes("Nel round precedente hai impiegato 1m 0s"),
		"60_000ms -> '1m 0s' (zero secondi esplicito)",
	);

	// 59_000ms = 0 minuti e 59 secondi (sotto il minuto) -> "0m 59s".
	const prompt59k = make(59_000);
	assert.ok(
		prompt59k.includes("Nel round precedente hai impiegato 0m 59s"),
		"59_000ms (sotto il minuto) -> '0m 59s'",
	);

	// 1_000ms = 1 secondo esatto (caso edge) -> "0m 1s".
	const prompt1k = make(1_000);
	assert.ok(
		prompt1k.includes("Nel round precedente hai impiegato 0m 1s"),
		"1_000ms (caso edge) -> '0m 1s'",
	);
});