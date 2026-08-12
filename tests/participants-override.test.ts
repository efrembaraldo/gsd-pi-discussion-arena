/**
 * Test QA dei 5 casi override del tier 0 (S02/M004, T03).
 *
 * Copertura del QA test plan (round 5) su discoverParticipants:
 *   1. override assente — nessuna dir participants-overrides (walk-up null,
 *                         niente log, result invariato);
 *   2. override valido  — sostituzione TOTALE del file base (source="override",
 *                         filePath = file override, systemPrompt = corpo
 *                         override, non quello della base);
 *   3. override orfano  — override valido senza base (project ∪ user ∪ bundled)
 *                         → throw bloccante con messaggio canonico esatto +
 *                         log "override target ... not found in participants/";
 *   4. header vuoto     — override con frontmatter incompleto: override
 *                         scartato, base preservata con log "using default
 *                         for '<role>' (override skipped: incomplete)" se la
 *                         base esiste, altrimenti log "override skipped:
 *                         incomplete (<role> from <path>)";
 *   5. parse-fail       — file override illeggibile (symlink rotto .md):
 *                         skip silenzioso senza throw né log.
 *
 * In più copre i 4 log stderr distinti richiesti dalla Slice Verification
 * (override applied / using default for incomplete / override skipped
 * incomplete / override target not found), tutti con prefisso canonico
 * [discussion-arena], e il contratto `options.overridesDir` esplicito.
 *
 * Copertura S03 (T02): virtual roles dal coordination file
 * (`roles_virtuals`) risolti come participant di prima classe con source
 * "virtual" (nessun file in participants/), walk-up default ON simmetrico
 * a findNearestOverridesDir, precedenza D052 base < virtual < override
 * (override su virtual non orfano), fallback `model_default` per i
 * participant senza model, e il log canonico
 * `virtual role applied: <role> from <path>`.
 *
 * Tutte le fixture sono sintetiche su tmpdir effimera (pattern
 * participants.test.ts): nessun file di produzione toccato.
 */

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { discoverParticipants } from "../participants.js";
import {
	DISCUSSION_ARENA_COORDINATION_DIR,
	DISCUSSION_ARENA_COORDINATION_FILENAME,
} from "../src/discussion-arena-coordination.js";
import { GSD_AGENT_DIR_ENV } from "./fixtures/pi-coding-agent-stub.js";

/** Scrive un partecipante .md con frontmatter e corpo opzionale. */
function writeParticipant(
	dir: string,
	filename: string,
	opts: {
		name?: string;
		role?: string;
		description?: string;
		model?: string;
		body?: string;
	},
): void {
	const rows: string[] = [];
	if (opts.name !== undefined) rows.push(`name: ${opts.name}`);
	if (opts.role !== undefined) rows.push(`role: ${opts.role}`);
	if (opts.description !== undefined)
		rows.push(`description: ${opts.description}`);
	if (opts.model !== undefined) rows.push(`model: ${opts.model}`);
	fs.writeFileSync(
		path.join(dir, filename),
		`---\n${rows.join("\n")}\n---\n\n${opts.body ?? "System prompt del ruolo."}`,
		"utf-8",
	);
}

/**
 * Scrive un coordination file nella fixture
 * (cwd/.gsd/discussion-arena/discussion-arena-coordination.md) e ritorna il
 * path. Il corpo va dichiarato senza i marcatori `---` (aggiunti qui), come
 * nei test del loader (T01).
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

interface OverrideFixture {
	root: string;
	cwd: string;
	userDir: string;
	baseDir: string | null;
	overridesDir: string | null;
	writeUser(fn: string, opts: Parameters<typeof writeParticipant>[2]): void;
	writeBase(fn: string, opts: Parameters<typeof writeParticipant>[2]): void;
	writeOverride(fn: string, opts: Parameters<typeof writeParticipant>[2]): void;
}

/**
 * Fixture tmp con le dir del tier per-progetto: `cwd` è la root del progetto
 * (`proj`), `baseDir` = proj/.gsd/discussion-arena/participants,
 * `overridesDir` = proj/.gsd/discussion-arena/participants-overrides.
 * Ogni tier è opzionale (caso "override assente": overrides: false).
 */
function makeOverrideFixture(opts: {
	base: boolean;
	overrides: boolean;
}): OverrideFixture {
	const root = fs.mkdtempSync(
		path.join(os.tmpdir(), "gsd-arena-override-"),
	);
	const userDir = path.join(root, "agent", "discussion-arena", "participants");
	fs.mkdirSync(userDir, { recursive: true });

	const cwd = path.join(root, "proj");
	const baseDir = opts.base
		? path.join(cwd, ".gsd", "discussion-arena", "participants")
		: null;
	if (baseDir) fs.mkdirSync(baseDir, { recursive: true });
	const overridesDir = opts.overrides
		? path.join(cwd, ".gsd", "discussion-arena", "participants-overrides")
		: null;
	if (overridesDir) fs.mkdirSync(overridesDir, { recursive: true });

	return {
		root,
		cwd,
		userDir,
		baseDir,
		overridesDir,
		writeUser(fn, wopts) {
			writeParticipant(this.userDir, fn, wopts);
		},
		writeBase(fn, wopts) {
			if (!this.baseDir) throw new Error("fixture senza dir base");
			writeParticipant(this.baseDir!, fn, wopts);
		},
		writeOverride(fn, wopts) {
			if (!this.overridesDir) throw new Error("fixture senza dir override");
			writeParticipant(this.overridesDir!, fn, wopts);
		},
	};
}

const activeFixtures: string[] = [];
function track(root: string): void {
	activeFixtures.push(root);
}

afterEach(() => {
	delete process.env[GSD_AGENT_DIR_ENV];
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
 * (i log di trasparenza di discoverParticipants) e delega/silenzia il resto.
 * Il mock è attivo solo per la durata della chiamata sincrona: il reporter di
 * node:test emette le proprie righe fuori dal corpo del test (pattern
 * event-log.test.ts / arena-loop.test.ts).
 */
function collectArenaStderr<T>(fn: () => T): { value: T; lines: string[] } {
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

/** Esegue `fn` e ritorna l'errore lanciato (o lancia se non lancia nulla). */
function expectThrow(fn: () => void): Error {
	try {
		fn();
	} catch (err) {
		return err instanceof Error ? err : new Error(String(err));
	}
	throw new Error("atteso throw, ma la chiamata è terminata senza errori");
}

// ─── QA caso 1: override assente ───────────────────────────────────────────

test("QA caso 1: nessuna dir participants-overrides -> overridesDir null, nessun log, result invariato", () => {
	const f = makeOverrideFixture({ base: true, overrides: false });
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");

	f.writeBase("analyst.md", {
		name: "analyst",
		role: "Analyst",
		description: "base",
	});

	const { value: res, lines } = collectArenaStderr(() =>
		discoverParticipants(f.cwd, { skipBundled: true }),
	);
	assert.equal(res.overridesDir, null, "walk-up: nessuna dir override trovata");
	assert.deepEqual(res.orphanOverrides, [], "nessun orfano");
	assert.equal(res.participants.length, 1, "base invariata");
	assert.equal(res.participants[0]!.source, "project");
	assert.equal(lines.length, 0, "nessun log [discussion-arena] senza override");
});

test("QA caso 1 (variante opts): overridesDir esplicito inesistente -> overridesDir null, nessun log", () => {
	const f = makeOverrideFixture({ base: true, overrides: false });
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");

	f.writeBase("analyst.md", {
		name: "analyst",
		role: "Analyst",
		description: "base",
	});

	const { value: res, lines } = collectArenaStderr(() =>
		discoverParticipants(f.cwd, {
			skipBundled: true,
			overridesDir: path.join(f.root, "ghost-overrides"),
		}),
	);
	assert.equal(res.overridesDir, null, "path esplicito inesistente -> nessun override");
	assert.deepEqual(res.orphanOverrides, []);
	assert.equal(res.participants.length, 1);
	assert.equal(lines.length, 0);
});

// ─── QA caso 2: override valido (sostituzione totale) ─────────────────────

test("QA caso 2: override valido -> source override, sostituzione totale, log 'override applied'", () => {
	const f = makeOverrideFixture({ base: true, overrides: true });
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");

	f.writeBase("analyst.md", {
		name: "analyst",
		role: "Base Role",
		description: "copia di base",
		body: "system prompt di base (mai usato)",
	});
	f.writeOverride("analyst.md", {
		name: "analyst",
		role: "Override Role",
		description: "copia override",
		body: "system prompt override totale",
	});

	const { value: res, lines } = collectArenaStderr(() =>
		discoverParticipants(f.cwd, { skipBundled: true }),
	);
	const analyst = res.participants.find((p) => p.name === "analyst");
	assert.ok(analyst, "analyst presente");
	assert.equal(analyst!.source, "override");
	assert.equal(analyst!.role, "Override Role");
	assert.equal(
		analyst!.systemPrompt,
		"system prompt override totale",
		"sostituzione totale: il corpo del file override, non quello della base",
	);
	assert.equal(
		analyst!.filePath,
		path.join(f.overridesDir!, "analyst.md"),
		"filePath punta al file override",
	);
	assert.equal(res.overridesDir, f.overridesDir);
	assert.deepEqual(res.orphanOverrides, []);
	assert.ok(
		lines.some((l) =>
			l.includes(
				`[discussion-arena] override applied: analyst from ${f.overridesDir}${path.sep}analyst.md`,
			),
		),
		"log 'override applied' su stderr",
	);
});

test("QA caso 2 (precedenza assoluta): override batte project E user a parità di name", () => {
	const f = makeOverrideFixture({ base: true, overrides: true });
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");

	f.writeUser("analyst.md", {
		name: "analyst",
		role: "User Role",
		description: "user copy",
	});
	f.writeBase("analyst.md", {
		name: "analyst",
		role: "Project Role",
		description: "project copy",
	});
	f.writeOverride("analyst.md", {
		name: "analyst",
		role: "Override Role",
		description: "override copy",
		body: "solo override",
	});

	const res = discoverParticipants(f.cwd, { skipBundled: true });
	const analyst = res.participants.find((p) => p.name === "analyst");
	assert.equal(analyst!.source, "override", "tier 0: precedenza assoluta su project e user");
	assert.equal(analyst!.role, "Override Role");
});

test("QA caso 2 (opts esplicito): overridesDir esplicito fuori dal walk-up viene applicato", () => {
	const f = makeOverrideFixture({ base: true, overrides: false });
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");

	f.writeBase("analyst.md", {
		name: "analyst",
		role: "Base Role",
		description: "base",
	});
	// Dir override in posizione NON raggiungibile dal walk-up da cwd.
	const explicitDir = path.join(f.root, "alt", "overrides");
	fs.mkdirSync(explicitDir, { recursive: true });
	writeParticipant(explicitDir, "analyst.md", {
		name: "analyst",
		role: "Explicit Override",
		description: "override esplicito",
		body: "da dir esplicita",
	});

	const res = discoverParticipants(f.cwd, {
		skipBundled: true,
		overridesDir: explicitDir,
	});
	const analyst = res.participants.find((p) => p.name === "analyst");
	assert.equal(analyst!.source, "override");
	assert.equal(analyst!.role, "Explicit Override");
	assert.equal(res.overridesDir, explicitDir);
});

// ─── QA caso 3: override orfano (throw bloccante) ─────────────────────────

test("QA caso 3: override orfano -> throw con messaggio canonico esatto + log not found", () => {
	const f = makeOverrideFixture({ base: false, overrides: true });
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");

	// Nessuna base (project/user/bundled esclusi via skipBundled e dir vuote):
	// il file override è un orfano.
	f.writeOverride("pippobaudo.md", {
		name: "pippobaudo",
		role: "Ghost",
		description: "senza base",
	});

	const { value: err, lines } = collectArenaStderr(() =>
		expectThrow(() => discoverParticipants(f.cwd, { skipBundled: true })),
	);
	assert.equal(
		err.message,
		"override target 'pippobaudo' not found in participants/ — create participants/pippobaudo.md or remove the override file",
		"messaggio canonico esatto (em-dash e azione correttiva)",
	);
	assert.ok(
		lines.some((l) =>
			l.includes(
				"[discussion-arena] override target 'pippobaudo' not found in participants/",
			),
		),
		"log 'override target not found' su stderr prima del throw",
	);
});

test("QA caso 3 (messaggio): il ruolo di un orfano è interpolato nel throw canonico", () => {
	const f = makeOverrideFixture({ base: false, overrides: true });
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");

	f.writeOverride("uno.md", {
		name: "uno",
		role: "Uno",
		description: "orfano 1",
	});
	f.writeOverride("due.md", {
		name: "due",
		role: "Due",
		description: "orfano 2",
	});

	const err = expectThrow(() =>
		discoverParticipants(f.cwd, { skipBundled: true }),
	);
	// fs.readdirSync non garantisce un ordine: il messaggio deve essere il
	// canonico per UNO degli orfani (mai un ordine specifico).
	const expected = new Set([
		"override target 'uno' not found in participants/ — create participants/uno.md or remove the override file",
		"override target 'due' not found in participants/ — create participants/due.md or remove the override file",
	]);
	assert.ok(
		expected.has(err.message),
		`messaggio canonico per uno degli orfani, got: ${err.message}`,
	);
});

// ─── QA caso 4: header vuoto (frontmatter incompleto) ─────────────────────

test("QA caso 4 (con base): override con header vuoto -> scartato, base preservata, log 'using default'", () => {
	const f = makeOverrideFixture({ base: true, overrides: true });
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");

	f.writeBase("analyst.md", {
		name: "analyst",
		role: "Analyst",
		description: "base",
		body: "System prompt di base.",
	});
	// Header vuoto (---\n---): frontmatter {} -> parseParticipantContent null.
	fs.writeFileSync(
		path.join(f.overridesDir!, "analyst.md"),
		"---\n---\n\nbody override ignorato",
		"utf-8",
	);

	const { value: res, lines } = collectArenaStderr(() =>
		discoverParticipants(f.cwd, { skipBundled: true }),
	);
	const analyst = res.participants.find((p) => p.name === "analyst");
	assert.ok(analyst, "analyst presente");
	assert.equal(
		analyst!.source,
		"project",
		"override scartato: la base resta con la sua source",
	);
	assert.equal(analyst!.systemPrompt, "System prompt di base.");
	assert.deepEqual(res.orphanOverrides, [], "header vuoto non è un orfano");
	assert.ok(
		lines.some((l) =>
			l.includes(
				"[discussion-arena] using default for 'analyst' (override skipped: incomplete)",
			),
		),
		"log 'using default' su stderr",
	);
});

test("QA caso 4 (senza base): override con header vuoto -> log 'override skipped: incomplete', nessun orfano", () => {
	const f = makeOverrideFixture({ base: false, overrides: true });
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");

	fs.writeFileSync(
		path.join(f.overridesDir!, "ghost.md"),
		"---\n---\n\nbody senza frontmatter",
		"utf-8",
	);

	const { value: res, lines } = collectArenaStderr(() =>
		discoverParticipants(f.cwd, { skipBundled: true }),
	);
	assert.ok(
		!res.participants.some((p) => p.name === "ghost"),
		"override incompleto escluso dal risultato",
	);
	assert.deepEqual(res.orphanOverrides, [], "incompleto != orfano: nessun throw");
	assert.ok(
		lines.some((l) =>
			l.includes(
				`[discussion-arena] override skipped: incomplete (ghost from ${f.overridesDir}${path.sep}ghost.md)`,
			),
		),
		"log 'override skipped: incomplete' con ruolo candidato e path",
	);
});

// ─── QA caso 5: parse-fail (file illeggibile) ─────────────────────────────

test("QA caso 5: file override illeggibile (symlink rotto) -> skip silenzioso, nessun log, nessun throw", () => {
	const f = makeOverrideFixture({ base: true, overrides: true });
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");

	f.writeBase("ok.md", {
		name: "ok",
		role: "Ok",
		description: "base valida",
	});
	// Symlink .md verso un target inesistente: readFileSync ENOENT -> skip.
	fs.symlinkSync(
		path.join(f.overridesDir!, "target-inesistente.md"),
		path.join(f.overridesDir!, "rotto.md"),
	);

	const { value: res, lines } = collectArenaStderr(() =>
		discoverParticipants(f.cwd, { skipBundled: true }),
	);
	assert.deepEqual(
		res.participants.map((p) => p.name),
		["ok"],
		"il file illeggibile viene ignorato",
	);
	assert.deepEqual(res.orphanOverrides, []);
	assert.equal(lines.length, 0, "skip silenzioso: nessun log [discussion-arena]");
});

// ─── Contratto result shape (must-have S02) ───────────────────────────────

test("result shape: overridesDir risolto e orphanOverrides [] in successo con override applicato", () => {
	const f = makeOverrideFixture({ base: true, overrides: true });
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");

	f.writeBase("analyst.md", {
		name: "analyst",
		role: "A",
		description: "base",
	});
	f.writeOverride("analyst.md", {
		name: "analyst",
		role: "A'",
		description: "override",
	});

	const res = discoverParticipants(f.cwd, { skipBundled: true });
	assert.equal(res.overridesDir, f.overridesDir);
	assert.deepEqual(res.orphanOverrides, []);
	assert.equal(res.projectParticipantsDir, f.baseDir, "projectParticipantsDir invariato");
});

// ─── S03/T02: coordination file (virtual roles, model_default, precedenza) ─

test("S03/T02: coordination valido -> virtual role come participant di prima classe (source virtual, filePath coordination, log 'virtual role applied')", () => {
	const f = makeOverrideFixture({ base: false, overrides: false });
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");

	const coordinationPath = writeCoordination(f.cwd, `rounds_default: 5
model_default: claude-opus-5
roles_virtuals:
  reviewer:
    name: reviewer
    role: External Reviewer
    description: Revisore esterno con focus su qualita e verificabilita
    systemPrompt: |
      Sei il reviewer esterno del consiglio. Il tuo compito e valutare
      la proposta da una prospettiva indipendente.
`);

	const { value: res, lines } = collectArenaStderr(() =>
		discoverParticipants(f.cwd, {
			skipBundled: true,
			coordinationPath,
		}),
	);
	const reviewer = res.participants.find((p) => p.name === "reviewer");
	assert.ok(reviewer, "reviewer risolto senza alcun file in participants/");
	assert.equal(reviewer!.source, "virtual");
	assert.equal(reviewer!.filePath, coordinationPath);
	assert.equal(reviewer!.role, "External Reviewer");
	assert.equal(
		reviewer!.systemPrompt,
		"Sei il reviewer esterno del consiglio. Il tuo compito e valutare\nla proposta da una prospettiva indipendente.",
		"systemPrompt = corpo del block scalar nel coordination file",
	);
	assert.equal(
		reviewer!.model,
		"claude-opus-5",
		"model_default applicato come fallback anche al virtual role",
	);
	assert.equal(res.coordinationPath, coordinationPath);
	assert.deepEqual(res.coordination, {
		roundsDefault: 5,
		modelDefault: "claude-opus-5",
	});
	assert.equal(
		lines.length,
		1,
		"un solo log [discussion-arena] (loader silenzioso su file valido)",
	);
	assert.equal(
		lines[0],
		`[discussion-arena] virtual role applied: reviewer from ${coordinationPath}\n`,
		"log canonico 'virtual role applied' con path del coordination file",
	);
});

test("S03/T02: coordination file via walk-up (default ON) senza coordinationPath esplicito", () => {
	const f = makeOverrideFixture({ base: false, overrides: false });
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");

	writeCoordination(f.cwd, `roles_virtuals:
  tech_writer:
    name: tech_writer
    role: Technical Writer
    description: Chiarezza della documentazione
    systemPrompt: Sei il technical writer del consiglio.
`);

	const { value: res, lines } = collectArenaStderr(() =>
		discoverParticipants(f.cwd, { skipBundled: true }),
	);
	const tw = res.participants.find((p) => p.name === "tech_writer");
	assert.ok(
		tw,
		"walk-up simmetrico a findNearestOverridesDir trova il coordination file",
	);
	assert.equal(tw!.source, "virtual");
	assert.equal(
		res.coordinationPath,
		path.join(
			f.cwd,
			DISCUSSION_ARENA_COORDINATION_DIR,
			DISCUSSION_ARENA_COORDINATION_FILENAME,
		),
	);
	assert.equal(lines.length, 1, "un solo log: virtual role applied");
	assert.ok(
		lines[0]!.includes("virtual role applied: tech_writer from "),
		"log canonico con nome e path",
	);
});

test("S03/T02: precedenza base < virtual -> il virtual role sovrascrive il base a parità di name", () => {
	const f = makeOverrideFixture({ base: true, overrides: false });
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");

	f.writeBase("reviewer.md", {
		name: "reviewer",
		role: "Base Reviewer",
		description: "base",
	});
	writeCoordination(f.cwd, `roles_virtuals:
  reviewer:
    name: reviewer
    role: Virtual Reviewer
    description: virtual
    systemPrompt: prompt virtual
`);

	const res = discoverParticipants(f.cwd, { skipBundled: true });
	const reviewer = res.participants.find((p) => p.name === "reviewer");
	assert.equal(reviewer!.source, "virtual", "D052: base < virtual");
	assert.equal(reviewer!.role, "Virtual Reviewer");
	assert.equal(
		res.participants.length,
		1,
		"il base 'reviewer' è sostituito, non affiancato",
	);
});

test("S03/T02: precedenza virtual < override -> override su virtual NON orfano e vince (D052)", () => {
	const f = makeOverrideFixture({ base: false, overrides: true });
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");

	writeCoordination(f.cwd, `roles_virtuals:
  reviewer:
    name: reviewer
    role: Virtual Reviewer
    description: virtual
    systemPrompt: prompt virtual
`);
	f.writeOverride("reviewer.md", {
		name: "reviewer",
		role: "Override Reviewer",
		description: "override",
		body: "prompt override",
	});

	const { value: res, lines } = collectArenaStderr(() =>
		discoverParticipants(f.cwd, { skipBundled: true }),
	);
	assert.deepEqual(
		res.orphanOverrides,
		[],
		"override che punta a un virtual non è orfano (il virtual è in baseNames)",
	);
	const reviewer = res.participants.find((p) => p.name === "reviewer");
	assert.equal(reviewer!.source, "override", "D052: virtual < override");
	assert.equal(reviewer!.role, "Override Reviewer");
	assert.equal(reviewer!.systemPrompt, "prompt override");
	assert.equal(
		lines.length,
		2,
		"log 'virtual role applied' + log 'override applied'",
	);
});

test("S03/T02: model_default come fallback solo per i participant senza model esplicito", () => {
	const f = makeOverrideFixture({ base: true, overrides: false });
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");

	f.writeBase("architect.md", {
		name: "architect",
		role: "Architect",
		description: "con model esplicito",
		model: "minimax-m3",
	});
	f.writeBase("dev.md", {
		name: "dev",
		role: "Dev",
		description: "senza model",
	});
	writeCoordination(f.cwd, "model_default: claude-opus-5\n");

	const res = discoverParticipants(f.cwd, { skipBundled: true });
	const architect = res.participants.find((p) => p.name === "architect");
	const dev = res.participants.find((p) => p.name === "dev");
	assert.equal(
		architect!.model,
		"minimax-m3",
		"model esplicito del participant preservato",
	);
	assert.equal(
		dev!.model,
		"claude-opus-5",
		"model_default applicato come fallback",
	);
	assert.equal(res.coordination.modelDefault, "claude-opus-5");
});

test("S03/T02: virtual role con name field diverso dalla chiave dict -> skip con warning, gli altri valgono", () => {
	const f = makeOverrideFixture({ base: false, overrides: false });
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");

	writeCoordination(f.cwd, `roles_virtuals:
  reviewer:
    name: reviewer_x
    role: Reviewer
    description: desc
    systemPrompt: prompt
  qa:
    name: qa
    role: QA
    description: desc
    systemPrompt: prompt
`);

	const { value: res, lines } = collectArenaStderr(() =>
		discoverParticipants(f.cwd, { skipBundled: true }),
	);
	assert.equal(
		res.participants.find((p) => p.name === "reviewer"),
		undefined,
		"chiave 'reviewer' con name mismatch saltata (la chiave del dict è canonica)",
	);
	assert.ok(
		res.participants.find((p) => p.name === "qa"),
		"le altre chiavi valide restano applicate (mai throw)",
	);
	assert.equal(
		lines.length,
		2,
		"2 log: mismatch di 'reviewer' + 'virtual role applied' per la chiave valida 'qa'",
	);
	assert.ok(
		lines[0]!.includes(
			"virtual role 'reviewer' name field mismatch 'reviewer_x' — skipped",
		),
		"warning diagnostico con chiave e name",
	);
	assert.ok(
		lines[1]!.includes("virtual role applied: qa from "),
		"la chiave valida resta applicata e logga 'applied'",
	);
});

test("S03/T02: coordination file assente -> coordinationPath null, coordination {}, nessun virtual, nessun log", () => {
	const f = makeOverrideFixture({ base: true, overrides: false });
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");

	f.writeBase("analyst.md", {
		name: "analyst",
		role: "Analyst",
		description: "base",
	});
	const missing = path.join(
		f.cwd,
		DISCUSSION_ARENA_COORDINATION_DIR,
		DISCUSSION_ARENA_COORDINATION_FILENAME,
	);

	const { value: res, lines } = collectArenaStderr(() =>
		discoverParticipants(f.cwd, {
			skipBundled: true,
			coordinationPath: missing,
		}),
	);
	assert.equal(
		res.coordinationPath,
		null,
		"file inesistente -> nessuna coordination attiva (no-op silenzioso)",
	);
	assert.deepEqual(res.coordination, {});
	assert.deepEqual(
		res.participants.map((p) => p.name),
		["analyst"],
		"base invariata",
	);
	assert.equal(lines.length, 0, "nessun log [discussion-arena]");
});

test("S03/T02: coordination con solo rounds_default -> coordination esposta, nessun virtual, nessun log", () => {
	const f = makeOverrideFixture({ base: false, overrides: false });
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");

	writeCoordination(f.cwd, "rounds_default: 5\n");

	const { value: res, lines } = collectArenaStderr(() =>
		discoverParticipants(f.cwd, { skipBundled: true }),
	);
	assert.equal(
		res.coordinationPath,
		path.join(
			f.cwd,
			DISCUSSION_ARENA_COORDINATION_DIR,
			DISCUSSION_ARENA_COORDINATION_FILENAME,
		),
	);
	assert.deepEqual(res.coordination, { roundsDefault: 5 });
	assert.equal(res.participants.length, 0, "nessun virtual role");
	assert.equal(lines.length, 0, "nessun log: i valori di forma non loggano");
});
