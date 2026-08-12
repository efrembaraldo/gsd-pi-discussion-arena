/**
 * Test CLI di diagnostica partecipanti (S02/M004, T03; scenario virtual S03/T04).
 *
 * Copre i 3 scenari CLI del QA test plan (round 5):
 *   1. no-override        — nessuna dir participants-overrides attiva →
 *                           output canonico `[no overrides active]`, exit 0;
 *   2. single-override    — override valido su una base → elenco post-override
 *                           con `(override)` accanto al file applicato, exit 0;
 *   3. virtual            — coordination file con `roles_virtuals` (S03/T04):
 *                           dump post-discover con il tier `(virtual)` accanto
 *                           a `(override)/(project)/(user)/(bundled)`, sia via
 *                           walk-up sia via `coordinationPath` esplicito; solo
 *                           virtual senza override → elenco, non `[no overrides
 *                           active]`; coordinationPath su file inesistente →
 *                           no-op silenzioso.
 *
 * In più:
 *   - allineamento `padEnd` della colonna `source:` su elenco multi-ruolo;
 *   - contratto `{output, exitCode}` mai-throw di dumpParticipants (orfano →
 *     exitCode 1 con messaggio canonico in output);
 *   - wrapper dumpParticipantsCli: flusso giusto (stdout su successo, stderr
 *     su errore) e process.exit con l'exit code (mock attivo solo durante la
 *     chiamata sincrona — pattern D020, i mock vivono nei test);
 *   - export `main(argv, cwd)` di index.ts (senza toccare activate);
 *   - entry point standalone src/discussion-arena-cli-main.ts invocato come
 *     subprocess `node --import ./tests/ts-esm-loader.mjs` senza gsd-pi attivo
 *     (Integration Closure S02): exit 0 e `[no overrides active]` su stdout.
 *
 * Le fixture sono sintetiche su tmpdir effimera; il subprocess gira nel cwd
 * del repository solo per il loader ESM (process.cwd() per la stub di
 * @gsd/pi-coding-agent) con GSD_AGENT_DIR puntata a una tmp vuota: nessun
 * override attivo nel repo, quindi l'output è deterministico.
 */

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dumpParticipants, dumpParticipantsCli } from "../src/discussion-arena-cli.js";
import { main } from "../index.js";
import { GSD_AGENT_DIR_ENV } from "./fixtures/pi-coding-agent-stub.js";

/** Root del repository (i test girano con cwd = repo, ma calcoliamola comunque). */
const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Scrive un partecipante .md con frontmatter e corpo opzionale. */
function writeParticipant(
	dir: string,
	filename: string,
	opts: {
		name: string;
		role: string;
		description?: string;
		body?: string;
	},
): void {
	const rows = [
		`name: ${opts.name}`,
		`role: ${opts.role}`,
		`description: ${opts.description ?? opts.name}`,
	];
	fs.writeFileSync(
		path.join(dir, filename),
		`---\n${rows.join("\n")}\n---\n\n${opts.body ?? "System prompt del ruolo."}`,
		"utf-8",
	);
}

/** Scrive un coordination file valido con rounds_default/model_default/roles_virtuals. */
function writeCoordination(
	dir: string,
	opts: {
		roundsDefault?: number;
		modelDefault?: string;
		virtuals?: Array<{
			key: string;
			name: string;
			role: string;
			description: string;
			systemPrompt: string;
		}>;
	},
): string {
	const rows = ["---"];
	if (opts.roundsDefault !== undefined) {
		rows.push(`rounds_default: ${opts.roundsDefault}`);
	}
	if (opts.modelDefault !== undefined) {
		rows.push(`model_default: ${opts.modelDefault}`);
	}
	if (opts.virtuals && opts.virtuals.length > 0) {
		rows.push("roles_virtuals:");
		for (const v of opts.virtuals) {
			rows.push(`  ${v.key}:`);
			rows.push(`    name: ${v.name}`);
			rows.push(`    role: ${v.role}`);
			rows.push(`    description: ${v.description}`);
			rows.push("    systemPrompt: |");
			for (const line of v.systemPrompt.split("\n")) {
				rows.push(`      ${line}`);
			}
		}
	}
	rows.push("---");
	const filePath = path.join(dir, "discussion-arena-coordination.md");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(filePath, rows.join("\n") + "\n", "utf-8");
	return filePath;
}

interface CliFixture {
	root: string;
	cwd: string;
	userDir: string;
	baseDir: string;
	overridesDir: string;
	writeBase(fn: string, opts: Parameters<typeof writeParticipant>[2]): void;
	writeOverride(fn: string, opts: Parameters<typeof writeParticipant>[2]): void;
}

/**
 * Fixture tmp con tier base + override per-progetto (cwd = root progetto):
 * il walk-up da `cwd` trova `.gsd/discussion-arena/participants-overrides`.
 */
function makeCliFixture(): CliFixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-discussion-arena-cli-"));
	const userDir = path.join(root, "agent", "discussion-arena", "participants");
	fs.mkdirSync(userDir, { recursive: true });

	const cwd = path.join(root, "proj");
	const baseDir = path.join(cwd, ".gsd", "discussion-arena", "participants");
	const overridesDir = path.join(
		cwd,
		".gsd",
		"discussion-arena",
		"participants-overrides",
	);
	fs.mkdirSync(baseDir, { recursive: true });
	fs.mkdirSync(overridesDir, { recursive: true });

	return {
		root,
		cwd,
		userDir,
		baseDir,
		overridesDir,
		writeBase(fn, opts) {
			writeParticipant(this.baseDir, fn, opts);
		},
		writeOverride(fn, opts) {
			writeParticipant(this.overridesDir, fn, opts);
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
 * Mock di stdout/stderr/process.exit attivo SOLO durante `fn` (chiamata
 * sincrona): cattura l'output del CLI e l'exit code senza uccidere il runner
 * (pattern D020 — i mock vivono nei test). Il reporter di node:test emette
 * le proprie righe fuori dal corpo del test, quindi non viene toccato.
 */
function withCliMock<T>(fn: () => T): {
	value: T;
	stdout: string;
	stderr: string;
	exits: (number | undefined)[];
} {
	const origStdout = process.stdout.write.bind(process.stdout);
	const origStderr = process.stderr.write.bind(process.stderr);
	const origExit = process.exit;
	const stdoutChunks: string[] = [];
	const stderrChunks: string[] = [];
	const exits: (number | undefined)[] = [];

	process.stdout.write = ((chunk: unknown) => {
		stdoutChunks.push(String(chunk));
		return true;
	}) as unknown as typeof process.stdout.write;
	process.stderr.write = ((chunk: unknown) => {
		stderrChunks.push(String(chunk));
		return true;
	}) as unknown as typeof process.stderr.write;
	process.exit = ((code?: number) => {
		exits.push(code);
	}) as unknown as typeof process.exit;

	try {
		const value = fn();
		return { value, stdout: stdoutChunks.join(""), stderr: stderrChunks.join(""), exits };
	} finally {
		process.stdout.write = origStdout;
		process.stderr.write = origStderr;
		process.exit = origExit;
	}
}

// ─── Scenario CLI 1: no-override ──────────────────────────────────────────

test("CLI scenario 1: nessun override attivo -> output canonico '[no overrides active]', exit 0", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-discussion-arena-cli-none-"));
	track(tmp);
	const cwd = path.join(tmp, "nested", "cwd");
	fs.mkdirSync(cwd, { recursive: true });
	process.env[GSD_AGENT_DIR_ENV] = path.join(tmp, "ghost-agent");

	const res = dumpParticipants(cwd, { skipBundled: true });
	assert.equal(res.exitCode, 0);
	assert.equal(res.output, "[no overrides active]\n");
});

test("CLI scenario 1 (con base senza override): override assente -> '[no overrides active]'", () => {
	const f = makeCliFixture();
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");
	// Base presente ma nessun override attivo: la dir override esiste ma è
	// vuota -> la discovery applica zero override.
	f.writeBase("analyst.md", {
		name: "analyst",
		role: "Analyst",
		description: "base",
	});

	const res = dumpParticipants(f.cwd, { skipBundled: true });
	assert.equal(res.exitCode, 0);
	assert.equal(res.output, "[no overrides active]\n");
});

// ─── Scenario CLI 2: single-override ──────────────────────────────────────

test("CLI scenario 2: override valido -> elenco con '(override)' e path del file override, exit 0", () => {
	const f = makeCliFixture();
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");

	f.writeBase("analyst.md", {
		name: "analyst",
		role: "Base Role",
		description: "base",
	});
	f.writeOverride("analyst.md", {
		name: "analyst",
		role: "Override Role",
		description: "override",
		body: "system prompt override",
	});

	const res = dumpParticipants(f.cwd, { skipBundled: true });
	assert.equal(res.exitCode, 0);
	assert.match(
		res.output,
		/^analyst\s+source: \.gsd\/discussion-arena\/participants-overrides\/analyst\.md \(override\)$/m,
		"una riga per il ruolo con source (override) e path relativo al cwd",
	);
});

test("CLI scenario 2 (multi-ruolo): colonna 'source:' allineata con padEnd, sorgenti miste", () => {
	const f = makeCliFixture();
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");

	f.writeBase("analyst.md", {
		name: "analyst",
		role: "A",
		description: "base analyst",
	});
	f.writeBase("dev.md", {
		name: "dev",
		role: "D",
		description: "base dev",
	});
	f.writeOverride("analyst.md", {
		name: "analyst",
		role: "A'",
		description: "override analyst",
	});

	const res = dumpParticipants(f.cwd, { skipBundled: true });
	assert.equal(res.exitCode, 0);
	const rows = res.output.trim().split("\n");
	assert.equal(rows.length, 2, "analyst (override) + dev (project), ordine alfabetico");
	assert.match(rows[0]!, /^analyst\s+source: .+ \(override\)$/);
	assert.match(rows[1]!, /^dev\s+source: .+ \(project\)$/);
	// Allineamento padEnd: la colonna 'source:' parte alla stessa posizione.
	const cols = rows.map((r) => r.indexOf("source:"));
	assert.equal(cols[0], cols[1], "colonna source: allineata (padEnd su name)");
});

// ─── Scenario CLI 3: virtual (S03/T04, backward-compat) ──────────────────

test("CLI scenario 3: coordination file con roles_virtuals -> dump mostra il tier (virtual)", () => {
	const f = makeCliFixture();
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");

	f.writeBase("analyst.md", {
		name: "analyst",
		role: "Analyst",
		description: "base",
	});
	f.writeOverride("analyst.md", {
		name: "analyst",
		role: "Override",
		description: "override",
	});
	// Base NON sovrascritta: resta visibile come (project) accanto a
	// (override) e (virtual) — i tre tier coesistono nello stesso dump.
	f.writeBase("dev.md", {
		name: "dev",
		role: "Dev",
		description: "base dev",
	});

	// Coordination file nel percorso canonico: la walk-up da cwd lo trova da
	// sola (nessun coordinationPath esplicito nel primo dump).
	const coordinationPath = writeCoordination(
		path.join(f.cwd, ".gsd", "discussion-arena"),
		{
			roundsDefault: 3,
			virtuals: [
				{
					key: "skeptic",
					name: "skeptic",
					role: "Skeptic",
					description: "Contesta le assunzioni",
					systemPrompt: "Sei lo scettico del gruppo.",
				},
			],
		},
	);

	const res = dumpParticipants(f.cwd, { skipBundled: true });
	assert.equal(res.exitCode, 0);
	assert.match(
		res.output,
		/^skeptic\s+source: \.gsd\/discussion-arena\/discussion-arena-coordination\.md \(virtual\)$/m,
		"il virtual role appare come riga con source (virtual) e path del coordination file",
	);
	assert.match(res.output, /\(override\)/, "gli override continuano a essere listati");
	assert.match(res.output, /\(project\)/, "le basi non sovrascritte continuano a essere listate");
	const rows = res.output.trim().split("\n");
	assert.equal(rows.length, 3, "override + project + virtual, ordine alfabetico");
	// Allineamento padEnd con il virtual presente: la colonna 'source:' parte
	// alla stessa posizione su tutte e tre le righe.
	const cols = rows.map((r) => r.indexOf("source:"));
	assert.equal(cols[0], cols[1], "colonna source: allineata (analyst vs dev)");
	assert.equal(cols[1], cols[2], "colonna source: allineata (dev vs skeptic)");

	// Il coordinationPath esplicito (stesso file) produce lo stesso dump del
	// walk-up: l'opzione resta valida per i consumer programmatici.
	const explicit = dumpParticipants(f.cwd, {
		skipBundled: true,
		coordinationPath,
	});
	assert.equal(explicit.exitCode, 0);
	assert.equal(
		explicit.output,
		res.output,
		"coordinationPath esplicito e walk-up coincidono",
	);
});

test("CLI scenario 3 (solo virtual): coordination file senza override -> elenco virtual, non '[no overrides active]'", () => {
	const f = makeCliFixture();
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");

	// Nessun override: la dir override esiste ma è vuota. S02 avrebbe
	// risposto '[no overrides active]'; S03/T04 lista i virtual roles.
	writeCoordination(path.join(f.cwd, ".gsd", "discussion-arena"), {
		virtuals: [
			{
				key: "skeptic",
				name: "skeptic",
				role: "Skeptic",
				description: "Contesta le assunzioni",
				systemPrompt: "Sei lo scettico del gruppo.",
			},
		],
	});

	const res = dumpParticipants(f.cwd, { skipBundled: true });
	assert.equal(res.exitCode, 0);
	assert.notEqual(
		res.output,
		"[no overrides active]\n",
		"i virtual roles attivi rendono il dump informativo anche senza override",
	);
	assert.match(
		res.output,
		/^skeptic\s+source: \.gsd\/discussion-arena\/discussion-arena-coordination\.md \(virtual\)$/m,
	);
});

test("CLI scenario 3 (coordinationPath inesistente): no-op silenzioso -> '[no overrides active]'", () => {
	const f = makeCliFixture();
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");

	const res = dumpParticipants(f.cwd, {
		skipBundled: true,
		coordinationPath: path.join(
			f.cwd,
			".gsd",
			"discussion-arena",
			"discussion-arena-coordination.md",
		),
	});
	assert.equal(res.exitCode, 0);
	assert.equal(
		res.output,
		"[no overrides active]\n",
		"coordinationPath su file assente = ENOENT no-op silenzioso (mai throw)",
	);
});

// ─── Contratto {output, exitCode} mai-throw ───────────────────────────────

test("dumpParticipants: override orfano -> exitCode 1 e messaggio canonico in output, MAI throw", () => {
	const f = makeCliFixture();
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");

	// Nessuna base: override valido senza target -> orfano.
	f.writeOverride("pippobaudo.md", {
		name: "pippobaudo",
		role: "Ghost",
		description: "senza base",
	});

	const res = dumpParticipants(f.cwd, { skipBundled: true });
	assert.equal(res.exitCode, 1, "l'orfano è un errore di configurazione, exit 1");
	assert.equal(
		res.output,
		"[discussion-arena] override target 'pippobaudo' not found in participants/ — create participants/pippobaudo.md or remove the override file\n",
	);
});

// ─── Wrapper side-effect: dumpParticipantsCli ─────────────────────────────

test("dumpParticipantsCli: senza flag -> no-op (0), nessun write, nessun process.exit", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-discussion-arena-cli-nop-"));
	track(tmp);

	const { value, stdout, stderr, exits } = withCliMock(() =>
		dumpParticipantsCli([], tmp),
	);
	assert.equal(value, 0);
	assert.equal(stdout, "", "nessun output su stdout");
	assert.equal(stderr, "", "nessun output su stderr");
	assert.deepEqual(exits, [], "nessun process.exit senza flag");
});

test("dumpParticipantsCli: --dump-participants su scenario no-override -> stdout + process.exit(0)", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-discussion-arena-cli-ok-"));
	track(tmp);
	const cwd = path.join(tmp, "cwd");
	fs.mkdirSync(cwd, { recursive: true });
	process.env[GSD_AGENT_DIR_ENV] = path.join(tmp, "ghost-agent");

	const { value, stdout, stderr, exits } = withCliMock(() =>
		dumpParticipantsCli(["--dump-participants"], cwd),
	);
	assert.equal(value, 0);
	assert.equal(stdout, "[no overrides active]\n", "output su stdout (successo)");
	assert.equal(stderr, "", "niente su stderr in successo");
	assert.deepEqual(exits, [0], "process.exit(0)");
});

test("dumpParticipantsCli: override orfano -> output su stderr + process.exit(1)", () => {
	const f = makeCliFixture();
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");

	f.writeOverride("pippobaudo.md", {
		name: "pippobaudo",
		role: "Ghost",
		description: "senza base",
	});

	const { value, stdout, stderr, exits } = withCliMock(() =>
		dumpParticipantsCli(["--dump-participants"], f.cwd),
	);
	assert.equal(value, 1);
	assert.equal(stdout, "", "niente su stdout in errore");
	assert.match(
		stderr,
		/^\[discussion-arena\] override target 'pippobaudo' not found in participants\/ — /,
		"messaggio di errore su stderr",
	);
	assert.deepEqual(exits, [1], "process.exit(1)");
});

// ─── Export main di index.ts ──────────────────────────────────────────────

test("index.ts export main: --dump-participants delega al CLI senza toccare activate", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-discussion-arena-cli-main-"));
	track(tmp);
	const cwd = path.join(tmp, "cwd");
	fs.mkdirSync(cwd, { recursive: true });
	process.env[GSD_AGENT_DIR_ENV] = path.join(tmp, "ghost-agent");

	const { value, stdout, exits } = withCliMock(() =>
		main(["--dump-participants"], cwd),
	);
	assert.equal(value, 0, "main ritorna l'exit code");
	assert.equal(stdout, "[no overrides active]\n");
	assert.deepEqual(exits, [0], "main fa transitare il process.exit del CLI");
});

// ─── Entry point standalone (subprocess, senza gsd-pi) ────────────────────

test("entry point standalone: node --import loader src/discussion-arena-cli-main.ts --dump-participants esce 0 (no override)", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-discussion-arena-cli-sub-"));
	track(tmp);

	// Il loader ESM usa process.cwd() per trovare la stub di
	// @gsd/pi-coding-agent: il subprocess deve girare dalla root del repo.
	// GSD_AGENT_DIR -> tmp vuota isola il tier user; il repo non ha dir
	// participants-overrides attive (verificato: solo .gsd/discussion-arena/
	// transcripts), quindi l'output è deterministico.
	const res = spawnSync(
		process.execPath,
		[
			"--import",
			"./tests/ts-esm-loader.mjs",
			"src/discussion-arena-cli-main.ts",
			"--dump-participants",
		],
		{
			cwd: PROJECT_ROOT,
			env: { ...process.env, GSD_AGENT_DIR: path.join(tmp, "ghost-agent") },
			encoding: "utf-8",
			timeout: 60_000,
		},
	);

	assert.equal(
		res.status,
		0,
		`exit 0 atteso per scenario no-override (stderr: ${res.stderr})`,
	);
	assert.equal(res.stdout, "[no overrides active]\n", "output canonico su stdout");
	assert.equal(res.stderr, "", "nessun output su stderr in successo");
});
