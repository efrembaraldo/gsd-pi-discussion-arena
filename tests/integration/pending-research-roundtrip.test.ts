/**
 * tests/integration/pending-research-roundtrip.test.ts — T03/M008/S03.
 *
 * Test end-to-end che esercita l'intera pipeline discussion-arena → extract → write →
 * cleanup su 3 verbatizzati di discussion_arena REALI (fixture
 * `tests/fixtures/scribe-transcripts/*.md`):
 *
 *   1. simulate discussion-arena run (mock): il transcript del run reale del tool
 *      discussion_arena viene letto da fixture (un unta deliberazione reale
 *      del Scribe).
 *   2. extractResearchDecisions(transcript) → struttura tipizzata
 *      (`ResearchDecisions`); il fixture deve parsare SENZA fallback.
 *   3. writePendingResearch(cwd, structured, transcript) → i due file
 *      `pending-research.json` e `.md` compaiono sotto `<cwd>/.gsd/discussion-arena/`
 *      con scrittura atomica (nessun residuo .tmp).
 *   4. round-trip del contenuto: il `.json` parsato === `{version:1, structured}`
 *      e il `.md` contiene il transcript human-readable.
 *   5. simulate milestone_end: l'evento `milestone_end` viene fire-ato sulla
 *      ExtensionAPI reale-di-hook (attachPendingResearchCleanupHooks) → cleanup.
 *   6. verify clean tree: i due file sono assenti e non restano file pendenti
 *      (.json/.md/.tmp) — stato consistente.
 *
 * Il test è esercitato su 3 trio di fixture reali (il ~60% del set): ogni
 * scenario termina con un albero pulito, senza file pendenti.
 */

// Self-sufficiency: registra i hook ESM (`.js` -> `.ts` + stub
// `@gsd/pi-coding-agent`) anche quando il file gira sotto `node --test` senza
// il flag `--import ./tests/ts-esm-loader.mjs` che normalmente aggiunge npm test.
import "../ts-esm-loader.mjs";
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { extractResearchDecisions } from "../../src/discussion-arena-research-extractor.js";
import type {
	ResearchDecisions,
	ExtractResult,
} from "../../src/discussion-arena-research-extractor.js";
const {
	writePendingResearch,
	cleanupPendingResearch,
	pendingResearchPaths,
	attachPendingResearchCleanupHooks,
	handlePendingResearchMilestoneEnd,
} = await import("../../src/discussion-arena-pending-research.js");

/** Directory dei fixture: transcript reali dei run discussion-arena. */
const FIXTURES_DIR = path.resolve(
	fileURLToPath(import.meta.url),
	"..",
	"..",
	"fixtures",
	"scribe-transcripts",
);

/** I tre fixture reali esercitati dal round-trip end-to-end. */
const ROUNDTRIP_FIXTURES = [
	"01-participants-override.md",
	"02-warning-load-estensione.md",
	"03-integrazione-research-adr046.md",
];

/** Legge il contenuto di un fixture per filename. */
function readFixture(name: string): string {
	return readFileSync(path.join(FIXTURES_DIR, name), "utf8");
}

/** Crea un workspace dir temporaneo per i file pending-research. */
async function createTmpDir(): Promise<string> {
	return await fs.mkdtemp(path.join(os.tmpdir(), "pending-roundtrip-"));
}

/** true se `p` esiste su disco. */
async function exists(p: string): Promise<boolean> {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}

/** Elenca i file ancora presenti nella dir pending (senza throw se assente). */
async function pendingDirListing(cwd: string): Promise<string[]> {
	const dir = path.join(cwd, ".gsd", "discussion-arena");
	try {
		return (await fs.readdir(dir)).sort();
	} catch {
		return [];
	}
}

/** true se il risultato extractor è il fallback marker. */
function isFallback(result: ExtractResult): boolean {
	return "fallback" in result;
}

/** Scribe: porta il transcript (fixture reale) → struttura tipizzata. */
function extractStructured(transcript: string): ResearchDecisions {
	const result = extractResearchDecisions(transcript);
	assert.ok(
		!isFallback(result),
		"il fixture deve parsare senza fallback (assegnato anche in extractor.test T03)",
	);
	return result as ResearchDecisions;
}

/** Harness API per fire-are `milestone_end` sugli hook registrati (come T02). */
function createCleanupApiStub(): {
	on: (event: string, handler: (payload: Record<string, unknown>) => void) => void;
	fire: (event: string, payload: Record<string, unknown>) => void;
} {
	const handlers = new Map<string, (payload: Record<string, unknown>) => void>();
	return {
		on(event, handler) {
			handlers.set(event, handler);
		},
		fire(event, payload) {
			handlers.get(event)?.(payload);
		},
	};
}

test("round-trip end-to-end: discussion-arena → extract → write → milestone_end → cleanup (per ogni fixture)", async () => {
	for (const fixture of ROUNDTRIP_FIXTURES) {
		const cwd = await createTmpDir();
		const { jsonPath, markdownPath } = pendingResearchPaths(cwd);
		try {
			// 1) simulate discussion-arena run (mock): un transcript reale di discussion_arena.
			const transcript = readFixture(fixture);
			assert.ok(transcript.length > 0, `${fixture}: transcript non vuoto`);

			// 2) extract → structured (fallback inibibile: must NOT fallback).
			const structured = extractStructured(transcript);

			// 3) write → entrambi i file presenti con scrittura atomica.
			const res = await writePendingResearch(cwd, structured, transcript);
			assert.equal(res.changed, true, `${fixture}: prima scrittura è changed`);
			assert.ok((await fs.stat(jsonPath)).size > 0);
			assert.ok((await fs.stat(markdownPath)).size > 0);

			// 4) round-trip contenuti: JSON.parse == {version:1, structured} e il
			//    .md contiene il transcript human-readable.
			const rawJson = await fs.readFile(jsonPath, "utf-8");
			const parsedJson = JSON.parse(rawJson);
			assert.deepEqual(
				parsedJson,
				{ version: 1, structured },
				`${fixture}: JSON round-trip fedele alla struttura estratta`,
			);
			const rawMd = await fs.readFile(markdownPath, "utf-8");
			assert.ok(
				rawMd === (transcript.endsWith("\n") ? transcript : transcript + "\n"),
				`${fixture}: il markdown conserva l'intero transcript (normalizzato \\n)`,
			);

			// 5) simulate milestone_end → cleanup.
			//    Percorso A (hook cablato): fire `milestone_end` sul api → i file
			//    spariscono senza chiamata diretta a cleanupPendingResearch.
			const api = createCleanupApiStub();
			assert.equal(attachPendingResearchCleanupHooks(api as never), true);
			api.fire("milestone_end", {
				type: "milestone_end",
				milestoneId: "M008",
				status: "completed",
				cwd,
			});
			await waitFor(async () => !(await exists(jsonPath)) && !(await exists(markdownPath)));

			// 6) stato consistente: file assenti, nessun residuo .tmp, albero pulito.
			assert.equal(await exists(jsonPath), false, `${fixture}: json rimosso`);
			assert.equal(await exists(markdownPath), false, `${fixture}: md rimosso`);
			assert.deepEqual(
				await pendingDirListing(cwd),
				[],
				`${fixture}: nessun file pendente (json/md/tmp) dopo il cleanup`,
			);
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	}
});

test("T3: doppio milestone_end e cleanup esplicito restano idempotenti (no-throw, clean)", async () => {
	const cwd = await createTmpDir();
	const { jsonPath, markdownPath } = pendingResearchPaths(cwd);
	try {
		const transcript = readFixture(ROUNDTRIP_FIXTURES[0]);
		const structured = extractStructured(transcript);
		await writePendingResearch(cwd, structured, transcript);

		// milestone_end esplicito (percorso B: handler diretto) doppio + cleanup
		// esplicito ulteriore: nessuno di questi deve throware e l'albero resta
		// pulito (rimozione idempotente, ENOENT ignorato).
		const r1 = await handlePendingResearchMilestoneEnd(cwd);
		assert.equal(r1.removed.length, 2);
		const r2 = await handlePendingResearchMilestoneEnd(cwd);
		assert.deepEqual(r2.removed, [], "secondo milestone_end: niente da rimuovere");
		const r3 = await cleanupPendingResearch(cwd);
		assert.deepEqual(r3.removed, [], "cleanup esplicito su albero già pulito: no-op");

		assert.equal(await exists(jsonPath), false);
		assert.equal(await exists(markdownPath), false);
		assert.deepEqual(await pendingDirListing(cwd), [], "albero pulito");
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

/** Attende fino a `timeoutMs` che `cond` diventi true (polling). */
async function waitFor(
	cond: () => Promise<boolean> | boolean,
	timeoutMs = 2000,
): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (await cond()) return;
		await new Promise((r) => setTimeout(r, 10));
	}
	throw new Error(`waitFor: condizione mai vera entro ${timeoutMs}ms`);
}