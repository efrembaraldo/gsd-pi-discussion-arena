/**
 * tests/discussion-arena-pending-research.test.ts — Unit test T01/M008/S03.
 *
 * Copre il contratto del writer atomico dei file pending-research:
 *   - scrittura dei file .json (+ .md) con mkdir recursive della dir assente;
 *   - atomicità write-then-rename: nessun residuo .tmp dopo un write riuscito
 *     e, più in profondità, kill -9 a metà scrittura non lascia mai un file
 *     target corrotto o parziale (il target compare solo via rename atomico);
 *   - idempotenza: scrivere lo stesso payload due volte produce contenuto
 *     identico e changed=false;
 *   - round-trip: il .json parsa a {version: 1, structured} === input;
 *   - cleanupPendingResearch rimuove i file; assenti -> count 0 senza throw;
 *   - log stderr strutturato per write e cleanup con path/size/mtime sintetica.
 *
 * I file vengono scritti in un tmpdir (os.tmpdir), mai su path di progetto.
 */

// Self-sufficiency: registra i hook ESM (`.js` -> `.ts` + stub
// `@gsd/pi-coding-agent`) anche quando il file gira sotto `node --test` senza
// il flag `--import ./tests/ts-esm-loader.mjs` che normalmente aggiunge npm test.
import "./ts-esm-loader.mjs";
import * as assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const {
	writePendingResearch,
	cleanupPendingResearch,
	pendingResearchPaths,
	renderPendingResearchJson,
	renderPendingResearchMarkdown,
	PENDING_RESEARCH_JSON_FILENAME,
	PENDING_RESEARCH_MD_FILENAME,
} = await import("../src/discussion-arena-pending-research.js");
import type { ResearchDecisions } from "../src/discussion-arena-research-extractor.js";

/** Struttura tipizzata di esempio (parsata con successo dal Scribe). */
const STRUCTURED: ResearchDecisions = {
	hypotheses: [
		"L'estrazione deterministica è più affidabile di una model call",
	],
	decisions: [
		{
			statement: "Adottare parsing deterministico su markdown",
			rationale: "costo zero, latenza zero, output deterministico",
			dissent: ["fragile di fronte a varianti di wording"],
		},
	],
	requirements: [
		{
			id: "R1",
			title: "Parser deterministico",
			description: "parsing con regex multiline",
			priority: "must-have",
		},
	],
};

/** Crea un workspace dir temporaneo per i file pending-research. */
async function createTmpDir(): Promise<string> {
	return await fs.mkdtemp(path.join(os.tmpdir(), "pending-research-test-"));
}

/** Raccoglitore stderr in-memory per asserire i log strutturati. */
function collectStderr(): {
	stream: NodeJS.WritableStream;
	lines: () => string[];
} {
	const lines: string[] = [];
	const stream = {
		write: (chunk: unknown) => {
			lines.push(String(chunk).replace(/\n$/, ""));
			return true;
		},
	} as NodeJS.WritableStream;
	return { stream, lines: () => lines };
}

test("write: created dir recursively + both files exist + JSON round-trip", async () => {
	const cwd = await createTmpDir();
	try {
		const { stream } = collectStderr();
		const res = await writePendingResearch(cwd, STRUCTURED, `# Transcript di prova\n`, stream);
		const { jsonPath, markdownPath } = pendingResearchPaths(cwd);

		assert.equal(res.changed, true);
		assert.equal(res.jsonBytes, (await fs.stat(jsonPath)).size);
		assert.ok((await fs.stat(jsonPath)).mtimeMs > 0);
		assert.equal(res.markdownBytes, (await fs.stat(markdownPath)).size);

		// mkdir recursive: la directory `.gsd/discussion-arena/` è nata da zero.
		assert.equal(await writeExists(jsonPath), true);
		assert.equal(await writeExists(markdownPath), true);

		// Round-trip del .json: struttura parsata === input.
		const raw = await fs.readFile(jsonPath, "utf-8");
		const parsed = JSON.parse(raw);
		assert.deepEqual(parsed, { version: 1, structured: STRUCTURED });

		// Il .md contiene il transcript human-readable (normalizzato a \n finale).
		const md = await fs.readFile(markdownPath, "utf-8");
		assert.ok(md.includes("# Transcript"), "markdown contiene il transcript");
		assert.ok(md.endsWith("\n"), "markdown normalizzato con newline finale");
	} finally {
		await fs.rm(cwd, { recursive: true });
	}
});

test("atomicity: nessun residuo .tmp dopo un write riuscito", async () => {
	const cwd = await createTmpDir();
	try {
		await writePendingResearch(cwd, STRUCTURED, `t`);
		const { jsonPath, markdownPath } = pendingResearchPaths(cwd);
		const dir = path.dirname(jsonPath);
		const leftovers = (await fs.readdir(dir)).filter((f) => f.endsWith(".tmp"));
		assert.deepEqual(
			leftovers,
			[],
			"nessun temp file residue dopo il rename atomico",
		);
		void markdownPath;
		void jsonPath;
	} finally {
		await fs.rm(cwd, { recursive: true });
	}
});

test("idempotenza: stesso payload due volte produce contenuto identico e changed=false", async () => {
	const cwd = await createTmpDir();
	try {
		const first = await writePendingResearch(cwd, STRUCTURED, `t`);
		assert.equal(first.changed, true);
		const { jsonPath, markdownPath } = pendingResearchPaths(cwd);
		const jsonAfterFirst = await fs.readFile(jsonPath, "utf-8");
		const mdAfterFirst = await fs.readFile(markdownPath, "utf-8");

		const second = await writePendingResearch(cwd, STRUCTURED, `t`);
		assert.equal(second.changed, false, "seconda scrittura identica non riscrive");
		assert.equal(await fs.readFile(jsonPath, "utf-8"), jsonAfterFirst);
		assert.equal(await fs.readFile(markdownPath, "utf-8"), mdAfterFirst);
	} finally {
		await fs.rm(cwd, { recursive: true });
	}
});

test("payload differente -> changed=true e contenuto aggiornato", async () => {
	const cwd = await createTmpDir();
	try {
		await writePendingResearch(cwd, STRUCTURED, `primo`);
		const second = await writePendingResearch(cwd, STRUCTURED, `secondo`);
		assert.equal(second.changed, true);
		const { markdownPath } = pendingResearchPaths(cwd);
		assert.ok(
			(await fs.readFile(markdownPath, "utf-8")).includes("secondo"),
		);
	} finally {
		await fs.rm(cwd, { recursive: true });
	}
});

test("cleanup: rimuove entrambi i file; chiarimento count e paths", async () => {
	const cwd = await createTmpDir();
	try {
		await writePendingResearch(cwd, STRUCTURED, `t`);
		const { jsonPath, markdownPath } = pendingResearchPaths(cwd);
		const { stream, lines } = collectStderr();

		const res = await cleanupPendingResearch(cwd, stream);
		assert.equal(res.removed.length, 2);
		assert.deepEqual(
			res.removed.sort(),
			[jsonPath, markdownPath].sort(),
		);
		assert.equal(await writeExists(jsonPath), false);
		assert.equal(await writeExists(markdownPath), false);

		// Log stderr strutturato con count e path.
		const logText = lines().join("\n");
		assert.match(logText, /pending-research: cleanup count=2/);
		assert.ok(logText.includes(jsonPath), "log menziona il path json");
		assert.ok(logText.includes(markdownPath), "log menziona il path md");
	} finally {
		await fs.rm(cwd, { recursive: true });
	}
});

test("cleanup senza file presenti: count=0, nessuna eccezione", async () => {
	const cwd = await createTmpDir();
	try {
		const { stream } = collectStderr();
		const res = await cleanupPendingResearch(cwd, stream);
		assert.deepEqual(res.removed, []);
		assert.equal(res.removed.length, 0);
	} finally {
		await fs.rm(cwd, { recursive: true });
	}
});

test("log stderr strutturato per il primo write con path/size/mtime", async () => {
	const cwd = await createTmpDir();
	try {
		const { stream, lines } = collectStderr();
		await writePendingResearch(cwd, STRUCTURED, `t`, stream);
		const logText = lines().join("\n ");

		// Due write events (json+md) con metadata path/size/mtime — regex statici.
		const writeEvents = logText.match(
			/pending-research: write .*? size=\d+ mtime=\d{4}-\d{2}-\d{2}T/g,
		);
		assert.ok(
			writeEvents && writeEvents.length === 2,
			`attesi 2 write events con metadata, trovati ${writeEvents?.length ?? 0}`,
		);
		assert.ok(
			logText.includes(`${PENDING_RESEARCH_JSON_FILENAME} size=`),
			"log json contiene size nel metadata",
		);
		assert.ok(
			logText.includes(`${PENDING_RESEARCH_MD_FILENAME} size=`),
			"log md contiene size nel metadata",
		);
		assert.match(logText, /mtime=\d{4}-\d{2}-\d{2}T/);
	} finally {
		await fs.rm(cwd, { recursive: true });
	}
});

test("rendering deterministi: stesso input -> stessi byte (nessun timestamp interno)", () => {
	const a = renderPendingResearchJson({ version: 1, structured: STRUCTURED });
	const b = renderPendingResearchJson({ version: 1, structured: STRUCTURED });
	assert.equal(a, b, "serializzazione pura: nessun mtime/timestamp interni");
	const mdA = renderPendingResearchMarkdown(`prova`);
	const mdB = renderPendingResearchMarkdown(`prova`);
	assert.equal(mdA, mdB);
	assert.equal(mdA, "prova\n", "newline terminale unico");
});

// ===== Atomicità reale: subprocess kill -9 mid-write =====

/** Path assoluti dei sorgenti e loader da passare al subprocess figlio. */
const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const SRC_FILE = path.join(REPO_ROOT, "src", "discussion-arena-pending-research.ts");
const LOADER_FILE = path.join(REPO_ROOT, "tests", "ts-esm-loader.mjs");

/**
 * Scrive quanto segue in `cwd` un payload STRUTTURATO grande (12MB) così la
 * scrivitura occupa tempo e il SIGKILL può colpire a metà scrittura. Il file
 * target compare SOLO via rename atomico: un SIGKILL a metà non può produrre
 * un .json parziale. Invarianza verificata: se un target esiste, è intero e
 * parsato-corretto (mai corrotto/parziale).
 */
async function crashProbe(crashCwd: string): Promise<void> {
	const childFile = path.join(crashCwd, "crash-writer.mjs");
	await fs.writeFile(
		childFile,
		`import { pathToFileURL } from "node:url";
const [src, cwd] = process.argv.slice(2);
const mod = await import(pathToFileURL(src).href);
const big = "x".repeat(12 * 1024 * 1024);
await mod.writePendingResearch(
  cwd,
  { hypotheses: [big], decisions: [{ statement: "d" }], requirements: [] },
  "# Verbalizzato\\n",
  process.stderr,
);
`,
		"utf-8",
	);
	const proc = spawn(process.execPath, ["--import", LOADER_FILE, childFile, SRC_FILE, crashCwd], {
		stdio: ["ignore", "ignore", "pipe"],
	});
	let err = "";
	proc.stderr.on("data", (c) => (err += String(c)));
	// kill -9 dopo un piccolo ritardo per colpire durante la scrittura.
	await new Promise((r) => setTimeout(r, 40));
	proc.kill("SIGKILL");
	await new Promise((r) => proc.on("close", r));

	// Invariante di atomicità: un target presente è SEMPRE intero/valido.
	const { jsonPath, markdownPath } = pendingResearchPaths(crashCwd);
	for (const p of [jsonPath, markdownPath]) {
		if (!(await writeExists(p))) continue;
		const raw = await fs.readFile(p, "utf-8");
		if (p.endsWith("json")) {
			// Un JSON presente deve essere parsable (mai parziale/corrotto).
			const parsed = JSON.parse(raw);
			assert.ok(parsed && typeof parsed === "object", "json non corrotto dopo kill");
		} else {
			assert.ok(raw.startsWith("# Verbalizzato"), "md non parziale dopo kill");
		}
	}
	void err;
}

test("atomicità reale: kill -9 a metà scrittura non lascia file target corrotto", async () => {
	const cwd = await createTmpDir();
	try {
		// Collana di probe su più subdir per colpire quante più fasi della
		// scrittura possibile; l'invariante vale comunque ad ogni fase.
		const probes = [1, 2, 3];
		for (const _ of probes) {
			const sub = path.join(cwd, `probe-${_}`);
			await fs.mkdir(sub, { recursive: true });
			await crashProbe(sub);
		}
	} finally {
		await fs.rm(cwd, { recursive: true });
	}
});

/** true se il path esiste su disco. */
async function writeExists(p: string): Promise<boolean> {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}