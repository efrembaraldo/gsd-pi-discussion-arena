/**
 * Test di validazione degli esempi contro i loader di produzione (M006/S01/T03).
 *
 * Contratto: i file in `examples/` non sono documentazione libera — ognuno è
 * caricato dal loader di produzione che lo riguarda, e questa suite lo
 * dimostra eseguendo i loader reali sui file reali:
 *
 *   - `examples/discussion-arena-coordination.example.md`  → `loadDiscussionArenaCoordination`
 *   - `examples/PREFERENCES.example.md`                    → `parseDiscussionArenaBlock` strict:true
 *                                                            + `resolveTrigger` (source `preferences`)
 *   - `examples/participants/_skeleton.example.md`         → `discoverParticipants` (tier user)
 *
 * In più c'è una guardia di copertura (Integration Closure di S01): quando una
 * slice a valle aggiunge un nuovo file `.example.md` senza associarlo a un
 * loader di produzione, il test fallisce. L'enforcement è reso sensibile dai
 * casi negativi in fondo: un esempio corrotto (rounds_default non intero,
 * chiave fuori schema, frontmatter incompleto) viene rilevato, quindi la
 * validità del file reale non è un tautologia.
 *
 * Nessuna dipendenza npm: solo node:test, node:assert e loader reali. Le
 * fixture temporanee vivono in os.tmpdir (mai path gitignored del repo) e
 * puntano ai file reali via symlink/copia, così il test non può driftare
 * rispetto a ciò che l'utente copia davvero nei suoi progetti.
 */

import { afterEach, test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDiscussionArenaCoordination } from "../src/discussion-arena-coordination.js";
import {
	DiscussionArenaParseError,
	parseDiscussionArenaBlock,
} from "../src/parse-discussion-arena-block.js";
import { discoverParticipants } from "../participants.js";
import { resolveTrigger } from "../trigger-resolver.js";
import { GSD_AGENT_DIR_ENV } from "./fixtures/pi-coding-agent-stub.js";

// ---------------------------------------------------------------------------
// Path reali degli esempi (risolti rispetto a questo file, non al cwd)
// ---------------------------------------------------------------------------

const EXAMPLES_ROOT = fileURLToPath(new URL("../examples", import.meta.url));
const COORD_EXAMPLE = path.join(
	EXAMPLES_ROOT,
	"discussion-arena-coordination.example.md",
);
const PREFERENCES_EXAMPLE = path.join(EXAMPLES_ROOT, "PREFERENCES.example.md");
const SKELETON_EXAMPLE = path.join(
	EXAMPLES_ROOT,
	"participants",
	"_skeleton.example.md",
);
const ARCHITECT_EXAMPLE = path.join(
	EXAMPLES_ROOT,
	"participants",
	"architect.example.md",
);
const OVERRIDE_ARCHITECT_EXAMPLE = path.join(
	EXAMPLES_ROOT,
	"participants-overrides",
	"architect.example.md",
);

// ---------------------------------------------------------------------------
// Infra di test (fixture temporanee in os.tmpdir, cleanup in afterEach)
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

async function makeTmp(prefix: string): Promise<string> {
	const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), prefix));
	tmpDirs.push(dir);
	return dir;
}

afterEach(async () => {
	// La dir utente è un override per-test: non deve trapelare nei test dopo.
	delete process.env[GSD_AGENT_DIR_ENV];
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop()!;
		await fsPromises.rm(dir, { recursive: true, force: true });
	}
});

/**
 * Estrae le righe del blocco `discussion_arena:` dal frontmatter, replicando
 * la logica di `parsePreferences` in trigger-resolver.ts: la chiave root
 * apre il blocco, le righe indentate vengono raccolte, una riga a colonna 0
 * (non vuota) lo chiude. Così il test valida esattamente le stesse righe che
 * il loader di produzione passerebbe al parser condiviso.
 */
function extractDiscussionArenaLines(content: string): string[] {
	const match = content.match(/^---\n([\s\S]*?)\n---/);
	assert.ok(
		match,
		"PREFERENCES.example.md deve avere un frontmatter delimitato da ---",
	);
	const lines = match[1].split("\n");
	const block: string[] = [];
	let inSection = false;
	for (const line of lines) {
		if (/^discussion_arena:\s*$/.test(line)) {
			inSection = true;
			continue;
		}
		if (inSection) {
			if (/^\S/.test(line)) break; // chiave a colonna 0: fine del blocco
			block.push(line);
		}
	}
	return block;
}

/** Walk ricorsivo dei file `.example.md` sotto examples/, path relativi con `/`. */
async function collectExampleFiles(): Promise<string[]> {
	const out: string[] = [];
	async function walk(dir: string): Promise<void> {
		const entries = await fsPromises.readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(full);
			} else if (entry.isFile() && entry.name.endsWith(".example.md")) {
				out.push(path.relative(EXAMPLES_ROOT, full).split(path.sep).join("/"));
			}
		}
	}
	await walk(EXAMPLES_ROOT);
	return out.sort();
}

/**
 * Guardia di copertura (Integration Closure di S01): ogni file `.example.md`
 * in examples/ deve essere validato da un loader di produzione. Un nuovo
 * esempio fa fallire il test finché non viene associato a un loader e non
 * riceve un caso di validazione dedicato qui sotto.
 */
const COVERED_EXAMPLE_FILES = new Set([
	"discussion-arena-coordination.example.md",
	"PREFERENCES.example.md",
	"participants/_skeleton.example.md",
	"participants/architect.example.md",
	"participants-overrides/architect.example.md",
]);

// ---------------------------------------------------------------------------
// Validazione positiva: i tre esempi reali, caricati dai loader reali
// ---------------------------------------------------------------------------

test("coordination example: caricato da loadDiscussionArenaCoordination senza errori né warning", () => {
	const result = loadDiscussionArenaCoordination(COORD_EXAMPLE);
	assert.ok(
		result.sourcePath,
		"il coordination file deve esistere ed essere leggibile",
	);
	assert.deepEqual(
		result.warnings,
		[],
		"un esempio valido non deve produrre warning",
	);
	assert.equal(result.config.roundsDefault, 2);
	assert.equal(result.config.modelDefault, "inference_provider/minimax-m3");

	const scribe = result.config.rolesVirtuals.scribe;
	assert.ok(scribe, "il ruolo virtuale scribe deve essere presente");
	assert.equal(scribe.name, "scribe");
	assert.equal(scribe.role, "Scribe");
	assert.equal(
		scribe.description,
		"Consolida le conclusioni del consiglio in un riepilogo finale",
	);
	assert.match(scribe.systemPrompt, /^Sei il Verbalizzante del consiglio di agenti\./);
	assert.match(
		scribe.systemPrompt,
		/- Produci il riepilogo a fine discussione, non durante\.$/,
	);
});

test("PREFERENCES example: blocco discussion_arena valido in strict:true", () => {
	const content = fs.readFileSync(PREFERENCES_EXAMPLE, "utf8");
	const block = extractDiscussionArenaLines(content);
	assert.ok(
		block.length > 0,
		"il blocco discussion_arena non deve essere vuoto",
	);
	// strict:true lancia DiscussionArenaParseError su chiavi sconosciute o
	// indentazioni fuori schema: il file reale deve passare senza throw.
	const config = parseDiscussionArenaBlock(block, { strict: true });
	assert.equal(config.enabled, true);
	assert.equal(config.mode, "per-milestone");
	assert.deepEqual(config.milestones, {
		M001: { enabled: true },
		M002: { enabled: false },
		M003: { enabled: true },
	});
});

test("PREFERENCES example: resolveTrigger forza la modalità discussion arena via preferences", async () => {
	const projDir = await makeTmp("exval-trigger-");
	await fsPromises.mkdir(path.join(projDir, ".gsd"), { recursive: true });
	// Copia del file reale in .gsd/PREFERENCES.md: è il percorso che il
	// trigger di produzione legge davvero in un progetto.
	await fsPromises.copyFile(
		PREFERENCES_EXAMPLE,
		path.join(projDir, ".gsd", "PREFERENCES.md"),
	);

	const output = await resolveTrigger({
		cwd: projDir,
		milestoneId: "M001",
		env: {},
	});
	assert.equal(output.decision, "forced");
	assert.equal(output.source, "preferences");
	assert.deepEqual(output.parseErrors, []);
	assert.deepEqual(output.warnings, []);
});

test("skeleton participant example: scoperto da discoverParticipants come user participant", async () => {
	const agentDir = await makeTmp("exval-skeleton-");
	const participantsDir = path.join(
		agentDir,
		"discussion-arena",
		"participants",
	);
	await fsPromises.mkdir(participantsDir, { recursive: true });
	// Symlink al file reale: il test valida il contenuto vero, non una copia
	// che può driftare quando l'esempio cambia.
	await fsPromises.symlink(
		SKELETON_EXAMPLE,
		path.join(participantsDir, "_skeleton.example.md"),
	);
	process.env[GSD_AGENT_DIR_ENV] = agentDir;

	const projDir = await makeTmp("exval-skeleton-proj-");
	const result = discoverParticipants(projDir, { skipBundled: true });
	const skeleton = result.participants.find((p) => p.name === "skeleton");
	assert.ok(skeleton, "lo skeleton deve essere scoperto dalla dir utente");
	assert.equal(skeleton.source, "user");
	assert.equal(skeleton.role, "Role label shown in the transcript");
	assert.equal(
		skeleton.description,
		"One-line description of this role's competence in the council",
	);
	assert.deepEqual(skeleton.tools, ["read", "grep", "find", "ls"]);
	assert.equal(skeleton.model, "inference_provider/minimax-m3");
	assert.equal(skeleton.limits.roundTimeoutMs, "120000");
	assert.equal(skeleton.limits.eventTimeoutMs, "60000");
	assert.equal(skeleton.limits.outputLimitChars, "4000");
	assert.equal(skeleton.limits.costBudgetUsd, "0.5");
	assert.equal(skeleton.limits.termination, "soft");
	assert.match(
		skeleton.systemPrompt,
		/^Sei il <ruolo> del consiglio della discussion-arena\./,
	);
});

test("architect example: scoperto da discoverParticipants come user participant realistico", async () => {
	const agentDir = await makeTmp("exval-arch-");
	const participantsDir = path.join(
		agentDir,
		"discussion-arena",
		"participants",
	);
	await fsPromises.mkdir(participantsDir, { recursive: true });
	// Symlink al file reale: il test valida il contenuto vero, non una copia
	// che può driftare quando l'esempio cambia.
	await fsPromises.symlink(
		ARCHITECT_EXAMPLE,
		path.join(participantsDir, "architect.example.md"),
	);
	process.env[GSD_AGENT_DIR_ENV] = agentDir;

	const projDir = await makeTmp("exval-arch-proj-");
	const result = discoverParticipants(projDir, { skipBundled: true });
	assert.equal(
		result.participants.length,
		1,
		"con skipBundled solo il file utente deve comparire",
	);
	const architect = result.participants[0]!;
	assert.equal(architect.name, "architect");
	assert.equal(architect.source, "user");
	assert.equal(architect.role, "Software Architect");
	assert.equal(
		architect.description,
		"Valuta trade-off tecnici, scelte di stack e impatto sulla struttura del sistema",
	);
	assert.deepEqual(architect.tools, ["read", "grep", "find", "ls"]);
	assert.equal(architect.model, "inference_provider/minimax-m3");
	assert.deepEqual(
		architect.limits,
		{},
		"il bundled architect non definisce limiti per-participante",
	);
	assert.match(architect.systemPrompt, /^Sei l'Architect del consiglio\./);
});

test("override architect example: options.overridesDir applica la sostituzione totale sul bundled (senza skipBundled)", async () => {
	const projDir = await makeTmp("exval-ovr-");
	const overridesDir = path.join(projDir, "participants-overrides");
	await fsPromises.mkdir(overridesDir, { recursive: true });
	// Copia del file reale: il test valida il contenuto vero dell'esempio. Il
	// suffisso .example.md è voluto: il loader legge *.md e usa il campo
	// `name` del frontmatter per la base, non il basename del file.
	await fsPromises.copyFile(
		OVERRIDE_ARCHITECT_EXAMPLE,
		path.join(overridesDir, "architect.example.md"),
	);
	// Dir utente isolata e vuota: il test non deve dipendere da ~/.pi/agent.
	process.env[GSD_AGENT_DIR_ENV] = await makeTmp("exval-ovr-agent-");

	// MEM107: NON usare skipBundled — la base `architect` è bundled e deve
	// restare nel map perché l'override non sia orfano.
	const result = discoverParticipants(projDir, { overridesDir });
	assert.equal(result.overridesDir, overridesDir);
	assert.deepEqual(
		result.orphanOverrides,
		[],
		"la base bundled architect esiste: nessun orfano",
	);
	const architect = result.participants.find((p) => p.name === "architect");
	assert.ok(architect, "l'override architect deve comparire nel risultato");
	assert.equal(architect.source, "override");
	assert.equal(architect.role, "Software Architect");
	assert.equal(
		architect.description,
		"Valuta trade-off tecnici con enfasi su debito tecnico e manutenibilità — variante per-progetto",
	);
	assert.deepEqual(
		architect.tools,
		["read", "grep", "find", "ls", "rg"],
		"l'override può cambiare i tools",
	);
	assert.equal(architect.limits.roundTimeoutMs, "90000");
	assert.equal(architect.limits.outputLimitChars, "6000");
	// Prova di sostituzione TOTALE (non merge): il prompt è quello del file
	// override, non quello del bundled.
	assert.match(
		architect.systemPrompt,
		/^Sei l'Architect del consiglio \(override per-progetto\)\./,
	);
	assert.match(architect.systemPrompt, /sostituisce\s+completamente/);
});

test("override architect example: senza options.overridesDir il file non viene letto", async () => {
	const projDir = await makeTmp("exval-ovr-off-");
	const overridesDir = path.join(projDir, "participants-overrides");
	await fsPromises.mkdir(overridesDir, { recursive: true });
	await fsPromises.copyFile(
		OVERRIDE_ARCHITECT_EXAMPLE,
		path.join(overridesDir, "architect.example.md"),
	);
	process.env[GSD_AGENT_DIR_ENV] = await makeTmp("exval-ovr-off-agent-");

	// Nessun walk-up dal tmpdir trova .gsd/discussion-arena/participants-overrides:
	// l'override esiste solo se la dir è esplicita o trovata dal walk-up.
	const result = discoverParticipants(projDir, {});
	assert.equal(
		result.overridesDir,
		null,
		"nessun override attivo senza dir esplicita né walk-up",
	);
	const architect = result.participants.find((p) => p.name === "architect");
	assert.ok(architect, "la base bundled architect resta nel risultato");
	assert.equal(
		architect.source,
		"bundled",
		"il file override non deve essere letto senza overridesDir",
	);
});

test("guardia di copertura: ogni file .example.md in examples/ è validato da un loader di produzione", async () => {
	const files = await collectExampleFiles();
	const uncovered = files.filter((f) => !COVERED_EXAMPLE_FILES.has(f));
	assert.deepEqual(
		uncovered,
		[],
		"nuovo esempio senza loader di produzione: associalo a un loader, aggiungi il caso di validazione e la voce in COVERED_EXAMPLE_FILES",
	);
});

// ---------------------------------------------------------------------------
// Casi negativi: l'enforcement è sensibile (un esempio corrotto viene visto)
// ---------------------------------------------------------------------------

test("negativo: coordination con rounds_default non intero produce warning e nessun default", async () => {
	const tmp = await makeTmp("exval-neg-coord-");
	const badPath = path.join(tmp, "coordination-bad.md");
	const content = fs
		.readFileSync(COORD_EXAMPLE, "utf8")
		.replace("rounds_default: 2", "rounds_default: 0");
	await fsPromises.writeFile(badPath, content, "utf8");

	const result = loadDiscussionArenaCoordination(badPath);
	assert.equal(result.config.roundsDefault, undefined);
	assert.ok(
		result.warnings.some((w) => w.includes("rounds_default")),
		"il loader deve segnalare la chiave non valida (warnings: " +
			JSON.stringify(result.warnings) +
			")",
	);
});

test("negativo: PREFERENCES con chiave sconosciuta nel blocco lancia DiscussionArenaParseError in strict:true", () => {
	const content = fs
		.readFileSync(PREFERENCES_EXAMPLE, "utf8")
		.replace("  mode: per-milestone", "  bogus_key: 1\n  mode: per-milestone");
	const block = extractDiscussionArenaLines(content);
	assert.throws(
		() => parseDiscussionArenaBlock(block, { strict: true }),
		DiscussionArenaParseError,
	);
});

test("negativo: participant skeleton senza role viene escluso dalla discovery", async () => {
	const agentDir = await makeTmp("exval-neg-part-");
	const participantsDir = path.join(
		agentDir,
		"discussion-arena",
		"participants",
	);
	await fsPromises.mkdir(participantsDir, { recursive: true });
	const broken = fs
		.readFileSync(SKELETON_EXAMPLE, "utf8")
		.replace(/^role: .*$/m, "");
	await fsPromises.writeFile(
		path.join(participantsDir, "_broken.example.md"),
		broken,
		"utf8",
	);
	process.env[GSD_AGENT_DIR_ENV] = agentDir;

	const projDir = await makeTmp("exval-neg-part-proj-");
	const result = discoverParticipants(projDir, { skipBundled: true });
	assert.equal(
		result.participants.length,
		0,
		"un partecipante senza role non deve comparire",
	);
});

test("negativo: override orfano (base assente) lancia l'errore bloccante del loader", async () => {
	const projDir = await makeTmp("exval-ovr-orphan-");
	const overridesDir = path.join(projDir, "participants-overrides");
	await fsPromises.mkdir(overridesDir, { recursive: true });
	// L'esempio reale modificato in un dettaglio: `name` senza base né bundled
	// né user né project né virtual — l'enforcement orfani deve vederlo.
	const orphan = fs
		.readFileSync(OVERRIDE_ARCHITECT_EXAMPLE, "utf8")
		.replace(/^name: architect$/m, "name: ghost-role");
	await fsPromises.writeFile(
		path.join(overridesDir, "ghost-role.example.md"),
		orphan,
		"utf8",
	);
	process.env[GSD_AGENT_DIR_ENV] = await makeTmp("exval-ovr-orphan-agent-");

	assert.throws(
		() => discoverParticipants(projDir, { overridesDir }),
		/override target 'ghost-role' not found in participants\/ — create participants\/ghost-role\.md or remove the override file/,
	);
});
