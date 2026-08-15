/**
 * Reference table source-anchored delle sei pagine di docs/architecture/
 * (M006/S04/T01).
 *
 * Contratto eseguibile (Integration Closure di S04): la garanzia "nessun
 * riferimento stale nella documentazione architetturale" non è una checklist
 * mentale — è questa suite. La reference table sotto è l'unica fonte di
 * verità tra la prosa e il codice: le pagine EN+IT di `docs/architecture/`
 * devono citare esattamente i file, i simboli, le righe e i valori che la
 * tabella ancora, e ogni voce della tabella deve risolvere nei sorgenti
 * attuali.
 *
 * Doppio verso di verifica (sensibilità, non vacuità):
 *   - source-side (questa unit, T01): per ogni voce la suite assert che
 *     (a) il file sorgente esiste, (b) il simbolo/pattern è definito in quel
 *     file, (c) il range di righe documentato contiene la dichiarazione,
 *     (d) il valore citato coincide con il literal del sorgente. In più i
 *     valori reali vengono importati ed assertati: `MAX_PARTICIPANTS = 8`,
 *     `MAX_ROUNDS = 5`, `DEFAULT_ROUNDS = 2` (index.ts:108-110) e
 *     `DEFAULT_PARTICIPANT_LIMITS` (helpers.ts:85-91); il trigger a tre tier
 *     viene eseguito davvero con fixture temporanee.
 *   - doc-side (chiusura in T06): ogni voce dichiara la pagina EN+IT che la
 *     DEVE citare (campo `page`); la guardia implementata in T06 legge le
 *     pagine e verifica la citazione (più l'index che linka tutte le pagine),
 *     così il test non passa né se il codice cambia né se le pagine vengono
 *     svuotate.
 *
 * Se un futuro commit rinomina `MAX_PARTICIPANTS`, sposta `resolveTrigger`
 * o cambia `outputLimitChars`, il fallimento nomina pagina + simbolo + valore
 * atteso vs trovato (una voce per gruppo di reference, output node:test).
 *
 * Nessuna dipendenza npm: solo node:test, node:assert e i moduli reali del
 * repo (importati via loader ESM, come gli altri test). Le fixture
 * temporanee vivono in os.tmpdir, mai in path gitignored del repo.
 */

import { afterEach, before, test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_ROUNDS, MAX_PARTICIPANTS, MAX_ROUNDS } from "../index.js";
import { DEFAULT_PARTICIPANT_LIMITS } from "../helpers.js";
import { resolveTrigger } from "../trigger-resolver.js";

// ---------------------------------------------------------------------------
// Root del repo e moduli documentati
// ---------------------------------------------------------------------------

/** Root del repo (risolta rispetto a questo file, non al cwd). */
const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

/** Moduli alla root citati dalle pagine (piano slice S04). */
const ROOT_MODULES = [
	"index.ts",
	"participants.ts",
	"helpers.ts",
	"run-participant.ts",
	"trigger-resolver.ts",
	"discussion-arena-session.ts",
	"metrics.ts",
	"replay.ts",
] as const;

/** Moduli in src/ citati dalle pagine (piano slice S04). */
const SRC_MODULES = [
	"src/hooks-planning.ts",
	"src/markers.ts",
	"src/log-prefix.ts",
	"src/discussion-arena-coordination.ts",
	"src/parse-discussion-arena-block.ts",
	"src/shared-parser.ts",
	"src/tui-wizard.ts",
	"src/preferences-writer.ts",
	"src/discussion-arena-cli.ts",
	"src/discussion-arena-cli-main.ts",
] as const;

// ---------------------------------------------------------------------------
// Reference table source-anchored
// ---------------------------------------------------------------------------

/**
 * Una voce della reference table. `page` è lo stem della pagina EN+IT che
 * deve citare la reference (guardia doc-side); `file` è il path
 * relativo dal root; `symbol` è il nome citato (usato nei messaggi di
 * errore); `lines` è il range di righe documentato (1-based, inclusivo,
 * opzionale); `kind` decide la verifica:
 *   - "const": la dichiarazione `export const <symbol>` deve stare in
 *     `lines` e il literal `= <expected>;` deve comparire nella regione di
 *     dichiarazione;
 *   - "object": la dichiarazione `export const <symbol>` deve stare in
 *     `lines` e ogni `fields[key]: <literal>` nel range;
 *   - "callable": `export [async] function <symbol>` deve stare in `lines`;
 *   - "pattern": la regex `pattern` deve matchare in `lines` (o nel file se
 *     `lines` è assente).
 */
interface RefEntry {
	id: string;
	page: string;
	file: string;
	symbol: string;
	kind: "const" | "object" | "callable" | "pattern";
	lines?: [number, number];
	expected?: string | number;
	fields?: Record<string, string>;
	pattern?: string;
}

/**
 * Tabella delle reference: ogni voce è una citazione che le pagine di
 * `docs/architecture/` devono contenere e che questa suite ancora al
 * sorgente. I range di righe sono verificati contro i file reali: se un
 * commit li sposta, il test fallisce e la pagina (o la voce) va aggiornata.
 */
const REFERENCE_TABLE: RefEntry[] = [
	// ---- runtime-limits ----------------------------------------------------
	{ id: "RL-MAX-PARTICIPANTS", page: "runtime-limits", file: "index.ts", symbol: "MAX_PARTICIPANTS", kind: "const", expected: 8, lines: [108, 108] },
	{ id: "RL-MAX-ROUNDS", page: "runtime-limits", file: "index.ts", symbol: "MAX_ROUNDS", kind: "const", expected: 5, lines: [109, 109] },
	{ id: "RL-DEFAULT-ROUNDS", page: "runtime-limits", file: "index.ts", symbol: "DEFAULT_ROUNDS", kind: "const", expected: 2, lines: [110, 110] },
	{
		id: "RL-PARTICIPANT-LIMITS",
		page: "runtime-limits",
		file: "helpers.ts",
		symbol: "DEFAULT_PARTICIPANT_LIMITS",
		kind: "object",
		fields: {
			roundTimeoutMs: "300_000",
			eventTimeoutMs: "60_000",
			outputLimitChars: "16_000",
			costBudgetUsd: "1.0",
			termination: '"soft"',
		},
		lines: [85, 91],
	},
	{
		id: "RL-CLAMP-ROUNDS",
		page: "runtime-limits",
		file: "index.ts",
		symbol: "Math.min(parsed, MAX_ROUNDS)",
		kind: "pattern",
		pattern: "Math\\.min\\(parsed, MAX_ROUNDS\\)",
		lines: [310, 310],
	},
	{
		id: "RL-CAP-PARTICIPANTS",
		page: "runtime-limits",
		file: "index.ts",
		symbol: "selected.slice(0, MAX_PARTICIPANTS)",
		kind: "pattern",
		pattern: "selected\\.slice\\(0, MAX_PARTICIPANTS\\)",
		lines: [352, 352],
	},
	{
		id: "RL-SCHEMA-CAP",
		page: "runtime-limits",
		file: "index.ts",
		symbol: "maximum: MAX_ROUNDS",
		kind: "pattern",
		pattern: "maximum: MAX_ROUNDS",
		lines: [127, 127],
	},
	{
		id: "RL-RESOLVE-FOR-PARTICIPANT",
		page: "runtime-limits",
		file: "index.ts",
		symbol: "resolveParticipantLimitsForParticipant",
		kind: "callable",
		lines: [366, 366],
	},
	{
		id: "RL-FORMAT-MARKER",
		page: "runtime-limits",
		file: "helpers.ts",
		symbol: "formatFailureMarker",
		kind: "callable",
		lines: [203, 203],
	},
	{
		id: "RL-SOFT-GRACE",
		page: "runtime-limits",
		file: "run-participant.ts",
		symbol: "SOFT_TERMINATION_GRACE_MS = 5_000",
		kind: "pattern",
		pattern: "SOFT_TERMINATION_GRACE_MS = 5_000",
		lines: [57, 57],
	},

	// ---- trigger-resolution ------------------------------------------------
	{ id: "TR-RESOLVE", page: "trigger-resolution", file: "trigger-resolver.ts", symbol: "resolveTrigger", kind: "callable", lines: [139, 139] },
	{
		id: "TR-OUTPUT-IFACE",
		page: "trigger-resolution",
		file: "trigger-resolver.ts",
		symbol: "ResolveTriggerOutput",
		kind: "pattern",
		pattern: "interface ResolveTriggerOutput\\b",
		lines: [46, 46],
	},
	{
		id: "TR-PARSE-PREFS",
		page: "trigger-resolution",
		file: "trigger-resolver.ts",
		symbol: "parsePreferences",
		kind: "pattern",
		pattern: "function parsePreferences\\b",
		lines: [69, 69],
	},
	{
		id: "TR-ENV-VAR",
		page: "trigger-resolution",
		file: "trigger-resolver.ts",
		symbol: "GSD_DISCUSSION_ARENA_AUTO",
		kind: "pattern",
		pattern: "GSD_DISCUSSION_ARENA_AUTO",
	},
	{ id: "TR-PARSE-SHARED", page: "trigger-resolution", file: "src/parse-discussion-arena-block.ts", symbol: "parseDiscussionArenaBlock", kind: "callable", lines: [118, 118] },
	{ id: "TR-LOG-PREFIX", page: "trigger-resolution", file: "src/log-prefix.ts", symbol: "LOG_PREFIX", kind: "const", expected: "[discussion-arena]", lines: [12, 12] },

	// ---- hooks --------------------------------------------------------------
	{ id: "HK-ATTACH", page: "hooks", file: "src/hooks-planning.ts", symbol: "attachDiscussionArenaHooks", kind: "callable", lines: [35, 35] },
	{ id: "HK-UNIT-START", page: "hooks", file: "src/hooks-unit-aware.ts", symbol: "unit_start", kind: "pattern", pattern: '"unit_start"' },
	{ id: "HK-ADJUST-TOOLSET", page: "hooks", file: "src/hooks-unit-aware.ts", symbol: "adjust_tool_set", kind: "pattern", pattern: '"adjust_tool_set"' },
	{ id: "HK-BEFORE-AGENT", page: "hooks", file: "src/hooks-unit-aware.ts", symbol: "before_agent_start", kind: "pattern", pattern: '"before_agent_start"' },
	{
		id: "HK-MARKER",
		page: "hooks",
		file: "src/markers.ts",
		symbol: "PLANNING_INSTRUCTION_MARKER",
		kind: "const",
		expected: "<!-- gsd-pi-discussion-arena-planning-instruction -->",
		lines: [17, 17],
	},

	// ---- invocation-flow -----------------------------------------------------
	{
		id: "IF-ACTIVATE",
		page: "invocation-flow",
		file: "index.ts",
		symbol: "activate",
		kind: "pattern",
		pattern: "export default function activate\\b",
		lines: [906, 906],
	},
	{
		id: "IF-REGISTER-TOOL",
		page: "invocation-flow",
		file: "index.ts",
		symbol: "registerTool",
		kind: "pattern",
		pattern: "api\\.registerTool\\(",
		lines: [981, 981],
	},
	{
		id: "IF-PARAMS-SCHEMA",
		page: "invocation-flow",
		file: "index.ts",
		symbol: "DiscussionArenaParamsSchema",
		kind: "pattern",
		pattern: "const DiscussionArenaParamsSchema",
		lines: [112, 112],
	},
	{ id: "IF-MAIN", page: "invocation-flow", file: "index.ts", symbol: "main", kind: "callable", lines: [104, 104] },
	{ id: "IF-RUN-ARENA", page: "invocation-flow", file: "index.ts", symbol: "runDiscussionArena", kind: "callable", lines: [443, 443] },
	{ id: "IF-CLI-DUMP", page: "invocation-flow", file: "src/discussion-arena-cli.ts", symbol: "dumpParticipantsCli", kind: "callable", lines: [124, 124] },
	{
		id: "IF-CLI-MAIN",
		page: "invocation-flow",
		file: "src/discussion-arena-cli-main.ts",
		symbol: "dumpParticipantsCli(process.argv, process.cwd())",
		kind: "pattern",
		pattern: "dumpParticipantsCli\\(process\\.argv, process\\.cwd\\(\\)\\)",
	},

	// ---- participant-subprocesses -------------------------------------------
	{ id: "PS-RUN-TURN", page: "participant-subprocesses", file: "run-participant.ts", symbol: "runParticipantTurn", kind: "callable", lines: [131, 131] },
	{ id: "PS-DISCOVER", page: "participant-subprocesses", file: "participants.ts", symbol: "discoverParticipants", kind: "callable", lines: [438, 438] },
	{ id: "PS-ACCUMULATE-COST", page: "participant-subprocesses", file: "helpers.ts", symbol: "accumulateCost", kind: "callable", lines: [132, 132] },
	{ id: "PS-TRUNCATE-OUTPUT", page: "participant-subprocesses", file: "helpers.ts", symbol: "truncateOutput", kind: "callable", lines: [150, 150] },
	{ id: "PS-RESOLVE-LIMITS", page: "participant-subprocesses", file: "helpers.ts", symbol: "resolveParticipantLimits", kind: "callable", lines: [313, 313] },
	{
		id: "PS-NO-SESSION",
		page: "participant-subprocesses",
		file: "run-participant.ts",
		symbol: '["--mode", "json", "-p", "--no-session"]',
		kind: "pattern",
		pattern: '\\["--mode", "json", "-p", "--no-session"\\]',
		lines: [139, 139],
	},

	// ---- round-orchestration -------------------------------------------------
	{
		id: "RO-TRUNCATE-TRANSCRIPT",
		page: "round-orchestration",
		file: "index.ts",
		symbol: "truncateTranscriptForPrompt",
		kind: "pattern",
		pattern: "function truncateTranscriptForPrompt\\b",
		lines: [206, 206],
	},
	{
		id: "RO-TRANSCRIPT-BUDGET",
		page: "round-orchestration",
		file: "index.ts",
		symbol: "maxBytes: number = 100_000",
		kind: "pattern",
		pattern: "maxBytes: number = 100_000",
		lines: [208, 208],
	},
	{ id: "RO-ROUNDS-DEFAULT", page: "round-orchestration", file: "participants.ts", symbol: "resolveRoundsDefault", kind: "callable", lines: [585, 585] },
	{ id: "RO-SESSION-PATH", page: "round-orchestration", file: "discussion-arena-session.ts", symbol: "getSessionFilePath", kind: "callable", lines: [50, 50] },
	{ id: "RO-SAVE-SESSION", page: "round-orchestration", file: "discussion-arena-session.ts", symbol: "saveSession", kind: "callable", lines: [78, 78] },
	{ id: "RO-LOAD-SESSION", page: "round-orchestration", file: "discussion-arena-session.ts", symbol: "loadSession", kind: "callable", lines: [61, 61] },
	{
		id: "RO-TRANSCRIPTS-DIR",
		page: "round-orchestration",
		file: "discussion-arena-session.ts",
		symbol: '"transcripts"',
		kind: "pattern",
		pattern: '"transcripts"',
		lines: [49, 55],
	},
];

// ---------------------------------------------------------------------------
// Motore di verifica (funzioni pure: errori -> string[], testabili in negativo)
// ---------------------------------------------------------------------------

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Riga (1-based) della dichiarazione/ancora di una voce: per "const"/"object"
 * la riga con `export const <symbol>`, per "callable" la riga con
 * `export [async] function <symbol>`, per "pattern" la prima riga che matcha.
 * -1 se assente.
 */
function findAnchorLine(entry: RefEntry, lines: string[]): number {
	const pattern =
		entry.kind === "pattern"
			? entry.pattern!
			: entry.kind === "callable"
				? `export (?:async )?function ${escapeRegExp(entry.symbol)}\\b`
				: `export const ${escapeRegExp(entry.symbol)}\\b`;
	const re = new RegExp(pattern);
	for (let i = 0; i < lines.length; i++) {
		if (re.test(lines[i])) return i + 1;
	}
	return -1;
}

/**
 * Verifica una voce contro il sorgente. `fileCache` mappa path relativo ->
 * righe del file (solo i file esistenti); un path assente è esso stesso un
 * errore. Ritorna i messaggi di errore (vuoto = voce verificata).
 */
function verifyEntry(entry: RefEntry, fileCache: Map<string, string[]>): string[] {
	const errors: string[] = [];
	const label = `[${entry.page}] ${entry.symbol} (${entry.file})`;
	const lines = fileCache.get(entry.file);
	if (!lines) {
		errors.push(`${label}: file sorgente mancante`);
		return errors;
	}
	const joined = lines.join("\n");

	// (b) simbolo/pattern definito nel file
	if (entry.kind === "pattern") {
		if (!new RegExp(entry.pattern!).test(joined)) {
			errors.push(`${label}: pattern "${entry.pattern}" non trovato nel file`);
		}
	} else if (!new RegExp(`\\b${escapeRegExp(entry.symbol)}\\b`).test(joined)) {
		errors.push(`${label}: simbolo non trovato nel file`);
	}

	// (c) range di righe documentato contiene la dichiarazione
	if (entry.lines) {
		const anchor = findAnchorLine(entry, lines);
		if (anchor === -1) {
			errors.push(`${label}: dichiarazione non trovata nel file`);
		} else if (anchor < entry.lines[0] || anchor > entry.lines[1]) {
			errors.push(
				`${label}: riga documentata ${entry.lines[0]}-${entry.lines[1]}, dichiarazione trovata a riga ${anchor}`,
			);
		}
	}

	// (d) valore citato coincide con il literal del sorgente
	if (entry.kind === "const" && entry.expected !== undefined) {
		const declIdx = findAnchorLine(entry, lines);
		if (declIdx !== -1) {
			const region = lines.slice(declIdx - 1, declIdx + 9).join("\n");
			const lit =
				typeof entry.expected === "number"
					? `=\\s*${escapeRegExp(String(entry.expected))}\\s*;`
					: `=\\s*"${escapeRegExp(String(entry.expected))}"\\s*;`;
			if (!new RegExp(lit).test(region)) {
				errors.push(`${label}: valore atteso ${entry.expected}, non trovato nella regione di dichiarazione`);
			}
		}
	}
	if (entry.kind === "object" && entry.fields) {
		const [start, end] = entry.lines ?? [1, lines.length];
		const region = lines.slice(start - 1, end).join("\n");
		for (const [key, literal] of Object.entries(entry.fields)) {
			const re = new RegExp(`^\\s*${escapeRegExp(key)}\\s*:\\s*${escapeRegExp(literal)}`, "m");
			if (!re.test(region)) {
				errors.push(`${label}: campo ${key}: ${literal} non trovato nel range documentato`);
			}
		}
	}
	return errors;
}

// ---------------------------------------------------------------------------
// Stato condiviso: cache dei sorgenti reali
// ---------------------------------------------------------------------------

const ALL_FILES = [
	...new Set([...ROOT_MODULES, ...SRC_MODULES, ...REFERENCE_TABLE.map((e) => e.file)]),
] as string[];

let sourceCache: Map<string, string[]>;

before(() => {
	sourceCache = new Map();
	for (const file of ALL_FILES) {
		const abs = path.join(REPO_ROOT, file);
		if (fs.existsSync(abs)) {
			sourceCache.set(file, fs.readFileSync(abs, "utf8").split("\n"));
		}
	}
});

// ---------------------------------------------------------------------------
// Guardie di non-vacuità della tabella
// ---------------------------------------------------------------------------

test("guardia: la reference table copre almeno 25 reference distribuite su tutte le sei pagine", () => {
	assert.ok(
		REFERENCE_TABLE.length >= 25,
		`la reference table ha ${REFERENCE_TABLE.length} entries: il contratto slice S04 ne richiede ~25-35`,
	);
	const pages = [...new Set(REFERENCE_TABLE.map((e) => e.page))].sort();
	assert.deepEqual(pages, [
		"hooks",
		"invocation-flow",
		"participant-subprocesses",
		"round-orchestration",
		"runtime-limits",
		"trigger-resolution",
	]);
});

// ---------------------------------------------------------------------------
// Source-side: moduli e reference risolvono nei sorgenti
// ---------------------------------------------------------------------------

test("moduli documentati: i 18 moduli root+src citati dalle pagine esistono", () => {
	const missing: string[] = [];
	for (const file of [...ROOT_MODULES, ...SRC_MODULES]) {
		if (!fs.existsSync(path.join(REPO_ROOT, file))) missing.push(file);
	}
	assert.deepEqual(missing, [], "moduli documentati mancanti dal repo");
});

test("reference table: ogni file citato esiste alla root o in src/", () => {
	const missing = REFERENCE_TABLE.map((e) => e.file).filter(
		(file) => !fs.existsSync(path.join(REPO_ROOT, file)),
	);
	assert.deepEqual(missing, [], "file citati dalla reference table mancanti");
});

test("runtime-limits: costanti, default partecipante e clamp (index.ts:105-107, helpers.ts:85-91)", () => {
	const errors = REFERENCE_TABLE.filter((e) => e.page === "runtime-limits").flatMap((e) =>
		verifyEntry(e, sourceCache),
	);
	assert.deepEqual(errors, [], errors.join("\n"));
});

test("trigger-resolution: resolveTrigger, parser e costanti (trigger-resolver.ts, src/)", () => {
	const errors = REFERENCE_TABLE.filter((e) => e.page === "trigger-resolution").flatMap((e) =>
		verifyEntry(e, sourceCache),
	);
	assert.deepEqual(errors, [], errors.join("\n"));
});

test("hooks: attachDiscussionArenaHooks e i tre hook unit-aware condivisi (src/hooks-planning.ts, src/hooks-unit-aware.ts, src/markers.ts)", () => {
	const errors = REFERENCE_TABLE.filter((e) => e.page === "hooks").flatMap((e) =>
		verifyEntry(e, sourceCache),
	);
	assert.deepEqual(errors, [], errors.join("\n"));
});

test("invocation-flow: activate, registerTool, schema e CLI (index.ts, src/discussion-arena-cli*.ts)", () => {
	const errors = REFERENCE_TABLE.filter((e) => e.page === "invocation-flow").flatMap((e) =>
		verifyEntry(e, sourceCache),
	);
	assert.deepEqual(errors, [], errors.join("\n"));
});

test("participant-subprocesses: runParticipantTurn, discovery e helpers (run-participant.ts, participants.ts, helpers.ts)", () => {
	const errors = REFERENCE_TABLE.filter((e) => e.page === "participant-subprocesses").flatMap((e) =>
		verifyEntry(e, sourceCache),
	);
	assert.deepEqual(errors, [], errors.join("\n"));
});

test("round-orchestration: sessione e troncamento (index.ts, participants.ts, discussion-arena-session.ts)", () => {
	const errors = REFERENCE_TABLE.filter((e) => e.page === "round-orchestration").flatMap((e) =>
		verifyEntry(e, sourceCache),
	);
	assert.deepEqual(errors, [], errors.join("\n"));
});

// ---------------------------------------------------------------------------
// Source-side: i valori reali importati coincidono con quelli documentati
// ---------------------------------------------------------------------------

test("limiti runtime: MAX_PARTICIPANTS=8, MAX_ROUNDS=5, DEFAULT_ROUNDS=2 (index.ts:108-110)", () => {
	// Valori importati dal modulo reale.
	assert.equal(MAX_PARTICIPANTS, 8);
	assert.equal(MAX_ROUNDS, 5);
	assert.equal(DEFAULT_ROUNDS, 2);
	// Le righe documentate (1-based) contengono le dichiarazioni esatte.
	const indexLines = sourceCache.get("index.ts")!;
	assert.ok(indexLines[107].includes("export const MAX_PARTICIPANTS = 8;"), `riga 108: ${indexLines[107]}`);
	assert.ok(indexLines[108].includes("export const MAX_ROUNDS = 5;"), `riga 109: ${indexLines[108]}`);
	assert.ok(indexLines[109].includes("export const DEFAULT_ROUNDS = 2;"), `riga 110: ${indexLines[109]}`);
});

test("limiti runtime: DEFAULT_PARTICIPANT_LIMITS coincide con helpers.ts:85-91", () => {
	// Valore importato dal modulo reale.
	assert.deepEqual(DEFAULT_PARTICIPANT_LIMITS, {
		roundTimeoutMs: 300_000,
		eventTimeoutMs: 60_000,
		outputLimitChars: 16_000,
		costBudgetUsd: 1.0,
		termination: "soft",
	});
	// Il blocco documentato (righe 85-91) contiene i literal esatti.
	const helpersLines = sourceCache.get("helpers.ts")!;
	const block = helpersLines.slice(84, 91).join("\n");
	for (const literal of ["roundTimeoutMs: 300_000", "eventTimeoutMs: 60_000", "outputLimitChars: 16_000", "costBudgetUsd: 1.0", 'termination: "soft"']) {
		assert.ok(block.includes(literal), `helpers.ts:85-91 deve contenere ${literal}`);
	}
});

// ---------------------------------------------------------------------------
// Source-side: la descrizione a tre tier coincide con il comportamento reale
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

async function makeTmp(prefix: string): Promise<string> {
	const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), prefix));
	tmpDirs.push(dir);
	return dir;
}

/** Scrive `.gsd/PREFERENCES.md` sotto cwd (formato identico ai test del resolver). */
async function writePrefs(cwd: string, content: string): Promise<void> {
	const gsdDir = path.join(cwd, ".gsd");
	await fsPromises.mkdir(gsdDir, { recursive: true });
	await fsPromises.writeFile(path.join(gsdDir, "PREFERENCES.md"), content, "utf8");
}

afterEach(async () => {
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop()!;
		await fsPromises.rm(dir, { recursive: true, force: true });
	}
});

test("trigger: tier 1 env, tier 2 preferences, tier 3 fallback — comportamento reale di resolveTrigger", async () => {
	const cwd = await makeTmp("arch-refs-tier-");

	// Tier 1: GSD_DISCUSSION_ARENA_AUTO === "1" -> forced/env.
	const t1 = await resolveTrigger({ cwd, milestoneId: "M001", env: { GSD_DISCUSSION_ARENA_AUTO: "1" } });
	assert.equal(t1.decision, "forced");
	assert.equal(t1.source, "env");

	// Tier 2: PREFERENCES.md milestones.<mid>.enabled -> forced/preferences.
	await writePrefs(
		cwd,
		`---
version: 1
discussion_arena:
  milestones:
    M001:
      enabled: true
---`,
	);
	const t2 = await resolveTrigger({ cwd, milestoneId: "M001", env: {} });
	assert.equal(t2.decision, "forced");
	assert.equal(t2.source, "preferences");

	// Tier 2: PREFERENCES.md discussion_arena.enabled globale -> forced/preferences.
	await writePrefs(
		cwd,
		`---
version: 1
discussion_arena:
  enabled: true
---`,
	);
	const t2b = await resolveTrigger({ cwd, milestoneId: "M001", env: {} });
	assert.equal(t2b.decision, "forced");
	assert.equal(t2b.source, "preferences");

	// Tier 3: nessun env, nessun PREFERENCES.md -> available-only/fallback.
	await fsPromises.rm(path.join(cwd, ".gsd"), { recursive: true, force: true });
	const t3 = await resolveTrigger({ cwd, milestoneId: "M001", env: {} });
	assert.equal(t3.decision, "available-only");
	assert.equal(t3.source, "fallback");
});

// ---------------------------------------------------------------------------
// Casi negativi su fixture/sorgenti reali: la verifica è sensibile, non vacua
// ---------------------------------------------------------------------------

test("negativo: un file inesistente nella reference table viene rilevato", () => {
	const cache = new Map<string, string[]>();
	const errors = verifyEntry(
		{ id: "NEG-FILE", page: "runtime-limits", file: "no-such-file.ts", symbol: "X", kind: "const", expected: 1 },
		cache,
	);
	assert.deepEqual(errors, ["[runtime-limits] X (no-such-file.ts): file sorgente mancante"]);
});

test("negativo: un simbolo assente dal file sorgente viene rilevato", () => {
	const errors = verifyEntry(
		{ id: "NEG-SYM", page: "hooks", file: "index.ts", symbol: "NoSuchSymbolXYZ", kind: "callable" },
		sourceCache,
	);
	assert.deepEqual(errors, ["[hooks] NoSuchSymbolXYZ (index.ts): simbolo non trovato nel file"]);
});

test("negativo: un valore divergente dai limiti documentati viene rilevato", () => {
	// Sensibilità del contratto chiave: se MAX_PARTICIPANTS cambiasse valore,
	// il fallimento nomina la voce e il valore atteso vs trovato.
	const errors = verifyEntry(
		{ id: "RL-MAX-PARTICIPANTS", page: "runtime-limits", file: "index.ts", symbol: "MAX_PARTICIPANTS", kind: "const", expected: 9, lines: [105, 105] },
		sourceCache,
	);
	assert.ok(
		errors.some((e) => e.includes("valore atteso 9")),
		`errore atteso sul valore, trovato: ${errors.join("; ") || "(nessun errore)"}`,
	);
});

test("negativo: una riga documentata divergente viene rilevata", () => {
	const errors = verifyEntry(
		{ id: "RL-MAX-PARTICIPANTS", page: "runtime-limits", file: "index.ts", symbol: "MAX_PARTICIPANTS", kind: "const", expected: 8, lines: [200, 200] },
		sourceCache,
	);
	assert.ok(
		errors.some((e) => e.includes("riga documentata 200-200") && e.includes("riga 108")),
		`errore atteso sul range di righe, trovato: ${errors.join("; ") || "(nessun errore)"}`,
	);
});

test("negativo: un campo mancante da DEFAULT_PARTICIPANT_LIMITS viene rilevato", () => {
	const errors = verifyEntry(
		{
			id: "RL-PARTICIPANT-LIMITS",
			page: "runtime-limits",
			file: "helpers.ts",
			symbol: "DEFAULT_PARTICIPANT_LIMITS",
			kind: "object",
			fields: { roundTimeoutMs: "300_000", eventTimeoutMs: "999_999" },
			lines: [85, 91],
		},
		sourceCache,
	);
	assert.ok(
		errors.some((e) => e.includes("campo eventTimeoutMs: 999_999")),
		`errore atteso sul campo divergente, trovato: ${errors.join("; ") || "(nessun errore)"}`,
	);
});

test("negativo: un pattern assente dal file viene rilevato", () => {
	const errors = verifyEntry(
		{ id: "NEG-PATTERN", page: "trigger-resolution", file: "helpers.ts", symbol: "Math.min(parsed, MAX_ROUNDS)", kind: "pattern", pattern: "Math\\.min\\(parsed, MAX_ROUNDS\\)" },
		sourceCache,
	);
	assert.ok(
		errors.some((e) => e.includes('pattern "Math\\.min\\(parsed, MAX_ROUNDS\\)" non trovato')),
		`errore atteso sul pattern, trovato: ${errors.join("; ") || "(nessun errore)"}`,
	);
});

test("negativo: il tier 1 discrimina davvero il valore esatto dell'env var", async () => {
	// Solo "1" forza: "0" (o assente) deve cadere al tier 3. Se il resolver
	// smettesse di distinguere, il contratto a tre tier sarebbe violato.
	const cwd = await makeTmp("arch-refs-neg-env-");
	const result = await resolveTrigger({ cwd, milestoneId: "M001", env: { GSD_DISCUSSION_ARENA_AUTO: "0" } });
	assert.equal(result.decision, "available-only");
	assert.equal(result.source, "fallback");
});

// ---------------------------------------------------------------------------
// Doc-side (T06): le pagine EN+IT citano le reference dichiarate in tabella
// ---------------------------------------------------------------------------

/** Directory delle pagine del riferimento architetturale. */
const DOCS_ARCH_DIR = path.join(REPO_ROOT, "docs", "architecture");

/** Le sei pagine del riferimento, derivate dalla tabella (ordine stabile). */
const DOC_PAGES = [...new Set(REFERENCE_TABLE.map((e) => e.page))].sort();

/**
 * Pattern con cui una voce deve comparire nella pagina: gli identificatori
 * semplici (`` `MAX_PARTICIPANTS` ``) con confine di parola — così
 * `` `main` `` non matcha "domain" —, i pattern composti (spazi, virgolette,
 * parentesi) come substring esatto.
 */
function citationPattern(symbol: string): RegExp {
	if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(symbol)) {
		return new RegExp(`\\b${escapeRegExp(symbol)}\\b`);
	}
	return new RegExp(escapeRegExp(symbol));
}

/**
 * Guardia doc-side: per ogni pagina dichiarata in tabella verifica che
 * ciascuna variante linguistica (`<page><lang>.md`) citi ogni reference.
 * Funzione pura (errori -> string[]), testabile in negativo su fixture
 * temporanee. Il test non passa né se il codice cambia (source-side) né se
 * le pagine vengono svuotate o un simbolo citato viene rimosso (doc-side).
 */
function verifyDocCitations(table: RefEntry[], pagesDir: string, langs: string[]): string[] {
	const errors: string[] = [];
	const byPage = new Map<string, RefEntry[]>();
	for (const entry of table) {
		const list = byPage.get(entry.page) ?? [];
		list.push(entry);
		byPage.set(entry.page, list);
	}
	for (const page of [...byPage.keys()].sort()) {
		for (const lang of langs) {
			const file = path.join(pagesDir, `${page}${lang}.md`);
			if (!fs.existsSync(file)) {
				errors.push(`[doc-side] pagina mancante: ${page}${lang}.md`);
				continue;
			}
			const content = fs.readFileSync(file, "utf8");
			for (const entry of byPage.get(page)!) {
				if (!citationPattern(entry.symbol).test(content)) {
					errors.push(
						`[doc-side] ${page}${lang}.md non cita "${entry.symbol}" (voce ${entry.id}): pagina svuotata o simbolo rimosso`,
					);
				}
			}
		}
	}
	return errors;
}

/**
 * Guardia di navigazione: index.md e index.it.md linkano tutte le pagine
 * della tabella (EN -> `.md`, IT -> `.it.md`, stessa convenzione delle altre
 * sezioni docs/). Una pagina nuova in tabella senza entry negli index è un
 * errore: il grafo di navigazione del riferimento resta chiuso.
 */
function verifyDocIndex(pages: string[], docsDir: string): string[] {
	const errors: string[] = [];
	for (const page of pages) {
		for (const suffix of ["", ".it"]) {
			const file = path.join(docsDir, `index${suffix}.md`);
			if (!fs.existsSync(file)) {
				errors.push(`[doc-side] index mancante: index${suffix}.md`);
				continue;
			}
			const content = fs.readFileSync(file, "utf8");
			if (!content.includes(`(${page}${suffix}.md)`)) {
				errors.push(`[doc-side] index${suffix}.md non linka ${page}${suffix}.md`);
			}
		}
	}
	return errors;
}

test("doc-side: le sei pagine EN+IT citano tutte le reference della tabella", () => {
	const errors = verifyDocCitations(REFERENCE_TABLE, DOCS_ARCH_DIR, ["", ".it"]);
	assert.deepEqual(errors, [], errors.join("\n"));
});

test("doc-side: index EN+IT linkano tutte le pagine dichiarate in tabella", () => {
	const errors = verifyDocIndex(DOC_PAGES, DOCS_ARCH_DIR);
	assert.deepEqual(errors, [], errors.join("\n"));
});

test("negativo doc-side: una pagina svuotata viene rilevata con pagina, lingua e simbolo", async () => {
	const dir = await makeTmp("arch-refs-doc-");
	const pagesDir = path.join(dir, "docs", "architecture");
	await fsPromises.mkdir(pagesDir, { recursive: true });
	await fsPromises.writeFile(path.join(pagesDir, "runtime-limits.md"), "", "utf8");
	await fsPromises.writeFile(path.join(pagesDir, "runtime-limits.it.md"), "", "utf8");
	const table: RefEntry[] = [
		{ id: "RL-MAX-PARTICIPANTS", page: "runtime-limits", file: "index.ts", symbol: "MAX_PARTICIPANTS", kind: "const", expected: 8, lines: [105, 105] },
	];
	const errors = verifyDocCitations(table, pagesDir, ["", ".it"]);
	assert.deepEqual(
		errors,
		[
			'[doc-side] runtime-limits.md non cita "MAX_PARTICIPANTS" (voce RL-MAX-PARTICIPANTS): pagina svuotata o simbolo rimosso',
			'[doc-side] runtime-limits.it.md non cita "MAX_PARTICIPANTS" (voce RL-MAX-PARTICIPANTS): pagina svuotata o simbolo rimosso',
		],
		"pagina svuotata: un errore per lingua, con pagina e simbolo",
	);
});

test("negativo doc-side: una pagina senza variante .it.md viene rilevata", async () => {
	const dir = await makeTmp("arch-refs-doc-missing-");
	const pagesDir = path.join(dir, "docs", "architecture");
	await fsPromises.mkdir(pagesDir, { recursive: true });
	await fsPromises.writeFile(path.join(pagesDir, "hooks.md"), "`attachDiscussionArenaHooks`", "utf8");
	const table: RefEntry[] = [
		{ id: "HK-ATTACH", page: "hooks", file: "src/hooks-planning.ts", symbol: "attachDiscussionArenaHooks", kind: "callable", lines: [34, 34] },
	];
	const errors = verifyDocCitations(table, pagesDir, ["", ".it"]);
	assert.deepEqual(errors, ["[doc-side] pagina mancante: hooks.it.md"]);
});

test("negativo doc-side: un index che non linka una pagina viene rilevato", async () => {
	const dir = await makeTmp("arch-refs-index-");
	await fsPromises.writeFile(path.join(dir, "index.md"), "# no page links", "utf8");
	await fsPromises.writeFile(path.join(dir, "index.it.md"), "# nessun link alle pagine", "utf8");
	const errors = verifyDocIndex(["runtime-limits"], dir);
	assert.deepEqual(errors, [
		"[doc-side] index.md non linka runtime-limits.md",
		"[doc-side] index.it.md non linka runtime-limits.it.md",
	]);
});
