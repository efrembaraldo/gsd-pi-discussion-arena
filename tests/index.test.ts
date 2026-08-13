/**
 * Test unitari di buildRoundPrompt, selectParticipants, parseCommandArgs,
 * resolveParticipantLimitsForParticipant e smoke schema DiscussionArenaParamsSchema
 * (index.ts).
 *
 * Coprono:
 *   - buildRoundPrompt round 0 (posizione iniziale, senza transcript) vs
 *     round > 0 (replica agli altri, con transcript incluso);
 *   - selectParticipants: selezione per nomi richiesti espliciti (e scarto
 *     dei nomi senza corrispondenza), selezione di tutti quando richiesto è
 *     omesso/vuoto, cap a MAX_PARTICIPANTS;
 *   - parseCommandArgs: parsing flessibile di <topic> [N rounds]
 *     [--continue|--new] [--model <id>]; topic può contenere spazi; ritorna
 *     null quando manca il topic (per mostrare usage dal command handler);
 *   - resolveParticipantLimitsForParticipant (S02/T02): matrice 2x2x2 su
 *     costBudgetUsd (campo rappresentativo, tool set/unset x frontmatter
 *     set/unset x valore valido/invalido) + un caso con tutti e 5 i campi
 *     contemporaneamente. Il merge vero e proprio (clamp, fallback per
 *     campo) è già coperto a fondo da tests/helpers.test.ts (S01, unità
 *     resolveParticipantLimits) — qui si verifica solo il "wiring"
 *     partecipante -> toolParams -> ResolvedLimits fatto da index.ts;
 *   - smoke schema: DiscussionArenaParamsSchema (TypeBox, non esportato) espone i 5
 *     limiti camelCase come campi Type.Optional — catturato registrando il
 *     tool `discussion_arena` con uno stub minimale di ExtensionAPI, stesso
 *     pattern di tests/e2e-auto-mode.test.ts;
 *   - resolveRoundsDefault (S03/T03): gerarchia rounds a 4 livelli (tool
 *     param > frontmatter N/A > coordination.rounds_default > code default)
 *     come funzione pura, e il cablaggio nei due punti di consumo — execute
 *     del tool e handler del command — via fixture tmpdir con coordination
 *     file: rounds_default applicato quando nessun rounds esplicito, tool
 *     param / N esplicito che vincono, clamp a MAX_ROUNDS, code default
 *     senza coordination file. I test di wiring interrompono il flusso prima
 *     del loop discussion arena reale (runDiscussionArena lancia per participant
 *     inesistente / sentinel in ui.notify) — nessun subprocess gsd spawnato.
 *
 * Le funzioni pure (buildRoundPrompt/selectParticipants/parseCommandArgs/
 * resolveParticipantLimitsForParticipant) sono testate direttamente senza
 * mock né fixture su disco (M001: fixture sintetiche, nessun PII/secret).
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import activate, {
	buildRoundPrompt,
	selectParticipants,
	parseCommandArgs,
	resolveParticipantLimitsForParticipant,
	MAX_PARTICIPANTS,
} from "../index.js";
import {
	resolveRoundsDefault,
	type ParticipantConfig,
} from "../participants.js";
import {
	DISCUSSION_ARENA_COORDINATION_DIR,
	DISCUSSION_ARENA_COORDINATION_FILENAME,
} from "../src/discussion-arena-coordination.js";
import {
	DEFAULT_PARTICIPANT_LIMITS,
	type ParticipantLimitsInput,
} from "../helpers.js";

/** Certifica un ParticipantConfig valido per le fixture pure. */
function p(
	name: string,
	role = "Role",
	limits: ParticipantLimitsInput = {},
): ParticipantConfig {
	return {
		name,
		role,
		description: `descrizione di ${name}`,
		limits,
		systemPrompt: `System prompt del ruolo ${role}`,
		source: "project",
		filePath: `${name}.md`,
	};
}

/**
 * Cattura le write su `process.stderr` durante `fn()` (i warning di
 * `resolveParticipantLimits` per valori invalidi, S01) e ripristina sempre
 * l'originale — anche in caso di throw — per non inquinare il reporter dei
 * test e poter asserire presenza/assenza dei warning.
 */
function captureStderr<T>(fn: () => T): { result: T; lines: string[] } {
	const lines: string[] = [];
	const original = process.stderr.write.bind(process.stderr);
	process.stderr.write = ((chunk: string) => {
		lines.push(String(chunk));
		return true;
	}) as typeof process.stderr.write;
	try {
		return { result: fn(), lines };
	} finally {
		process.stderr.write = original;
	}
}

/**
 * Cattura lo schema TypeBox del tool `discussion_arena` chiamando
 * `activate()` con uno stub minimale di ExtensionAPI. `registerTool` viene
 * invocato in modo sincrono dentro `activate()` (prima di qualunque await su
 * `resolveTrigger`), quindi lo schema è disponibile subito dopo la call
 * senza dover attendere gli hook asincroni.
 */
function captureDiscussionArenaParamsSchema(): {
	properties: Record<string, { type?: string; anyOf?: Array<{ const?: string }> }>;
	required?: string[];
} {
	return captureDiscussionArenaHandlers().schema as {
		properties: Record<string, { type?: string; anyOf?: Array<{ const?: string }> }>;
		required?: string[];
	};
}

/** Result del tool `discussion_arena` catturato via activate (execute reale). */
interface DiscussionArenaToolResult {
	content: Array<{ type: string; text: string }>;
	details: Record<string, unknown>;
}

/**
 * Handle catturati da `activate()` con uno stub minimale di ExtensionAPI:
 * schema + execute del tool `discussion_arena` e handler del command
 * `discussion-arena`. Le handler sono chiuse sull'api stub e leggono
 * `ctx.cwd` a ogni invocazione, quindi il capture è memoizzato (una sola
 * chiamata ad activate per file) e riusabile tra test con cwd diverse.
 */
interface CapturedDiscussionArenaHandlers {
	schema: Record<string, unknown>;
	/**
	 * Invoca l'execute reale del tool con ctx puntato a `cwd`.
	 * `onUpdate`/`signal` non passati (undefined): il path testato non li usa
	 * (il tool li tratta come opzionali via `?.`).
	 */
	execute: (
		params: Record<string, unknown>,
		cwd: string,
	) => Promise<DiscussionArenaToolResult>;
	/** Invoca l'handler reale del command con ctx (cwd + ui stub) fornito dal test. */
	command: (args: string, ctx: unknown) => Promise<void>;
}

let capturedDiscussionArenaHandlers: CapturedDiscussionArenaHandlers | undefined;
function captureDiscussionArenaHandlers(): CapturedDiscussionArenaHandlers {
	if (capturedDiscussionArenaHandlers) return capturedDiscussionArenaHandlers;
	let tool: { parameters?: unknown; execute?: unknown } | undefined;
	let commandHandler: unknown;
	// Shape locale minima dello stub (nessun import di tipi dal bare
	// specifier @gsd/pi-coding-agent: il file test non è nel tsconfig include
	// e l'LSP non lo risolve — pattern repo, vedi hooks-planning.test.ts). Il
	// cast `as never` è l'assertion universale: `never` è assegnabile a
	// qualunque parametro, incluso ExtensionAPI di activate().
	const api = {
		on: () => {},
		registerTool: (cfg: {
			name?: string;
			parameters?: unknown;
			execute?: unknown;
		}) => {
			if (cfg?.name === "discussion_arena") {
				tool = { parameters: cfg.parameters, execute: cfg.execute };
			}
			return {};
		},
		registerCommand: (name: string, cfg: { handler?: unknown }) => {
			if (name === "discussion-arena") {
				commandHandler = cfg.handler;
			}
			return {};
		},
	} as never;
	activate(api);
	if (!tool?.execute || !commandHandler) {
		throw new Error(
			"discussion_arena / discussion-arena non registrati da activate()",
		);
	}
	const rawExecute = tool.execute as (
		_toolCallId: string,
		params: Record<string, unknown>,
		_signal: AbortSignal | undefined,
		_onUpdate: unknown,
		ctx: unknown,
	) => Promise<DiscussionArenaToolResult>;
	const rawCommand = commandHandler as (
		args: string,
		ctx: unknown,
	) => Promise<void>;
	capturedDiscussionArenaHandlers = {
		schema: (tool.parameters ?? {}) as Record<string, unknown>,
		execute: (params, cwd) =>
			rawExecute(
				"call-1",
				params,
				undefined,
				undefined,
				{ cwd } as never,
			),
		command: (args, ctx) => rawCommand(args, ctx),
	};
	return capturedDiscussionArenaHandlers;
}

// ─── fixture tmpdir per il cablaggio rounds (S03/T03) ────────────────────

/**
 * Scrive un coordination file in `<cwd>/.gsd/discussion-arena/
 * discussion-arena-coordination.md` (stesso helper di
 * participants-override.test.ts). Il corpo va senza i marcatori `---`.
 */
function writeCoordination(cwd: string, body: string): string {
	const filePath = path.join(
		cwd,
		DISCUSSION_ARENA_COORDINATION_DIR,
		DISCUSSION_ARENA_COORDINATION_FILENAME,
	);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `---\n${body}\n---\n`, "utf-8");
	return filePath;
}

/**
 * Tmpdir effimera per un test del cablaggio rounds. Sotto `os.tmpdir()`:
 * il walk-up di discoverParticipants non trova `.gsd` negli antenati
 * (nessun coordination file spurio dal repo o da altre fixture).
 */
function makeRoundsTmpdir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "gsd-discussion-arena-rounds-"));
}

const TOPIC = "Scalabilità di un monolite";

test("buildRoundPrompt: round 0 frama la posizione iniziale senza transcript", () => {
	const p0 = p("architect", "Architetto");
	const prompt = buildRoundPrompt(TOPIC, 0, "", p0);

	assert.ok(
		prompt.includes(`Tema della discussione: ${TOPIC}`),
		"contiene il tema",
	);
	assert.ok(
		prompt.includes("posizione iniziale"),
		"framing round 0: posizione iniziale",
	);
	assert.ok(
		prompt.includes(`Sei ${p0.name} (${p0.role}).`),
		"si rivolge al partecipante",
	);
	assert.ok(
		!prompt.includes("Transcript finora:"),
		"round 0 non include il transcript",
	);
});

test("buildRoundPrompt: round > 0 include il transcript e chiede di replicare", () => {
	const p0 = p("pm", "PM");
	const transcript = "## Round 1: dev: serve più ottimismo.";
	const prompt = buildRoundPrompt(TOPIC, 1, transcript, p0);

	assert.ok(prompt.includes(`Tema della discussione: ${TOPIC}`));
	assert.ok(
		prompt.includes("Transcript finora:"),
		"round > 0 include il transcript",
	);
	assert.ok(
		prompt.includes(transcript),
		"il transcript è incorporato verbatim",
	);
	assert.ok(
		prompt.includes("Rispondi agli altri partecipanti"),
		"chiede di replicare agli altri",
	);
});

test("buildRoundPrompt: transcript vuoto in round > 0 resta gestito senza crash", () => {
	const p0 = p("dev", "Dev");
	const prompt = buildRoundPrompt(TOPIC, 2, "", p0);
	assert.ok(
		prompt.includes("Transcript finora:"),
		"header transcript presente anche se vuoto",
	);
});

test("selectParticipants: con nomi richiesti filtro i corrispondenti in ordine", () => {
	const all = [p("alice"), p("bob"), p("carol")];
	const out = selectParticipants(all, ["bob", "alice", "ghost"]);
	const names = out.map((p) => p.name);
	assert.deepEqual(
		names,
		["bob", "alice"],
		"filtra per i nomi richiesti, nell'ordine richiesto",
	);
	assert.equal(out.length, 2, "il nome senza corrispondenza viene scartato");
	assert.equal(
		out[0]!.name,
		"bob",
		"mantiene l'ordine dei richiesti, non quello di all",
	);
});

test("selectParticipants: richiesti vuoti o undefined usano tutti i partecipanti", () => {
	const all = [p("a"), p("b")];
	assert.equal(
		selectParticipants(all, undefined)!.length,
		2,
		"undefined -> tutti",
	);
	assert.equal(selectParticipants(all, [])!.length, 2, "array vuoto -> tutti");
});

test("selectParticipants: nessun nome richiesto corrisponde -> lista vuota (non error)", () => {
	const all = [p("a"), p("b")];
	const out = selectParticipants(all, ["zzz", "yyy"]);
	assert.deepEqual(out, [], "nessun match -> nessun selezionato, senza throw");
});

test("selectParticipants: il cap MAX_PARTICIPANTS tronca oltre il limite", () => {
	assert.ok(MAX_PARTICIPANTS > 0, "il cap è positivo");
	const over = MAX_PARTICIPANTS + 5;
	const all = Array.from({ length: over }, (_, i) =>
		p(`p${String(i).padStart(2, "0")}`, "Role"),
	);
	const out = selectParticipants(all, undefined);
	assert.equal(out.length, MAX_PARTICIPANTS, `tronca a ${MAX_PARTICIPANTS}`);
	assert.equal(out[0]!.name, "p00", "mantiene i primi del cap");
	assert.equal(
		out[out.length - 1]!.name,
		`p${String(MAX_PARTICIPANTS - 1).padStart(2, "0")}`,
	);
});

test("selectParticipants: il cap si applica anche con nomi richiesti oltre il limite", () => {
	assert.ok(MAX_PARTICIPANTS >= 8);
	const names = Array.from({ length: MAX_PARTICIPANTS + 3 }, (_, i) => `r${i}`);
	const all = names.map((n) => p(n, "Role"));
	const out = selectParticipants(all, names);
	assert.equal(
		out.length,
		MAX_PARTICIPANTS,
		"il cap tronca anche con richieste esplicite",
	);
});

test("selectParticipants: non modifica l'array sorgente all", () => {
	const all = Array.from({ length: MAX_PARTICIPANTS + 2 }, (_, i) =>
		p(`q${i}`),
	);
	const before = all.length;
	selectParticipants(all, undefined);
	assert.equal(
		all.length,
		before,
		"all resta immutato (slice crea un nuovo array)",
	);
});

// ─── parseCommandArgs ───────────────────────────────────────────────────────

test("parseCommandArgs: solo topic, default rounds, no flag", () => {
	const r = parseCommandArgs("scalabilità monolite", { rounds: 2 });
	assert.deepEqual(r, {
		topic: "scalabilità monolite",
		rounds: 2,
		continueSession: false,
		explicitNew: false,
		modelOverride: undefined,
	});
});

test("parseCommandArgs: topic con spazi + N rounds finale", () => {
	const r = parseCommandArgs("convenienza AI in ERP 3", { rounds: 2 });
	assert.equal(
		r?.topic,
		"convenienza AI in ERP",
		"topic preserva gli spazi interni",
	);
	assert.equal(r?.rounds, 3, "l'ultimo token numerico è rounds");
});

test("parseCommandArgs: topic con spazi senza N rounds, default preservato", () => {
	const r = parseCommandArgs("tema con spazi", { rounds: 2 });
	assert.equal(r?.topic, "tema con spazi");
	assert.equal(r?.rounds, 2, "default preservato");
});

test("parseCommandArgs: --continue e --new", () => {
	const c = parseCommandArgs("tema --continue", { rounds: 2 });
	assert.equal(c?.continueSession, true);
	assert.equal(c?.explicitNew, false);
	const n = parseCommandArgs("tema --new", { rounds: 2 });
	assert.equal(n?.continueSession, false);
	assert.equal(n?.explicitNew, true);
});

test("parseCommandArgs: --model <id> consuma il token successivo", () => {
	const r = parseCommandArgs("tema --model claude-sonnet-5", { rounds: 2 });
	assert.equal(r?.modelOverride, "claude-sonnet-5");
});

test("parseCommandArgs: -m e -c come alias brevi", () => {
	const r = parseCommandArgs("tema -m minimax-m3 -c", { rounds: 2 });
	assert.equal(r?.modelOverride, "minimax-m3");
	assert.equal(r?.continueSession, true);
});

test("parseCommandArgs: combinazione completa — topic spaziato, rounds, --continue, --model", () => {
	const r = parseCommandArgs(
		"convenienza AI in ERP 2 --continue --model inference_provider/minimax-m3",
		{ rounds: 2 },
	);
	assert.equal(r?.topic, "convenienza AI in ERP");
	assert.equal(r?.rounds, 2);
	assert.equal(r?.continueSession, true);
	assert.equal(r?.modelOverride, "<inference_provider>/minimax-m3");
});

test("parseCommandArgs: rounds > MAX_ROUNDS viene clippato", () => {
	const r = parseCommandArgs("tema 99", { rounds: 2 });
	assert.equal(r?.rounds, 5, "MAX_ROUNDS=5 -> 99 clippato a 5");
});

test("parseCommandArgs: rounds < 1 viene scartato (mantiene default)", () => {
	const r = parseCommandArgs("tema 0", { rounds: 3 });
	assert.equal(r?.rounds, 3, "rounds=0 non è valido, default preservato");
});

test("parseCommandArgs: --model senza valore è ignorato, non crasha", () => {
	const r = parseCommandArgs("tema --model", { rounds: 2 });
	assert.equal(r?.modelOverride, undefined);
	assert.equal(r?.topic, "tema");
});

test("parseCommandArgs: argomento vuoto o mancante topic ritorna null", () => {
	assert.equal(parseCommandArgs("", { rounds: 2 }), null);
	assert.equal(parseCommandArgs("   ", { rounds: 2 }), null);
});

// ─── resolveParticipantLimitsForParticipant: matrice 2x2x2 su costBudgetUsd ─
//
// Assi: tool (unset/set) x frontmatter (unset/set) x validità del valore
// impostato (valido/invalido). Quando un livello è "unset" l'asse validità
// non ha effetto su quel livello (nessun valore da validare) — il caso
// (unset, unset, invalido) è quindi degenere e coincide col default, incluso
// comunque per completezza meccanica della matrice 2x2x2.

const INVALID_COST = "non-e-un-numero";

test("limits 2x2x2 (1/8): tool=unset, frontmatter=unset -> default", () => {
	const participant = p("architect");
	const resolved = resolveParticipantLimitsForParticipant(participant, {});
	assert.equal(resolved.costBudgetUsd, DEFAULT_PARTICIPANT_LIMITS.costBudgetUsd);
});

test("limits 2x2x2 (2/8): tool=unset, frontmatter=unset, validità=invalido (n/a) -> default comunque", () => {
	const participant = p("architect", "Role", { costBudgetUsd: undefined });
	const { result: resolved, lines } = captureStderr(() =>
		resolveParticipantLimitsForParticipant(participant, { costBudgetUsd: undefined }),
	);
	assert.equal(resolved.costBudgetUsd, DEFAULT_PARTICIPANT_LIMITS.costBudgetUsd);
	assert.equal(lines.length, 0, "nessun valore impostato -> nessun warning");
});

test("limits 2x2x2 (3/8): tool=unset, frontmatter=set valido -> vince frontmatter", () => {
	const participant = p("architect", "Role", { costBudgetUsd: 0.05 });
	const resolved = resolveParticipantLimitsForParticipant(participant, {});
	assert.equal(resolved.costBudgetUsd, 0.05);
});

test("limits 2x2x2 (4/8): tool=unset, frontmatter=set invalido -> scartato con warning, fallback al default", () => {
	const participant = p("architect", "Role", { costBudgetUsd: INVALID_COST });
	const { result: resolved, lines } = captureStderr(() =>
		resolveParticipantLimitsForParticipant(participant, {}),
	);
	assert.equal(resolved.costBudgetUsd, DEFAULT_PARTICIPANT_LIMITS.costBudgetUsd);
	assert.ok(lines.length > 0, "valore invalido -> warning su stderr");
	assert.ok(
		lines.some((l) => l.includes("costBudgetUsd")),
		"il warning cita il campo",
	);
});

test("limits 2x2x2 (5/8): tool=set valido, frontmatter=unset -> vince tool", () => {
	const participant = p("architect");
	const resolved = resolveParticipantLimitsForParticipant(participant, { costBudgetUsd: 2.5 });
	assert.equal(resolved.costBudgetUsd, 2.5);
});

test("limits 2x2x2 (6/8): tool=set invalido, frontmatter=unset -> scartato con warning, fallback al default", () => {
	const participant = p("architect");
	const { result: resolved, lines } = captureStderr(() =>
		resolveParticipantLimitsForParticipant(participant, { costBudgetUsd: INVALID_COST }),
	);
	assert.equal(resolved.costBudgetUsd, DEFAULT_PARTICIPANT_LIMITS.costBudgetUsd);
	assert.ok(lines.length > 0, "valore invalido -> warning su stderr");
});

test("limits 2x2x2 (7/8): tool=set valido, frontmatter=set valido -> tool vince su frontmatter", () => {
	const participant = p("architect", "Role", { costBudgetUsd: 0.05 });
	const resolved = resolveParticipantLimitsForParticipant(participant, { costBudgetUsd: 2.5 });
	assert.equal(resolved.costBudgetUsd, 2.5, "precedenza tool > frontmatter");
});

test("limits 2x2x2 (8/8): tool=set invalido, frontmatter=set invalido -> entrambi scartati (2 warning), fallback al default", () => {
	const participant = p("architect", "Role", { costBudgetUsd: INVALID_COST });
	const { result: resolved, lines } = captureStderr(() =>
		resolveParticipantLimitsForParticipant(participant, { costBudgetUsd: INVALID_COST }),
	);
	assert.equal(resolved.costBudgetUsd, DEFAULT_PARTICIPANT_LIMITS.costBudgetUsd);
	assert.ok(lines.length >= 2, "sia tool che frontmatter invalidi -> almeno 2 warning");
	// Nessun throw: se resolveParticipantLimitsForParticipant lanciasse, la
	// destructuring sopra (captureStderr) avrebbe già fatto fallire il test.
});

// ─── resolveParticipantLimitsForParticipant: tutti e 5 i campi insieme ─────

test("resolveParticipantLimitsForParticipant: tutti e 5 i campi, precedenza tool > frontmatter > defaults per campo", () => {
	const participant = p("architect", "Architetto", {
		costBudgetUsd: 0.05,
		roundTimeoutMs: 10_000,
		outputLimitChars: 5_000,
		termination: "soft",
	});
	const toolParams: ParticipantLimitsInput = {
		costBudgetUsd: 2.5, // sovrascrive il frontmatter (0.05)
		termination: "hard", // sovrascrive il frontmatter ("soft")
		// roundTimeoutMs/outputLimitChars non impostati dal tool -> vince il frontmatter
		// eventTimeoutMs non impostato né da tool né da frontmatter -> vince il default
	};

	const resolved = resolveParticipantLimitsForParticipant(participant, toolParams);

	assert.deepEqual(resolved, {
		roundTimeoutMs: 10_000, // frontmatter (tool unset)
		eventTimeoutMs: DEFAULT_PARTICIPANT_LIMITS.eventTimeoutMs, // default (entrambi unset)
		outputLimitChars: 5_000, // frontmatter (tool unset)
		costBudgetUsd: 2.5, // tool vince su frontmatter (0.05)
		termination: "hard", // tool vince su frontmatter ("soft")
	});
});

test("resolveParticipantLimitsForParticipant: participant.limits assente (undefined) -> equivalente a {} (nessun throw)", () => {
	// Copre il caso difensivo `participant.limits ?? {}` di index.ts anche se
	// participants.ts (T01) garantisce sempre un oggetto: la funzione non deve
	// assumere l'invariante del chiamante.
	const participant = { ...p("architect"), limits: undefined } as unknown as ParticipantConfig;
	const resolved = resolveParticipantLimitsForParticipant(participant, {});
	assert.deepEqual(resolved, DEFAULT_PARTICIPANT_LIMITS);
});

// ─── smoke schema: DiscussionArenaParamsSchema espone i 5 limiti camelCase ──────────

test("smoke schema: DiscussionArenaParamsSchema espone i 5 limiti camelCase come campi Type.Optional", () => {
	const schema = captureDiscussionArenaParamsSchema();
	const limitFields = [
		"roundTimeoutMs",
		"eventTimeoutMs",
		"outputLimitChars",
		"costBudgetUsd",
		"termination",
	];

	for (const field of limitFields) {
		assert.ok(
			Object.hasOwn(schema.properties, field),
			`DiscussionArenaParamsSchema espone ${field}`,
		);
		assert.ok(
			!(schema.required ?? []).includes(field),
			`${field} è Type.Optional, non deve comparire in required`,
		);
	}

	for (const field of ["roundTimeoutMs", "eventTimeoutMs", "outputLimitChars", "costBudgetUsd"]) {
		assert.equal(schema.properties[field]!.type, "number", `${field} è Type.Number`);
	}

	const terminationConsts = schema.properties.termination!.anyOf?.map((v) => v.const);
	assert.deepEqual(
		terminationConsts,
		["soft", "hard"],
		"termination è l'unione dei due literal soft/hard (Type.Union)",
	);

	assert.deepEqual(
		schema.required,
		["topic"],
		"solo topic resta required, i 5 limiti sono opzionali",
	);
});

// ─── S03/T03: resolveRoundsDefault — gerarchia rounds a 4 livelli ─────────
//
// Il resolver è puro (participants.ts): tool param (livello 1) > frontmatter
// del participant (livello 2, N/A — rounds è una proprietà della discussion arena) >
// coordination.rounds_default (livello 3) > code DEFAULT_ROUNDS (livello 4).
// Il clamp a MAX_ROUNDS NON è nel resolver (participants.ts non può
// importare MAX_ROUNDS da index.ts senza dipendenza circolare): è l'ultimo
// passo del cablaggio in index.ts (vedi test di wiring qui sotto con
// rounds_default: 99 → 5).

test("resolveRoundsDefault: nessun livello esplicito → codeDefault", () => {
	assert.equal(resolveRoundsDefault(undefined, undefined, 2), 2);
});

test("resolveRoundsDefault: tool param vince su coordination.rounds_default", () => {
	assert.equal(resolveRoundsDefault(3, 5, 2), 3, "livello 1 > livello 3");
});

test("resolveRoundsDefault: coordination.rounds_default vince su codeDefault", () => {
	assert.equal(resolveRoundsDefault(undefined, 5, 2), 5, "livello 3 > livello 4");
});

test("resolveRoundsDefault: tool param 1 è il minimo valido", () => {
	assert.equal(resolveRoundsDefault(1, 5, 2), 1);
});

test("resolveRoundsDefault: tool param 0/negativo invalido → degrada al livello successivo", () => {
	assert.equal(resolveRoundsDefault(0, 5, 2), 5, "tool 0 invalido → coordination");
	assert.equal(
		resolveRoundsDefault(-3, undefined, 2),
		2,
		"tool negativo invalido → codeDefault",
	);
});

test("resolveRoundsDefault: coordination non-integer o < 1 invalido → codeDefault", () => {
	assert.equal(resolveRoundsDefault(undefined, 2.5, 2), 2, "non-integer scartato");
	assert.equal(resolveRoundsDefault(undefined, 0, 2), 2, "0 scartato");
	assert.equal(resolveRoundsDefault(undefined, -7, 2), 2, "negativo scartato");
});

test("resolveRoundsDefault: NON applica il clamp MAX_ROUNDS (contratto: clamp nel cablaggio index.ts)", () => {
	// Il resolver ritorna il vincitore della gerarchia senza cap; il clamp a
	// MAX_ROUNDS è applicato dai due call site in index.ts (Math.min) ed è
	// verificato end-to-end nei test di wiring con rounds_default: 99 → 5.
	assert.equal(resolveRoundsDefault(undefined, 99, 2), 99);
});

test("parseCommandArgs: il default rounds (livello 3 risolto) fluisce senza N esplicito; l'N esplicito vince", () => {
	const r = parseCommandArgs("tema con spazi", { rounds: 5 });
	assert.equal(r?.rounds, 5, "default = coordination.rounds_default preservato");
	const explicit = parseCommandArgs("tema 3", { rounds: 5 });
	assert.equal(explicit?.rounds, 3, "N esplicito (livello 1) vince sul default");
});

// ─── S03/T03: cablaggio gerarchia rounds nel tool discussion_arena ────────
//
// Il tool execute viene invocato con `participants: ["ghost-role"]` (nessun
// participant con quel nome): runDiscussionArena lancia "Nessun partecipante
// valido trovato" PRIMA del loop dei round (selezione vuota), quindi il test
// osserva `details.rounds` (il valore risolto dalla gerarchia) senza mai
// spawnare subprocess gsd reali (gsd è su PATH nell'ambiente di sviluppo).

test("tool wiring: coordination rounds_default=5 senza rounds param → 5 round", async () => {
	const cwd = makeRoundsTmpdir();
	try {
		writeCoordination(cwd, "rounds_default: 5");
		const { execute } = captureDiscussionArenaHandlers();
		const res = await execute(
			{ topic: "tema", participants: ["ghost-role"] },
			cwd,
		);
		assert.equal(
			res.details.rounds,
			5,
			"livello 3 (coordination) vince sul livello 4 (code default 2)",
		);
		assert.ok(
			res.content[0]!.text.includes("Errore nell'esecuzione"),
			"la run è interrotta (ghost) — nessun loop discussion arena reale",
		);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("tool wiring: rounds param esplicito vince su coordination.rounds_default", async () => {
	const cwd = makeRoundsTmpdir();
	try {
		writeCoordination(cwd, "rounds_default: 5");
		const { execute } = captureDiscussionArenaHandlers();
		const res = await execute(
			{ topic: "tema", participants: ["ghost-role"], rounds: 3 },
			cwd,
		);
		assert.equal(
			res.details.rounds,
			3,
			"livello 1 (tool param) vince sul livello 3",
		);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("tool wiring: nessun coordination file → code DEFAULT_ROUNDS", async () => {
	const cwd = makeRoundsTmpdir();
	try {
		const { execute } = captureDiscussionArenaHandlers();
		const res = await execute(
			{ topic: "tema", participants: ["ghost-role"] },
			cwd,
		);
		assert.equal(
			res.details.rounds,
			2,
			"nessun livello 1/3 → livello 4 (DEFAULT_ROUNDS)",
		);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("tool wiring: coordination rounds_default=99 → clamp a MAX_ROUNDS (mai oltre)", async () => {
	const cwd = makeRoundsTmpdir();
	try {
		writeCoordination(cwd, "rounds_default: 99");
		const { execute } = captureDiscussionArenaHandlers();
		const res = await execute(
			{ topic: "tema", participants: ["ghost-role"] },
			cwd,
		);
		assert.equal(res.details.rounds, 5, "il cablaggio clippa a MAX_ROUNDS=5");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

// ─── S03/T03: cablaggio gerarchia rounds nel command /discussion-arena ────
//
// Le handler vengono invocate con uno stub `ctx.ui.notify` che CATTURA il
// messaggio di avvio e LANCIA un sentinel: il command handler annuncia
// "N round(s) da eseguire" PRIMA di chiamare runDiscussionArena, quindi il
// sentinel interrompe il flusso prima del loop discussion arena reale (gsd è su PATH) e
// il test osserva solo il rounds risolto nell'annuncio.

/** Stub ctx del command: cattura le notify e interrompe prima del loop discussion arena. */
function makeCommandCtx(cwd: string): {
	cwd: string;
	ui: { notify: (msg: string) => Promise<void> };
	notified: string[];
} {
	const notified: string[] = [];
	return {
		cwd,
		ui: {
			notify: async (msg: string) => {
				notified.push(msg);
				throw new Error("STOP-BEFORE-DISCUSSION-ARENA");
			},
		},
		notified,
	};
}

test("command wiring: coordination rounds_default=5 senza N esplicito → 5 round annunciati", async () => {
	const cwd = makeRoundsTmpdir();
	try {
		writeCoordination(cwd, "rounds_default: 5");
		const { command } = captureDiscussionArenaHandlers();
		const ctx = makeCommandCtx(cwd);
		await assert.rejects(
			() => command("tema", ctx),
			/STOP-BEFORE-DISCUSSION-ARENA/,
			"il sentinel interrompe prima del loop discussion arena reale",
		);
		assert.ok(
			ctx.notified.some((m) => m.includes("5 round(s) da eseguire")),
			"l'annuncio riflette il rounds risolto dal coordination file",
		);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("command wiring: N esplicito nella riga di comando vince su rounds_default", async () => {
	const cwd = makeRoundsTmpdir();
	try {
		writeCoordination(cwd, "rounds_default: 5");
		const { command } = captureDiscussionArenaHandlers();
		const ctx = makeCommandCtx(cwd);
		await assert.rejects(() => command("tema 3", ctx), /STOP-BEFORE-DISCUSSION-ARENA/);
		assert.ok(
			ctx.notified.some((m) => m.includes("3 round(s) da eseguire")),
			"livello 1 (N esplicito) vince sul livello 3",
		);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("command wiring: nessun coordination file → DEFAULT_ROUNDS (2 round)", async () => {
	const cwd = makeRoundsTmpdir();
	try {
		const { command } = captureDiscussionArenaHandlers();
		const ctx = makeCommandCtx(cwd);
		await assert.rejects(() => command("tema", ctx), /STOP-BEFORE-DISCUSSION-ARENA/);
		assert.ok(
			ctx.notified.some((m) => m.includes("2 round(s) da eseguire")),
			"nessun livello 3 → livello 4 (DEFAULT_ROUNDS)",
		);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("command wiring: coordination rounds_default=99 → clamp a MAX_ROUNDS (5 round)", async () => {
	const cwd = makeRoundsTmpdir();
	try {
		writeCoordination(cwd, "rounds_default: 99");
		const { command } = captureDiscussionArenaHandlers();
		const ctx = makeCommandCtx(cwd);
		await assert.rejects(() => command("tema", ctx), /STOP-BEFORE-DISCUSSION-ARENA/);
		assert.ok(
			ctx.notified.some((m) => m.includes("5 round(s) da eseguire")),
			"il cablaggio clippa a MAX_ROUNDS=5",
		);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
