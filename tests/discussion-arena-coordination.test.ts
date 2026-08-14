/**
 * Unit test del loader del coordination file (S03/M004, T01).
 *
 * Copre il contratto mai-throw di `loadDiscussionArenaCoordination` e i 3 log
 * di fallback diagnostico D053 della Slice Verification:
 *   1. file assente (ENOENT)      — sourcePath null, config vuota, zero
 *                                   warnings, zero log (no-op silenzioso);
 *   2. file senza frontmatter     — config vuota, sourcePath = path, zero log;
 *   3. frontmatter valido completo — rounds_default + model_default + 2 ruoli
 *                                   virtuali con block scalar `systemPrompt`
 *                                   multi-riga preservato;
 *   4. solo rounds_default        — config.roundsDefault = 5, ruoli vuoti;
 *   5. solo roles_virtuals        — ruoli parsati, roundsDefault undefined;
 *   6. rounds_default invalido    — "five" / -1 / 0 / 5.5 → warning D053
 *                                   `rounds_default must be a positive integer
 *                                   (got <value>) — using code defaults` +
 *                                   log stderr, roundsDefault undefined;
 *   7. rounds_default 10          — accettato: il cap a MAX_ROUNDS è del
 *                                   resolver di T03, non del loader;
 *   8. virtual role incompleto    — campo required mancante → skip + D053
 *                                   `virtual role '<key>' missing required
 *                                   field <field> — skipped`, gli altri ruoli
 *                                   validi restano;
 *   9. campo con valore vuoto     — trattato come mancante (skip);
 *  10. frontmatter unterminated   — D053 generico `coordination parse error:
 *                                   <reason> — using code defaults`, config
 *                                   vuota;
 *  11. roles_virtuals inline      — valore scalare → D053 generico, config
 *                                   vuota;
 *  12. chiave top-level ignota    — ignorata, il resto della config vale;
 *  13. commenti inline e righe #  — strippati;
 *  14. block scalar con righe     — blank line interna preservata, righe
 *      vuote e CRLF               — normalizzate;
 *  15. `roles_virtuals: {}`       — map vuota accettata;
 *  16. `activation` (S01/M007)    — sezione activation: assente / valida /
 *      mode invalido / milestone ID con trattino e underscore (MID_RE
 *      permissivo) / milestones nested / scalare inline (D053 fatale).
 *
 * Il parsing della sezione `activation:` delega a
 * `parseDiscussionArenaBlock` (parser condiviso di PREFERENCES): il modo
 * lenient scarta silenziosamente mode fuori enum e milestone ID fuori MID_RE.
 * I warning D053 per questi casi sono introdotti da T02 (validazione
 * runtime); T01 copre solo la struttura e il fail-safe fatale.
 *
 * Tutte le fixture sono sintetiche su tmpdir effimera (pattern
 * participants-override.test.ts): nessun file di produzione toccato.
 */

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	loadDiscussionArenaCoordination,
	DISCUSSION_ARENA_COORDINATION_DIR,
	DISCUSSION_ARENA_COORDINATION_FILENAME,
} from "../src/discussion-arena-coordination.js";

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

/**
 * Intercetta le righe `[discussion-arena]` scritte su stderr durante `fn`
 * (log D053 del loader) e delega/silenzia il resto. Il mock è attivo solo per
 * la durata della chiamata sincrona (pattern participants-override.test.ts).
 */
function collectDiscussionArenaStderr<T>(fn: () => T): { value: T; lines: string[] } {
	const original = process.stderr.write.bind(process.stderr);
	const lines: string[] = [];
	process.stderr.write = ((chunk: unknown) => {
		const text = String(chunk);
		if (text.startsWith("[discussion-arena]")) lines.push(text);
		return true;
	}) as unknown as typeof process.stderr.write;
	try {
		const value = fn();
		return { value, lines };
	} finally {
		process.stderr.write = original;
	}
}

/**
 * Scrive un coordination file su tmpdir effimera e ritorna il path.
 * Il contenuto va scritto senza i marcatori `---` (aggiunti qui), così i
 * test dichiarano solo il corpo del frontmatter.
 */
function writeCoordination(body: string): string {
	const root = fs.mkdtempSync(
		path.join(os.tmpdir(), "gsd-discussion-arena-coordination-"),
	);
	track(root);
	const filePath = path.join(
		root,
		DISCUSSION_ARENA_COORDINATION_DIR,
		DISCUSSION_ARENA_COORDINATION_FILENAME,
	);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `---\n${body}\n---\n`, "utf-8");
	return filePath;
}

// ─── Caso 1: file assente (ENOENT) ────────────────────────────────────────

test("file assente (ENOENT): sourcePath null, config vuota, zero warnings, zero log", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-discussion-arena-coordination-"));
	track(root);
	const missing = path.join(
		root,
		DISCUSSION_ARENA_COORDINATION_DIR,
		DISCUSSION_ARENA_COORDINATION_FILENAME,
	);

	const { value: res, lines } = collectDiscussionArenaStderr(() =>
		loadDiscussionArenaCoordination(missing),
	);
	assert.equal(res.sourcePath, null, "ENOENT → nessun sourcePath");
	assert.deepEqual(res.config, { rolesVirtuals: {} }, "config vuota");
	assert.deepEqual(res.warnings, [], "nessun warning");
	assert.equal(lines.length, 0, "nessun log: l'assenza è un no-op silenzioso");
});

// ─── Caso 2: file senza frontmatter ───────────────────────────────────────

test("file senza frontmatter: config vuota, sourcePath = path, zero log", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-discussion-arena-coordination-"));
	track(root);
	const filePath = path.join(root, "coordination.md");
	fs.writeFileSync(filePath, "solo testo, nessun frontmatter\n", "utf-8");

	const { value: res, lines } = collectDiscussionArenaStderr(() =>
		loadDiscussionArenaCoordination(filePath),
	);
	assert.equal(res.sourcePath, filePath, "il file esiste → sourcePath = path");
	assert.deepEqual(res.config, { rolesVirtuals: {} }, "config vuota");
	assert.deepEqual(res.warnings, [], "nessun warning");
	assert.equal(lines.length, 0, "nessun log");
});

// ─── Caso 3: frontmatter valido completo ──────────────────────────────────

test("frontmatter valido completo: rounds_default, model_default e 2 ruoli virtuali (block scalar preservato)", () => {
	const filePath = writeCoordination(`rounds_default: 5
model_default: claude-opus-5
roles_virtuals:
  reviewer:
    name: reviewer
    role: External Reviewer
    description: Revisore esterno con focus su qualita e verificabilita
    systemPrompt: |
      Sei il reviewer esterno del consiglio. Il tuo compito e valutare
      la proposta da una prospettiva indipendente.

      Focus su qualita e verificabilita.
  tech_writer:
    name: tech_writer
    role: Technical Writer
    description: Chiarezza della documentazione
    systemPrompt: Sei il technical writer del consiglio.
`);

	const { value: res, lines } = collectDiscussionArenaStderr(() =>
		loadDiscussionArenaCoordination(filePath),
	);
	assert.equal(res.sourcePath, filePath);
	assert.deepEqual(res.warnings, [], "nessun warning su file valido");
	assert.equal(lines.length, 0, "nessun log su file valido");

	const { config } = res;
	assert.equal(config.roundsDefault, 5);
	assert.equal(config.modelDefault, "claude-opus-5");

	const reviewer = config.rolesVirtuals["reviewer"];
	assert.ok(reviewer, "reviewer presente");
	assert.equal(reviewer.name, "reviewer");
	assert.equal(reviewer.role, "External Reviewer");
	assert.equal(
		reviewer.description,
		"Revisore esterno con focus su qualita e verificabilita",
	);
	assert.equal(
		reviewer.systemPrompt,
		"Sei il reviewer esterno del consiglio. Il tuo compito e valutare\nla proposta da una prospettiva indipendente.\n\nFocus su qualita e verificabilita.",
		"block scalar multi-riga con blank line interna preservato",
	);

	const techWriter = config.rolesVirtuals["tech_writer"];
	assert.ok(techWriter, "tech_writer presente");
	assert.equal(techWriter.name, "tech_writer");
	assert.equal(techWriter.systemPrompt, "Sei il technical writer del consiglio.");

	assert.equal(Object.keys(config.rolesVirtuals).length, 2);
});

// ─── Caso 4: solo rounds_default ──────────────────────────────────────────

test("solo rounds_default: config.roundsDefault = 5, nessun ruolo", () => {
	const filePath = writeCoordination("rounds_default: 5");

	const res = loadDiscussionArenaCoordination(filePath);
	assert.equal(res.config.roundsDefault, 5);
	assert.equal(res.config.modelDefault, undefined);
	assert.deepEqual(res.config.rolesVirtuals, {});
	assert.deepEqual(res.warnings, []);
});

// ─── Caso 5: solo roles_virtuals ──────────────────────────────────────────

test("solo roles_virtuals: ruoli parsati, roundsDefault undefined", () => {
	const filePath = writeCoordination(`roles_virtuals:
  reviewer:
    name: reviewer
    role: Reviewer
    description: desc
    systemPrompt: prompt
`);

	const res = loadDiscussionArenaCoordination(filePath);
	assert.equal(res.config.roundsDefault, undefined);
	assert.equal(res.config.modelDefault, undefined);
	assert.equal(Object.keys(res.config.rolesVirtuals).length, 1);
	assert.equal(res.config.rolesVirtuals["reviewer"]!.name, "reviewer");
	assert.deepEqual(res.warnings, []);
});

// ─── Caso 6: rounds_default invalido (D053) ───────────────────────────────

test("rounds_default invalido: warning D053 + log stderr, roundsDefault undefined (parametrizzato)", () => {
	const invalidValues = ["five", "-1", "0", "5.5", ""];
	for (const bad of invalidValues) {
		const filePath = writeCoordination(`rounds_default: ${bad}`);
		const { value: res, lines } = collectDiscussionArenaStderr(() =>
			loadDiscussionArenaCoordination(filePath),
		);
		assert.equal(
			res.config.roundsDefault,
			undefined,
			`rounds_default '${bad}' ignorato`,
		);
		assert.equal(
			res.warnings.length,
			1,
			`un warning per '${bad}'`,
		);
		assert.equal(
			res.warnings[0],
			`rounds_default must be a positive integer (got ${bad}) — using code defaults`,
			`messaggio canonico per '${bad}'`,
		);
		assert.equal(
			lines.length,
			1,
			`log stderr emesso per '${bad}'`,
		);
		assert.ok(
			lines[0]!.startsWith("[discussion-arena] "),
			"prefisso canonico",
		);
	}
});

// ─── Caso 7: rounds_default sopra MAX_ROUNDS ──────────────────────────────

test("rounds_default 10: accettato (il cap a MAX_ROUNDS e del resolver di T03)", () => {
	const filePath = writeCoordination("rounds_default: 10");

	const res = loadDiscussionArenaCoordination(filePath);
	assert.equal(res.config.roundsDefault, 10, "integer positivo valido");
	assert.deepEqual(res.warnings, []);
});

// ─── Caso 8: virtual role incompleto (D053) ───────────────────────────────

test("virtual role incompleto: skip con D053, gli altri ruoli validi restano", () => {
	const filePath = writeCoordination(`roles_virtuals:
  incomplete:
    name: incomplete
    role: Solo due campi
    description: manca systemPrompt
  reviewer:
    name: reviewer
    role: Reviewer
    description: desc
    systemPrompt: prompt
`);

	const { value: res, lines } = collectDiscussionArenaStderr(() =>
		loadDiscussionArenaCoordination(filePath),
	);
	assert.deepEqual(
		res.config.rolesVirtuals["incomplete"],
		undefined,
		"entry incompleta saltata",
	);
	assert.ok(res.config.rolesVirtuals["reviewer"], "entry valida preservata");
	assert.equal(
		res.warnings.length,
		1,
		"un solo warning per la entry incompleta",
	);
	assert.equal(
		res.warnings[0],
		"virtual role 'incomplete' missing required field systemPrompt — skipped",
	);
	assert.equal(lines.length, 1, "log stderr emesso");
	assert.ok(lines[0]!.startsWith("[discussion-arena] "));
});

// ─── Caso 9: campo con valore vuoto ───────────────────────────────────────

test("campo con valore vuoto: trattato come mancante (skip con D053)", () => {
	const filePath = writeCoordination(`roles_virtuals:
  empty_role:
    name: empty_role
    role:
    description: desc
    systemPrompt: prompt
`);

	const res = loadDiscussionArenaCoordination(filePath);
	assert.deepEqual(res.config.rolesVirtuals, {}, "entry con role vuoto saltata");
	assert.deepEqual(res.warnings, [
		"virtual role 'empty_role' missing required field role — skipped",
	]);
});

// ─── Caso 10: frontmatter unterminated (D053 generico) ────────────────────

test("frontmatter unterminated: D053 generico, config vuota", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-discussion-arena-coordination-"));
	track(root);
	const filePath = path.join(root, "coordination.md");
	fs.writeFileSync(filePath, "---\nrounds_default: 5\n", "utf-8");

	const { value: res, lines } = collectDiscussionArenaStderr(() =>
		loadDiscussionArenaCoordination(filePath),
	);
	assert.deepEqual(res.config, { rolesVirtuals: {} }, "config vuota");
	assert.equal(
		res.warnings[0],
		"coordination parse error: unterminated frontmatter (missing closing ---) — using code defaults",
	);
	assert.equal(lines.length, 1, "log stderr emesso");
	assert.ok(lines[0]!.startsWith("[discussion-arena] "));
});

// ─── Caso 11: roles_virtuals inline scalar (D053 generico) ────────────────

test("roles_virtuals con valore scalare inline: D053 generico, config vuota", () => {
	const filePath = writeCoordination(`rounds_default: 5
roles_virtuals: banana
`);

	const { value: res, lines } = collectDiscussionArenaStderr(() =>
		loadDiscussionArenaCoordination(filePath),
	);
	assert.deepEqual(res.config, { rolesVirtuals: {} }, "config vuota (code defaults)");
	assert.equal(
		res.warnings.at(-1),
		"coordination parse error: roles_virtuals must be a mapping (got 'banana') — using code defaults",
	);
	assert.equal(lines.length, 1, "log stderr emesso");
});

// ─── Caso 12: chiave top-level sconosciuta ────────────────────────────────

test("chiave top-level sconosciuta: ignorata, il resto della config vale", () => {
	const filePath = writeCoordination(`round_default: 9
rounds_default: 5
model_default: claude-opus-5
`);

	const res = loadDiscussionArenaCoordination(filePath);
	assert.equal(res.config.roundsDefault, 5, "refuso 'round_default' non azzera la config");
	assert.equal(res.config.modelDefault, "claude-opus-5");
	assert.deepEqual(res.warnings, []);
});

// ─── Caso 13: commenti inline e righe # ───────────────────────────────────

test("commenti inline e righe #: strippati, config corretta", () => {
	const filePath = writeCoordination(`# forma della discussion arena
rounds_default: 5 # default dei round
model_default: claude-opus-5 # modello di fallback
roles_virtuals:
  # un ruolo one-off
  reviewer:
    name: reviewer # nome canonico
    role: External Reviewer
    description: desc
    systemPrompt: prompt
`);

	const res = loadDiscussionArenaCoordination(filePath);
	assert.equal(res.config.roundsDefault, 5, "commento inline strippato dal valore");
	assert.equal(res.config.modelDefault, "claude-opus-5");
	assert.equal(res.config.rolesVirtuals["reviewer"]!.name, "reviewer");
	assert.deepEqual(res.warnings, []);
});

// ─── Caso 14: block scalar + CRLF ─────────────────────────────────────────

test("block scalar con blank line e CRLF: contenuto preservato e normalizzato", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-discussion-arena-coordination-"));
	track(root);
	const filePath = path.join(root, "coordination.md");
	// CRLF come da file scritto su Windows.
	fs.writeFileSync(
		filePath,
		"---\r\nroles_virtuals:\r\n  reviewer:\r\n    name: reviewer\r\n    role: Reviewer\r\n    description: desc\r\n    systemPrompt: |\r\n      riga uno\r\n\r\n      riga due\r\n---\r\n",
		"utf-8",
	);

	const res = loadDiscussionArenaCoordination(filePath);
	assert.equal(
		res.config.rolesVirtuals["reviewer"]!.systemPrompt,
		"riga uno\n\nriga due",
		"blank line interna preservata, CRLF normalizzato a LF",
	);
	assert.deepEqual(res.warnings, []);
});

// ─── Caso 15: roles_virtuals: {} ──────────────────────────────────────────

test("roles_virtuals: {}: map vuota accettata senza warning", () => {
	const filePath = writeCoordination("rounds_default: 3\nroles_virtuals: {}\n");

	const res = loadDiscussionArenaCoordination(filePath);
	assert.equal(res.config.roundsDefault, 3);
	assert.deepEqual(res.config.rolesVirtuals, {});
	assert.deepEqual(res.warnings, []);
});

// ─── Sezione activation (S01/M007, T01) ───────────────────────────────────

// ─── Caso 16a: activation assente ──────────────────────────────────────────

test("activation assente: config.activation undefined, nessun warning", () => {
	const filePath = writeCoordination("rounds_default: 5\nmodel_default: m\n");

	const { value: res, lines } = collectDiscussionArenaStderr(() =>
		loadDiscussionArenaCoordination(filePath),
	);
	assert.equal(res.config.activation, undefined, "sezione assente → campo assente");
	assert.equal(res.config.roundsDefault, 5, "il resto della config vale");
	assert.deepEqual(res.warnings, []);
	assert.equal(lines.length, 0);
});

// ─── Caso 16b: activation valida ──────────────────────────────────────────

test("activation valida: enabled, mode e milestones parsati (shape condivisa)", () => {
	const filePath = writeCoordination(`activation:
  enabled: true
  mode: per-milestone
  milestones:
    M001:
      enabled: true
    M002:
      enabled: false
`);

	const { value: res, lines } = collectDiscussionArenaStderr(() =>
		loadDiscussionArenaCoordination(filePath),
	);
	assert.deepEqual(res.warnings, [], "file valido → zero warning");
	assert.equal(lines.length, 0, "file valido → zero log");

	const act = res.config.activation;
	assert.ok(act, "activation presente");
	assert.equal(act.enabled, true);
	assert.equal(act.mode, "per-milestone");
	assert.deepEqual(act.milestones, {
		M001: { enabled: true },
		M002: { enabled: false },
	});
});

// ─── Caso 16c: activation chiusa da una chiave top-level successiva ──────

test("activation nel mezzo del file: chiusa da una chiave top-level successiva", () => {
	const filePath = writeCoordination(`roles_virtuals:
  scribe:
    name: scribe
    role: Scribe
    description: desc
    systemPrompt: prompt
activation:
  enabled: false
  mode: availability-only
  milestones:
    M001:
      enabled: true
rounds_default: 5
`);

	const res = loadDiscussionArenaCoordination(filePath);
	assert.ok(res.config.rolesVirtuals["scribe"], "sezione roles precedente preservata");
	const act = res.config.activation;
	assert.ok(act, "activation presente (sezione chiusa dalla chiave top-level)");
	assert.equal(act.enabled, false);
	assert.equal(act.mode, "availability-only");
	assert.deepEqual(act.milestones, { M001: { enabled: true } });
	assert.equal(res.config.roundsDefault, 5, "la chiave top-level successiva viene processata");
	assert.deepEqual(res.warnings, []);
});

// ─── Caso 16d: mode invalido (discard lenient, warning in T02) ────────────

test("activation con mode fuori enum: mode scartato, il resto della sezione vale", () => {
	const filePath = writeCoordination(`activation:
  enabled: true
  mode: on
  milestones:
    M001:
      enabled: true
`);

	const res = loadDiscussionArenaCoordination(filePath);
	const act = res.config.activation;
	assert.ok(act, "activation presente");
	assert.equal(act.mode, undefined, "mode 'on' fuori enum scartato (lenient)");
	assert.equal(act.enabled, true, "gli altri campi della sezione valgono");
	assert.deepEqual(act.milestones, { M001: { enabled: true } });
});

// ─── Caso 16e: milestone ID con trattino e underscore (MID_RE permissivo) ──

test("activation milestone ID con trattino e underscore: entrambi accettati (MID_RE permissivo)", () => {
	const filePath = writeCoordination(`activation:
  milestones:
    M-001:
      enabled: true
    M_002:
      enabled: false
    M.r-1:
      enabled: true
`);

	const res = loadDiscussionArenaCoordination(filePath);
	const act = res.config.activation;
	assert.ok(act, "activation presente");
	assert.deepEqual(act.milestones, {
		"M-001": { enabled: true },
		M_002: { enabled: false },
		"M.r-1": { enabled: true },
	});
	assert.deepEqual(res.warnings, []);
});

// ─── Caso 16f: milestones nested (profondità 4/6) ─────────────────────────

test("activation milestones nested: enabled a profondità 6, più milestone distinte", () => {
	const filePath = writeCoordination(`activation:
  enabled: true
  milestones:
    M001:
      enabled: true
    M003:
      enabled: false
    M007:
      enabled: true
`);

	const res = loadDiscussionArenaCoordination(filePath);
	const act = res.config.activation;
	assert.ok(act, "activation presente");
	assert.equal(act.enabled, true);
	assert.deepEqual(
		Object.keys(act.milestones ?? {}).sort(),
		["M001", "M003", "M007"],
		"ogni milestone ID a profondità 4 produce una entry",
	);
	assert.equal(act.milestones?.["M001"]?.enabled, true);
	assert.equal(act.milestones?.["M003"]?.enabled, false);
	assert.equal(act.milestones?.["M007"]?.enabled, true);
});

// ─── Caso 16g: activation scalare inline (D053 fatale, fail-safe T01) ─────

test("activation con valore scalare inline: D053 generico, config scartata", () => {
	const filePath = writeCoordination(`rounds_default: 5
activation: banana
`);

	const { value: res, lines } = collectDiscussionArenaStderr(() =>
		loadDiscussionArenaCoordination(filePath),
	);
	assert.deepEqual(res.config, { rolesVirtuals: {} }, "config vuota (code defaults)");
	assert.equal(
		res.warnings.at(-1),
		"coordination parse error: activation must be a mapping (got 'banana') — using code defaults",
	);
	assert.equal(lines.length, 1, "log stderr emesso");
	assert.ok(lines[0]!.startsWith("[discussion-arena] "));
});

// ─── Casi T02: validazione runtime mode / milestone ID / enabled ──────────
// La validazione runtime raccoglie i warning D053 sugli scarti del parser
// condiviso (mode vuoto/fuori enum, milestone ID fuori MID_RE, enabled non
// booleano): mai throw, il campo/entry invalido viene scartato e il resto
// della config continua a valere (stessa policy never-throw del loader).

// ─── Caso T02-1: mode fuori enum → warning D053 + scarto ──────────────────

test("activation mode fuori enum: warning D053 + log stderr, mode scartato", () => {
	const filePath = writeCoordination(`activation:
  enabled: true
  mode: on
  milestones:
    M001:
      enabled: true
`);

	const { value: res, lines } = collectDiscussionArenaStderr(() =>
		loadDiscussionArenaCoordination(filePath),
	);
	const act = res.config.activation;
	assert.ok(act, "activation presente");
	assert.equal(act.mode, undefined, "mode 'on' fuori enum scartato");
	assert.equal(act.enabled, true, "il resto della sezione vale");
	assert.deepEqual(act.milestones, { M001: { enabled: true } });
	assert.deepEqual(res.warnings, [
		"activation mode 'on' must be one of per-milestone, always-on, availability-only — skipped",
	]);
	assert.equal(lines.length, 1, "log stderr emesso");
	assert.ok(lines[0]!.startsWith("[discussion-arena] "));
});

// ─── Caso T02-2: mode vuoto → warning D053 ─────────────────────────────────

test("activation mode vuoto: warning D053, mode undefined", () => {
	const filePath = writeCoordination(`activation:
  mode:
  enabled: true
`);

	const { value: res, lines } = collectDiscussionArenaStderr(() =>
		loadDiscussionArenaCoordination(filePath),
	);
	assert.equal(res.config.activation!.mode, undefined, "mode vuoto né valore né enum");
	assert.equal(res.config.activation!.enabled, true, "gli altri campi valgono");
	assert.deepEqual(res.warnings, ["activation mode is empty — skipped"]);
	assert.equal(lines.length, 1, "log stderr emesso");
});

// ─── Caso T02-3: milestone ID permissivi (., _, -) → zero warning ─────────

test("activation mode valido con milestone ID permissivi (M.r-1, M_002): zero warning", () => {
	const filePath = writeCoordination(`activation:
  mode: per-milestone
  milestones:
    M.r-1:
      enabled: true
    M_002:
      enabled: false
`);

	const { value: res, lines } = collectDiscussionArenaStderr(() =>
		loadDiscussionArenaCoordination(filePath),
	);
	const act = res.config.activation;
	assert.ok(act, "activation presente");
	assert.equal(act.mode, "per-milestone");
	assert.deepEqual(act.milestones, {
		"M.r-1": { enabled: true },
		M_002: { enabled: false },
	});
	assert.deepEqual(res.warnings, [], "ID validi → nessun warning");
	assert.equal(lines.length, 0);
});

// ─── Caso T02-4: milestone ID fuori MID_RE → warning + entry scartata ──────

test("activation milestone ID fuori MID_RE (M/r): warning D053, entry scartata", () => {
	const filePath = writeCoordination(`activation:
  milestones:
    M/r:
      enabled: true
    M-001:
      enabled: true
`);

	const { value: res, lines } = collectDiscussionArenaStderr(() =>
		loadDiscussionArenaCoordination(filePath),
	);
	assert.ok(res.config.activation, "activation presente");
	assert.deepEqual(
		res.config.activation!.milestones,
		{ "M-001": { enabled: true } },
		"entry invalida (M/r) scartata, entry valida resta",
	);
	assert.deepEqual(res.warnings, [
		"activation milestone 'M/r' does not match MID_RE — skipped",
	]);
	assert.equal(lines.length, 1, "log stderr emesso");
	assert.ok(lines[0]!.startsWith("[discussion-arena] "));
});

// ─── Caso T02-5: enabled non-boooleano (yes) → warning + non impostato ─────

test("activation milestone con enabled: 'yes' (non bool): warning D053, non impostato", () => {
	const filePath = writeCoordination(`activation:
  milestones:
    M001:
      enabled: yes
`);

	const { value: res, lines } = collectDiscussionArenaStderr(() =>
		loadDiscussionArenaCoordination(filePath),
	);
	assert.ok(res.config.activation, "activation presente");
	assert.deepEqual(
		res.config.activation!.milestones,
		{ M001: {} },
		"enabled 'yes' non booleano non applicato alla milestone",
	);
	assert.deepEqual(res.warnings, [
		"activation enabled must be a boolean (got 'yes') — skipped",
	]);
	assert.equal(lines.length, 1, "log stderr emesso");
	assert.ok(lines[0]!.startsWith("[discussion-arena] "));
});

// ─── Caso T02-6: più milestone con una invalida → solo la invalida scartata ─

test("activation più milestone con una invalida: la invalida scartata, le valide restano", () => {
	const filePath = writeCoordination(`activation:
  enabled: true
  mode: always-on
  milestones:
    M/r:
      enabled: true
    M-001:
      enabled: true
    M_002:
      enabled: false
`);

	const { value: res, lines } = collectDiscussionArenaStderr(() =>
		loadDiscussionArenaCoordination(filePath),
	);
	const act = res.config.activation;
	assert.ok(act, "activation presente");
	assert.equal(act.enabled, true);
	assert.equal(act.mode, "always-on");
	assert.deepEqual(act.milestones, {
		"M-001": { enabled: true },
		M_002: { enabled: false },
	});
	assert.deepEqual(res.warnings, [
		"activation milestone 'M/r' does not match MID_RE — skipped",
	]);
	assert.equal(lines.length, 1, "un solo log stderr per l'entry invalida");
});

// ─── Contratto mai-throw: path che non è un file regolare ─────────────────

test("path su una directory (EISDIR): D053 generico, mai throw", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-discussion-arena-coordination-"));
	track(root);

	const { value: res, lines } = collectDiscussionArenaStderr(() =>
		loadDiscussionArenaCoordination(root),
	);
	assert.deepEqual(res.config, { rolesVirtuals: {} }, "config vuota");
	assert.equal(res.sourcePath, root);
	assert.equal(res.warnings.length, 1, "un warning D053");
	assert.ok(res.warnings[0]!.startsWith("coordination parse error: "));
	assert.equal(lines.length, 1, "log stderr emesso");
});
