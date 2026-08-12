/**
 * Test unitari di discoverParticipants (participants.ts).
 *
 * Coprono il contracts M001/S03:
 *   - precedenza project (>user) a parità di `name`;
 *   - symlink valido scoperto;
 *   - symlink rotto (file irraggiungibile) saltato senza throw;
 *   - file con frontmatter incompleto (manca name/description/role) saltato;
 *   - dir inesistenti gestite (risultato vuoto, non error).
 *
 * Test dedicati per la sorgente "bundled" (esempi dal package), verificano
 * che `discoverParticipants` la includa per default (l'utente che installa
 * l'estensione deve trovare la funzionalità pronta) e la escluda con
 * `{ skipBundled: true }` (utile in test isolati che non vogliono mischiare
 * i partecipanti di esempio con le proprie fixture).
 *
 * Tutte le fixture sono sintetiche, create in una tmpdir effimera via
 * fs.mkdtempSync e rimosse in afterEach: nessun file di produzione toccato,
 * nessun dato reale (M001: fixture sintetiche, nessun PII/secret).
 */

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { discoverParticipants } from "../participants.js";
import { GSD_AGENT_DIR_ENV } from "./fixtures/pi-coding-agent-stub.js";

/** Funzione pura su cui scrivere i fixture .md con frontmatter. */
function writeParticipant(
	dir: string,
	filename: string,
	opts: {
		name?: string;
		role?: string;
		description?: string;
		model?: string;
		tools?: string[];
		body?: string;
		// I 5 campi limits (snake_case, S02/M003) — valori grezzi come li
		// scriverebbe un utente nel frontmatter .md.
		round_timeout_ms?: string | number;
		event_timeout_ms?: string | number;
		output_limit_chars?: string | number;
		cost_budget_usd?: string | number;
		termination?: string;
	},
): void {
	const rows: string[] = [];
	if (opts.name !== undefined) rows.push(`name: ${opts.name}`);
	if (opts.role !== undefined) rows.push(`role: ${opts.role}`);
	if (opts.description !== undefined)
		rows.push(`description: ${opts.description}`);
	if (opts.model !== undefined) rows.push(`model: ${opts.model}`);
	if (opts.tools !== undefined) rows.push(`tools: [${opts.tools.join(", ")}]`);
	if (opts.round_timeout_ms !== undefined)
		rows.push(`round_timeout_ms: ${opts.round_timeout_ms}`);
	if (opts.event_timeout_ms !== undefined)
		rows.push(`event_timeout_ms: ${opts.event_timeout_ms}`);
	if (opts.output_limit_chars !== undefined)
		rows.push(`output_limit_chars: ${opts.output_limit_chars}`);
	if (opts.cost_budget_usd !== undefined)
		rows.push(`cost_budget_usd: ${opts.cost_budget_usd}`);
	if (opts.termination !== undefined)
		rows.push(`termination: ${opts.termination}`);
	const body = opts.body ?? "System prompt del ruolo.";
	fs.writeFileSync(
		path.join(dir, filename),
		`---\n${rows.join("\n")}\n---\n\n${body}`,
		"utf-8",
	);
}

/** Costruisce una fixture tmp con dir utente (.gsd/agent/discussion-arena/participants default della stub) e opzionalmente dir progetto (cwd/.gsd/discussion-arena/participants). */
interface Fixture {
	root: string;
	userDir: string;
	projectDir: string | null;
	writeUser(fn: string, opts: Parameters<typeof writeParticipant>[2]): void;
	writeProject(fn: string, opts: Parameters<typeof writeParticipant>[2]): void;
}

function makeFixture(project: boolean): Fixture {
	const root = fs.mkdtempSync(
		path.join(os.tmpdir(), "gsd-pi-discussion-arena-participants-"),
	);
	// La stub getAgentDir() legge process.env.GSD_AGENT_DIR; puntiamola alla
	// dir utente della fixture.
	const userDir = path.join(root, "agent", "discussion-arena", "participants");
	fs.mkdirSync(userDir, { recursive: true });

	const projectDir = project
		? path.join(root, "proj", ".gsd", "discussion-arena", "participants")
		: null;
	if (projectDir) fs.mkdirSync(projectDir, { recursive: true });

	return {
		root,
		userDir,
		projectDir,
		writeUser(fn, opts) {
			writeParticipant(this.userDir, fn, opts);
		},
		writeProject(fn, opts) {
			if (!this.projectDir) throw new Error("fixture senza dir progetto");
			writeParticipant(this.projectDir!, fn, opts);
		},
	};
}

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

test("precedenza project>user: a parità di name vince il partecipante di progetto", () => {
	const f = makeFixture(true);
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");

	// Stesso nome in user e project, ruoli diversi.
	f.writeUser("architect.md", {
		name: "architect",
		role: "User Role",
		description: "user copy",
	});
	f.writeProject("architect.md", {
		name: "architect",
		role: "Project Role",
		description: "project copy",
	});

	// Il cwd è la root del progetto (`proj`): `findNearestProjectParticipantsDir`
	// cerca `.gsd/discussion-arena/participants` procedendo verso l'alto, quindi il
	// cwd reale è proprio la cartella che contiene quella dir (la root git).
	// Un cwd fratello (es. root/cwd o proj/cwd) non ne è antenato, quindi la
	// dir progetto non verrebbe mai scoperta (vedi regressione fixata in T03).
	const cwd = path.join(f.root, "proj");
	const result = discoverParticipants(cwd, { skipBundled: true });

	assert.equal(
		result.participants.length,
		1,
		"un solo partecipante dopo la precedenza",
	);
	const p = result.participants[0]!;
	assert.equal(p.name, "architect");
	assert.equal(p.source, "project", "il progetto sovrascrive l'utente");
	assert.equal(p.role, "Project Role");
	assert.equal(
		result.projectParticipantsDir,
		path.join(f.root, "proj", ".gsd", "discussion-arena", "participants"),
	);

	delete process.env[GSD_AGENT_DIR_ENV];
});

test("i partecipanti user (senza omonimo project) restano inclusi e con source user", () => {
	const f = makeFixture(true);
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");

	f.writeUser("pm.md", { name: "pm", role: "PM", description: "user-only" });
	f.writeProject("dev.md", {
		name: "dev",
		role: "Dev",
		description: "project-only",
	});

	const cwd = path.join(f.root, "proj");
	const res = discoverParticipants(cwd, { skipBundled: true });
	const names = res.participants.map((p) => p.name).sort();
	assert.deepEqual(names, ["dev", "pm"]);
	const pm = res.participants.find((p) => p.name === "pm");
	assert.equal(pm?.source, "user");

	delete process.env[GSD_AGENT_DIR_ENV];
});

test("symlink valido verso un file .md esistente viene scoperto", () => {
	const f = makeFixture(false);
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");

	// Target esterno alla dir participants (non passa dal discovery diretto,
	// ma è il resolution target del symlink).
	const targetDir = path.join(f.root, "targets");
	fs.mkdirSync(targetDir, { recursive: true });
	const realPath = path.join(targetDir, "real.md");
	fs.writeFileSync(
		realPath,
		"---\nname: linked\nrole: Linked Role\ndescription: via symlink\n---\n\ncorpo\n",
		"utf-8",
	);
	fs.symlinkSync(realPath, path.join(f.userDir, "linked.md"));

	const res = discoverParticipants(path.join(f.root, "cwd"), {
		skipBundled: true,
	});
	const linked = res.participants.find((p) => p.name === "linked");
	assert.ok(linked, "il symlink valido deve essere scoperto");
	assert.equal(linked.source, "user");

	delete process.env[GSD_AGENT_DIR_ENV];
});

test("symlink rotto (target inesistente) viene saltato senza throw", () => {
	const f = makeFixture(false);
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");

	f.writeUser("ok.md", { name: "ok", role: "Ok", description: "valido" });
	// symlink verso un target che non esiste.
	fs.symlinkSync(
		path.join(f.root, "agent", "discussion-arena", "participants", "does-not-exist.md"),
		path.join(f.userDir, "broken.md"),
	);

	assert.doesNotThrow(() => {
		const res = discoverParticipants(path.join(f.root, "cwd"), {
			skipBundled: true,
		});
		const names = res.participants.map((p) => p.name);
		assert.deepEqual(
			names,
			["ok"],
			"il symlink rotto viene ignorato, senza error",
		);
	});

	delete process.env[GSD_AGENT_DIR_ENV];
});

test("file con frontmatter incompleto (manca role) viene saltato", () => {
	const f = makeFixture(false);
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");

	f.writeUser("no-role.md", { name: "no-role", description: "manca role" });
	f.writeUser("complete.md", {
		name: "complete",
		role: "R",
		description: "ok",
	});

	const res = discoverParticipants(path.join(f.root, "cwd"), {
		skipBundled: true,
	});
	const names = res.participants.map((p) => p.name);
	assert.deepEqual(
		names,
		["complete"],
		"i file con frontmatter incompleto vengono saltati",
	);

	delete process.env[GSD_AGENT_DIR_ENV];
});

test("file con frontmatter incompleto per name mancante viene saltato", () => {
	const f = makeFixture(false);
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");

	f.writeUser("noname.md", { role: "R", description: "manca name" });
	f.writeUser("ok.md", { name: "ok", role: "R", description: "ok" });

	const res = discoverParticipants(path.join(f.root, "cwd"), {
		skipBundled: true,
	});
	assert.deepEqual(
		res.participants.map((p) => p.name),
		["ok"],
	);
	delete process.env[GSD_AGENT_DIR_ENV];
});

test("file con frontmatter incompleto per manca description viene saltato", () => {
	const f = makeFixture(false);
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");

	f.writeUser("nodesc.md", { name: "nodesc", role: "R" });
	f.writeUser("ok.md", { name: "ok", role: "R", description: "ok" });

	const res = discoverParticipants(path.join(f.root, "cwd"), {
		skipBundled: true,
	});
	assert.deepEqual(
		res.participants.map((p) => p.name),
		["ok"],
	);
	delete process.env[GSD_AGENT_DIR_ENV];
});

test("file non .md viene ignorato", () => {
	const f = makeFixture(false);
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");

	fs.writeFileSync(
		path.join(f.userDir, "readme.txt"),
		"non un partecipante",
		"utf-8",
	);
	f.writeUser("ok.md", { name: "ok", role: "R", description: "ok" });

	const res = discoverParticipants(path.join(f.root, "cwd"), {
		skipBundled: true,
	});
	assert.deepEqual(
		res.participants.map((p) => p.name),
		["ok"],
	);
	delete process.env[GSD_AGENT_DIR_ENV];
});

test("dir utente e progetto inesistenti -> partecipanti vuoti e projectDir null, senza error", () => {
	// Nessuna fixture user: process.env puntato a una dir inesistente.
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-discussion-arena-empty-"));
	track(tmp);
	process.env[GSD_AGENT_DIR_ENV] = path.join(tmp, "ghost-agent");

	const cwd = path.join(tmp, "nested", "cwd");
	fs.mkdirSync(cwd, { recursive: true });
	const res = discoverParticipants(cwd, { skipBundled: true });
	assert.equal(res.participants.length, 0);
	assert.equal(res.projectParticipantsDir, null);
	delete process.env[GSD_AGENT_DIR_ENV];
});

test("tools opzionali e model vengono mappati sul ParticipantConfig", () => {
	const f = makeFixture(true);
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");

	f.writeProject("architect.md", {
		name: "architect",
		role: "Bus Analyst",
		description: "analista",
		model: "claude-sonnet-5",
		tools: ["read", "grep", "find"],
	});

	const cwd = path.join(f.root, "proj");
	const res = discoverParticipants(cwd, { skipBundled: true });
	const p = res.participants[0]!;
	assert.equal(p.model, "claude-sonnet-5");
	assert.deepEqual(p.tools, ["read", "grep", "find"]);
	assert.equal(p.systemPrompt, "System prompt del ruolo.");
	assert.ok(p.filePath.startsWith(cwd));
	delete process.env[GSD_AGENT_DIR_ENV];
});

// ─── limits dal frontmatter (S02/M003, T01) ────────────────────────────────
// Copertura del contratto S02: i 5 campi snake_case del frontmatter popolano
// ParticipantConfig.limits (ParticipantLimitsInput). Nessuna validazione qui
// — è responsabilità di resolveParticipantLimits (helpers.ts, consumato da
// index.ts in T02) — quindi i test verificano solo che il valore grezzo letto
// dal frontmatter raggiunga il campo camelCase corrispondente, non che sia
// "corretto" o convertito a number.

test("frontmatter cost_budget_usd e round_timeout_ms popolano ParticipantConfig.limits", () => {
	const f = makeFixture(false);
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");

	f.writeUser("budget-aware.md", {
		name: "budget-aware",
		role: "Budget Aware",
		description: "partecipante con limiti custom",
		cost_budget_usd: 0.05,
		round_timeout_ms: 10000,
	});

	const res = discoverParticipants(path.join(f.root, "cwd"), {
		skipBundled: true,
	});
	const p = res.participants.find((x) => x.name === "budget-aware");
	assert.ok(p, "il partecipante deve essere scoperto");
	assert.equal(p!.limits.costBudgetUsd, "0.05");
	assert.equal(p!.limits.roundTimeoutMs, "10000");
	// I campi assenti dal frontmatter restano undefined (nessun fallback qui:
	// il fallback ai default è responsabilità di resolveParticipantLimits).
	assert.equal(p!.limits.eventTimeoutMs, undefined);
	assert.equal(p!.limits.outputLimitChars, undefined);
	assert.equal(p!.limits.termination, undefined);

	delete process.env[GSD_AGENT_DIR_ENV];
});

test("tutti e 5 i campi limits nel frontmatter vengono letti in ParticipantConfig.limits", () => {
	const f = makeFixture(false);
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");

	f.writeUser("full-limits.md", {
		name: "full-limits",
		role: "Full Limits",
		description: "tutti i 5 campi impostati",
		round_timeout_ms: 120000,
		event_timeout_ms: 30000,
		output_limit_chars: 8000,
		cost_budget_usd: 0.25,
		termination: "hard",
	});

	const res = discoverParticipants(path.join(f.root, "cwd"), {
		skipBundled: true,
	});
	const p = res.participants.find((x) => x.name === "full-limits");
	assert.ok(p, "il partecipante deve essere scoperto");
	assert.deepEqual(p!.limits, {
		roundTimeoutMs: "120000",
		eventTimeoutMs: "30000",
		outputLimitChars: "8000",
		costBudgetUsd: "0.25",
		termination: "hard",
	});

	delete process.env[GSD_AGENT_DIR_ENV];
});

test("frontmatter senza campi limits produce ParticipantConfig.limits vuoto (non undefined)", () => {
	const f = makeFixture(false);
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");

	f.writeUser("no-limits.md", {
		name: "no-limits",
		role: "No Limits",
		description: "nessun campo limite nel frontmatter",
	});

	const res = discoverParticipants(path.join(f.root, "cwd"), {
		skipBundled: true,
	});
	const p = res.participants.find((x) => x.name === "no-limits");
	assert.ok(p, "il partecipante deve essere scoperto");
	assert.deepEqual(p!.limits, {}, "nessun campo limite -> oggetto vuoto");

	delete process.env[GSD_AGENT_DIR_ENV];
});

// ─── Bundled discovery ────────────────────────────────────────────────────
// I test sopra usano `skipBundled: true` per isolare le fixture dal contenuto
// reale del package. I test seguenti verificano che i partecipanti bundled
// dell'estensione vengano effettivamente esposti all'utente finale dopo
// l'install, in modo che la discussion arena sia utilizzabile out-of-the-box.

test("i partecipanti bundled dell'estensione vengono scoperti di default", () => {
	// Il modulo participants.ts viene caricato dal sorgente del progetto
	// (…/gsd-pi-discussion-arena/participants.ts) sotto il test loader, quindi
	// la directory `participants/` accanto ad esso contiene i 4 .md di esempio
	// (analyst/architect/dev/qa) — che sono anche ciò che viene pacchettizzato.
	const cwd = path.join(os.tmpdir(), "gsd-discussion-arena-bundled-default");
	process.env[GSD_AGENT_DIR_ENV] = path.join(os.tmpdir(), "gsd-discussion-arena-no-user");

	const res = discoverParticipants(cwd);
	assert.ok(
		res.participants.length >= 4,
		`almeno 4 partecipanti bundled, trovati ${res.participants.length}`,
	);

	const names = res.participants.map((p) => p.name).sort();
	for (const expected of ["analyst", "architect", "dev", "qa"]) {
		assert.ok(
			names.includes(expected),
			`${expected} deve essere presente come bundled`,
		);
	}
	const someBundled = res.participants.find((p) => p.source === "bundled");
	assert.ok(someBundled, "almeno un partecipante source='bundled'");

	delete process.env[GSD_AGENT_DIR_ENV];
});

test("user overrides bundled a parità di name (stessa regola project > user > bundled)", () => {
	const f = makeFixture(false);
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");

	// L'utente ridefinisce "analyst" (che esiste anche come bundled).
	f.writeUser("analyst.md", {
		name: "analyst",
		role: "User Override Analyst",
		description: "user copy",
	});

	const cwd = path.join(f.root, "cwd");
	const res = discoverParticipants(cwd); // skipBundled default false
	const analyst = res.participants.find((p) => p.name === "analyst");
	assert.ok(analyst, "analyst presente");
	assert.equal(analyst!.source, "user", "user sovrascrive bundled");
	assert.equal(analyst!.role, "User Override Analyst");

	delete process.env[GSD_AGENT_DIR_ENV];
});

test("skipBundled: true esclude i partecipanti bundled dal risultato", () => {
	// cwd e userAgent inesistenti: senza bundled -> array vuoto.
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-discussion-arena-no-bundled-"));
	track(tmp);
	process.env[GSD_AGENT_DIR_ENV] = path.join(tmp, "ghost-agent");
	const cwd = path.join(tmp, "cwd");
	fs.mkdirSync(cwd, { recursive: true });

	const res = discoverParticipants(cwd, { skipBundled: true });
	assert.equal(res.participants.length, 0);
	assert.ok(res.participants.every((p) => p.source !== "bundled"));
	delete process.env[GSD_AGENT_DIR_ENV];
});
