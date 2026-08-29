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
import { discoverParticipants, normalizeEngine } from "../participants.js";
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
		// M015/S01/T02: 5 nuovi campi opzionali retrocompatibili. hermes_toolsets
		// e hermes_skills sono stringhe CSV (split su "," dal parser, identico a
		// `tools`). engine/provider passati raw (engine normalizzato via
		// normalizeEngine). soft_deadline_ms è numerico (limite upper-bound
		// "morbido" sul tempo di esecuzione del participant, S01/T01).
		engine?: string;
		provider?: string;
		hermes_toolsets?: string;
		hermes_skills?: string;
		soft_deadline_ms?: number;
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
	if (opts.engine !== undefined) rows.push(`engine: ${opts.engine}`);
	if (opts.provider !== undefined) rows.push(`provider: ${opts.provider}`);
	if (opts.hermes_toolsets !== undefined)
		rows.push(`hermes_toolsets: ${opts.hermes_toolsets}`);
	if (opts.hermes_skills !== undefined)
		rows.push(`hermes_skills: ${opts.hermes_skills}`);
	if (opts.soft_deadline_ms !== undefined)
		rows.push(`soft_deadline_ms: ${opts.soft_deadline_ms}`);
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

	// Asserzione autoritativa sul modello (M009/S03): i 4 bundled devono
	// dichiarare esplicitamente model === "minimax/minimax-m3", l'id
	// registrato in packages/pi-ai/src/models.generated.json (provider
	// openrouter). Senza questo controllo un drift futuro nel frontmatter
	// verso un id non risolvibile (es. inference_provider/minimax-m3)
	// passerebbe silenziosamente.
	for (const expected of ["analyst", "architect", "dev", "qa"]) {
		const p = res.participants.find(
			(x) => x.name === expected && x.source === "bundled",
		);
		assert.ok(
			p,
			`${expected} deve essere presente come bundled`,
		);
		assert.equal(
			p!.model,
			"minimax/minimax-m3",
			`${expected} bundled deve dichiarare model === "minimax/minimax-m3"`,
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

// ─── M015/S01/T02: 5 nuovi campi opzionali + normalizeEngine ──────────────
//
// I 5 nuovi campi opzionali (engine, provider, hermes_toolsets, hermes_skills,
// soft_deadline_ms) sono retrocompatibili: un participant pre-M015 senza
// questi campi produce un ParticipantConfig con tutti i nuovi campi
// `undefined`. `normalizeEngine` è fail-safe: mai lancia, fallback "gsd"
// per qualsiasi input non riconosciuto (case-insensitive matching solo per
// "hermes"). Test #1-3 verificano che parseParticipantContent accetti i 5
// nuovi campi nel frontmatter; #4-6 verificano normalizeEngine (case
// insensitive, fallback, mai lancia); #7 verifica retrocompat sui 5
// bundled (analyst/architect/dev/qa/scribe); #8 verifica che un frontmatter
// senza `engine` produca `engine: undefined` (defaulting demandato al
// consumer, non al parser).

test("parseParticipantContent accetta engine: hermes (frontmatter engine=hermes → config.engine='hermes')", () => {
	const f = makeFixture(false);
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");

	f.writeUser("hermes-agent.md", {
		name: "hermes-agent",
		role: "Hermes Agent",
		description: "agent con engine hermes",
		engine: "hermes",
	});

	const res = discoverParticipants(path.join(f.root, "cwd"), {
		skipBundled: true,
	});
	const p = res.participants.find((x) => x.name === "hermes-agent");
	assert.ok(p, "il partecipante deve essere scoperto");
	assert.equal(p!.engine, "hermes", "engine='hermes' popola il campo config");
	// provider/hermesToolsets/hermesSkills/softDeadlineMs restano undefined
	// perché il frontmatter di questa fixture non li dichiara.
	assert.equal(p!.provider, undefined);
	assert.equal(p!.hermesToolsets, undefined);
	assert.equal(p!.hermesSkills, undefined);
	assert.equal(p!.softDeadlineMs, undefined);
	// limits.softDeadlineMs resta undefined: il 6° campo LIMITS_FRONTMATTER_KEYS
	// legge il valore solo se presente nel frontmatter.
	assert.equal(p!.limits.softDeadlineMs, undefined);

	delete process.env[GSD_AGENT_DIR_ENV];
});

test("parseParticipantContent accetta provider, hermes_toolsets, hermes_skills nel frontmatter", () => {
	const f = makeFixture(false);
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");

	f.writeUser("tooled.md", {
		name: "tooled",
		role: "Tooled",
		description: "agent con provider + hermes toolsets/skills",
		provider: "anthropic",
		hermes_toolsets: "web,research",
		hermes_skills: "search",
	});

	const res = discoverParticipants(path.join(f.root, "cwd"), {
		skipBundled: true,
	});
	const p = res.participants.find((x) => x.name === "tooled");
	assert.ok(p, "il partecipante deve essere scoperto");
	// provider: stringa raw passata tale e quale (validazione demandata al
	// runtime S02, non al parser).
	assert.equal(p!.provider, "anthropic");
	// hermes_toolsets: CSV → array (stessa logica di `tools`, split su "," +
	// trim + filter Boolean).
	assert.deepEqual(p!.hermesToolsets, ["web", "research"]);
	// hermes_skills: speculare, CSV → array.
	assert.deepEqual(p!.hermesSkills, ["search"]);
	// engine non specificato → undefined (anche se normalizeEngine("") →
	// "gsd", il parser NON chiama normalizeEngine quando il campo è assente).
	assert.equal(p!.engine, undefined);

	delete process.env[GSD_AGENT_DIR_ENV];
});

test("parseParticipantContent accetta soft_deadline_ms nel frontmatter (limits + top-level)", () => {
	const f = makeFixture(false);
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");

	f.writeUser("deadline-aware.md", {
		name: "deadline-aware",
		role: "Deadline Aware",
		description: "agent con soft deadline",
		soft_deadline_ms: 300000,
	});

	const res = discoverParticipants(path.join(f.root, "cwd"), {
		skipBundled: true,
	});
	const p = res.participants.find((x) => x.name === "deadline-aware");
	assert.ok(p, "il partecipante deve essere scoperto");
	// limits.softDeadlineMs popolato dal 6° entry di LIMITS_FRONTMATTER_KEYS
	// (snake_case → camelCase).
	assert.equal(p!.limits.softDeadlineMs, 300000);
	// softDeadlineMs al top-level del config (conditional spread quando
	// limits.softDeadlineMs è un number — shortcut per accesso diretto).
	assert.equal(p!.softDeadlineMs, 300000);

	delete process.env[GSD_AGENT_DIR_ENV];
});

test("normalizeEngine: 'hermes' case-insensitive (Hermes/HERMES/heRmEs → 'hermes')", () => {
	for (const raw of ["hermes", "HERMES", "Hermes", "heRmEs"]) {
		assert.equal(
			normalizeEngine(raw),
			"hermes",
			`normalizeEngine(${JSON.stringify(raw)}) deve restituire 'hermes'`,
		);
	}
});

test("normalizeEngine fallback 'gsd' per qualsiasi input non-hermes", () => {
	// Inputs che NON sono "hermes" (case-insensitive) e devono degradare a
	// "gsd". Copre: undefined, null, "", stringhe non riconosciute, numeri,
	// booleani, oggetti, array (anche array contentente "hermes").
	const inputs: ReadonlyArray<unknown> = [
		undefined,
		null,
		"",
		"gsd",
		"openai",
		" hermes", // leading whitespace
		"hermes ", // trailing whitespace
		"hermes2", // substring
		"HERMES ", // case + trailing whitespace
		42,
		0,
		-1,
		true,
		false,
		{},
		{ engine: "hermes" }, // object literal, NON stringa
		[],
		["hermes"], // array di stringhe, NON stringa singola
	];
	for (const raw of inputs) {
		const result = normalizeEngine(raw);
		assert.equal(
			result,
			"gsd",
			`normalizeEngine(${raw === undefined ? "undefined" : JSON.stringify(raw)}) deve restituire 'gsd', ottenuto '${result}'`,
		);
	}
});

test("normalizeEngine non lancia mai su input esotici (Symbol, BigInt, Proxy malevolo, oggetti getter)", () => {
	// Inputs che normalmente non lanciano (typeof !== "string" → la funzione
	// salta il branch toLowerCase senza mai accedere a proprietà dell'input).
	// Più un Proxy che intercetta il get di "toLowerCase" lanciando, per
	// esercitare il try/catch interno della funzione (typeof su Proxy è
	// "object", quindi la guardia interna short-circuit prima di toLowerCase;
	// il test rimane utile come sanity-check "no-throw" su input malevoli).
	const evilProxy = new Proxy(
		{},
		{
			get(_target, prop) {
				if (prop === "toLowerCase") throw new Error("toLowerCase trap");
				return undefined;
			},
		},
	);
	const evilGetter = Object.defineProperty({}, "toLowerCase", {
		get() {
			throw new Error("getter toLowerCase");
		},
	});

	const inputs: ReadonlyArray<unknown> = [
		Symbol("hermes"),
		BigInt(1),
		evilProxy,
		evilGetter,
		{ toString: () => { throw new Error("evil toString"); } },
	];
	for (const raw of inputs) {
		let result: unknown;
		assert.doesNotThrow(
			() => {
				result = normalizeEngine(raw);
			},
			`normalizeEngine non deve lanciare su input esotico`,
		);
		// Deve comunque restituire un valore del union valido (mai undefined).
		assert.ok(
			result === "gsd" || result === "hermes",
			`deve essere 'gsd'|'hermes', ottenuto ${String(result)}`,
		);
	}
});

test("retrocompat: i 5 partecipanti bundled (analyst/architect/dev/qa/scribe) parsano senza engine/provider/hermesToolsets/hermesSkills/softDeadlineMs", () => {
	// cwd in /tmp: walk-up di findNearestProjectParticipantsDir/
	// findNearestOverridesDir/findNearestCoordinationFile non trova nessuna
	// directory rilevante. userDir punta a un tmp vuoto. Restano solo i 5
	// bundled (analyst/architect/dev/qa/scribe). Verifichiamo che TUTTI i
	// campi nuovi siano undefined sui 5 (nessuna regressione del parser
	// verso valori di default sbagliati).
	const cwd = path.join(
		os.tmpdir(),
		"gsd-discussion-arena-m015-retrocompat",
	);
	process.env[GSD_AGENT_DIR_ENV] = path.join(
		os.tmpdir(),
		"gsd-discussion-arena-m015-retrocompat-user",
	);

	const res = discoverParticipants(cwd);
	for (const expectedName of [
		"analyst",
		"architect",
		"dev",
		"qa",
		"scribe",
	]) {
		const p = res.participants.find(
			(x) => x.name === expectedName && x.source === "bundled",
		);
		assert.ok(p, `${expectedName} deve essere presente come bundled`);
		// M015: tutti i 5 nuovi campi opzionali sono undefined sui
		// participant pre-M015 (nessun defaulting al parser, demandato al
		// consumer in S02).
		assert.equal(
			p!.engine,
			undefined,
			`${expectedName}: engine deve essere undefined (pre-M015)`,
		);
		assert.equal(
			p!.provider,
			undefined,
			`${expectedName}: provider deve essere undefined`,
		);
		assert.equal(
			p!.hermesToolsets,
			undefined,
			`${expectedName}: hermesToolsets deve essere undefined`,
		);
		assert.equal(
			p!.hermesSkills,
			undefined,
			`${expectedName}: hermesSkills deve essere undefined`,
		);
		assert.equal(
			p!.softDeadlineMs,
			undefined,
			`${expectedName}: softDeadlineMs deve essere undefined`,
		);
		// Anche il 6° campo limits.softDeadlineMs resta undefined sui bundled.
		assert.equal(
			p!.limits.softDeadlineMs,
			undefined,
			`${expectedName}: limits.softDeadlineMs deve essere undefined`,
		);
	}

	delete process.env[GSD_AGENT_DIR_ENV];
});

test("frontmatter senza engine produce ParticipantConfig.engine undefined (defaulting demandato al consumer, non al parser)", () => {
	const f = makeFixture(false);
	track(f.root);
	process.env[GSD_AGENT_DIR_ENV] = path.join(f.root, "agent");

	// Fixture che NON dichiara `engine` nel frontmatter.
	f.writeUser("no-engine.md", {
		name: "no-engine",
		role: "No Engine",
		description: "partecipante senza engine nel frontmatter",
	});

	const res = discoverParticipants(path.join(f.root, "cwd"), {
		skipBundled: true,
	});
	const p = res.participants.find((x) => x.name === "no-engine");
	assert.ok(p, "il partecipante deve essere scoperto");
	// Il parser NON chiama normalizeEngine quando il campo è assente dal
	// frontmatter (vedi conditional spread in parseParticipantContent):
	// engine resta undefined, NON "gsd" (che sarebbe un defaulting al
	// parser, demandato invece al consumer S02).
	assert.equal(
		p!.engine,
		undefined,
		"engine deve essere undefined (NON 'gsd') sul config del parser",
	);

	// Sanity check: normalizeEngine è il punto di defaulting (chiamato dal
	// consumer, non dal parser). normalizeEngine(undefined) ritorna "gsd".
	assert.equal(
		normalizeEngine(undefined),
		"gsd",
		"sanity check: normalizeEngine(undefined) ritorna 'gsd'",
	);

	delete process.env[GSD_AGENT_DIR_ENV];
});
