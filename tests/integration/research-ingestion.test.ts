/**
 * tests/integration/research-ingestion.test.ts — M008/S04/T03.
 *
 * Test di integrazione end-to-end che esercita l'INTERA pipeline del
 * research-decision flow (docs/architecture/research-decision-flow.md):
 *
 *   1. discussion arena run   → transcript reale del Scribe (fixture
 *                           `tests/fixtures/scribe-transcripts/03-integrazione-research-adr046.md`);
 *   2. extract            → `extractResearchDecisions` produce una struttura
 *                           tipizzata SENZA fallback;
 *   3. write              → `writePendingResearch` persiste `pending-research.json`
 *                           + `.md` sotto cwd/.gsd/discussion-arena/;
 *   4. approve gate       → il coordination file abilita `ingestion.enabled: true`
 *                           e dichiara il blocco versionato `research_decision_format`
 *                           (verificati via `loadDiscussionArenaCoordination`);
 *   5. ingest             → firing dell'evento `milestone_end`: l'hook di
 *                           ingestion (`attachIngestionHooks`) legge i pending
 *                           e produce gli intent save via gli adapter iniettati
 *                           (PRIMA del cleanup), log stderr strutturato per voce;
 *   6. REQUIREMENTS.md    → l'harness (chi esegue i veri gsd_requirement_save /
 *                           gsd_decision_save) consuma gli intent e popola il
 *                           file REQUIREMENTS.md del progetto;
 *   7. cleanup            → l'hook di cleanup (`attachPendingResearchCleanupHooks`)
 *                           rimuove i file pending: albero pulito.
 *
 * Il secondo test verifica l'idempotenza end-to-end: ri-fireare il gate su una
 * pipeline già ingerita NON duplica (nessun nuovo intent ad adapter, REQUIREMENTS.md
 * invariato, ledger persistito).
 *
 * Gli adapter iniettati SONO il contratto decoupled di T02: qui registrano gli
 * intenti (surrogato deterministico delle chiamate reali gsd_requirement_save /
 * gsd_decision_save eseguite dall'harness). Il default `createFileOutboxAdapters`
 * (outbox) è già coperto nei test unitari di `discussion-arena-ingestion.test.ts`.
 *
 * Fixture reali in git (tests/fixtures/), workspace temporaneo in os.tmpdir —
 * mai path gitignored del repo.
 */

// Self-sufficiency: registra gli hook ESM (`.js` -> `.ts` + stub) anche quando
// il file gira sotto `node --test` senza il flag `--import ./tests/ts-esm-loader.mjs`.
import "../ts-esm-loader.mjs";
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
	extractResearchDecisions,
} from "../../src/discussion-arena-research-extractor.js";
import type {
	ResearchDecisions,
	ExtractResult,
} from "../../src/discussion-arena-research-extractor.js";
import {
	attachPendingResearchCleanupHooks,
	pendingResearchPaths,
	writePendingResearch,
} from "../../src/discussion-arena-pending-research.js";
import {
	attachIngestionHooks,
	type IngestionAdapters,
	type RequirementIngestionIntent,
	type DecisionIngestion,
} from "../../src/discussion-arena-ingestion.js";
import {
	loadDiscussionArenaCoordination,
	DISCUSSION_ARENA_COORDINATION_DIR,
	DISCUSSION_ARENA_COORDINATION_FILENAME,
} from "../../src/discussion-arena-coordination.js";

/** Root relativo dei fixture transcript (dal path di questo file). */
const FIXTURES_DIR = path.resolve(
	fileURLToPath(import.meta.url),
	"..",
	"..",
	"fixtures",
	"scribe-transcripts",
);

/** Fixture reale consistente (3 ipotesi, 2 decisioni, 3 requisiti REQ-4/5/6). */
const FIXTURE_NAME = "03-integrazione-research-adr046.md";

/** Crea un workspace dir temporaneo (os.tmpdir, mai path gitignored). */
async function createTmpDir(): Promise<string> {
	return await fs.mkdtemp(path.join(os.tmpdir(), "research-ingest-"));
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

/** Attende (polling) fino a `timeoutMs` che `cond` sia true. */
async function waitFor(
	cond: () => Promise<boolean> | boolean,
	timeoutMs = 3000,
): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (await cond()) return;
		await new Promise((r) => setTimeout(r, 15));
	}
	throw new Error(`waitFor: condizione mai vera entro ${timeoutMs}ms`);
}

/** Legge il transcript reale da fixture. */
function readTranscript(): string {
	return readFileSync(path.join(FIXTURES_DIR, FIXTURE_NAME), "utf8");
}

/** true se l'extractor ha prodotto il marker di fallback. */
function isFallback(result: ExtractResult): boolean {
	return "fallback" in result;
}

/** Crea (mkdir) la dir coordination sotto `<cwd>/.gsd/discussion-arena/`. */
async function ensureCoordDir(cwd: string): Promise<string> {
	const dir = path.join(cwd, DISCUSSION_ARENA_COORDINATION_DIR);
	await fs.mkdir(dir, { recursive: true });
	return dir;
}

/** Scrive il coordination file con opt-in ingestion + blocco research_decision_format. */
async function writeCoordination(cwd: string): Promise<string> {
	const dir = await ensureCoordDir(cwd);
	const p = path.join(dir, DISCUSSION_ARENA_COORDINATION_FILENAME);
	const content = [
		"---",
		"rounds_default: 2",
		"ingestion:",
		"  enabled: true",
		"research_decision_format:",
		"  version: 1",
		"  requirements_schema:",
		"    id: string",
		"    title: string",
		"    priority: must-have | should-have | could-have",
		"  decisions_schema:",
		"    statement: string",
		"    rationale: string",
		"    dissent: string[]",
		"  hypotheses_schema:",
		"    entry: string",
		"---",
	].join("\n");
	await fs.writeFile(p, content, "utf8");
	return p;
}

/** Sink stderr che accumula le righe di log per l'osservabilità. */
function createLogSink(): {
	stderr: NodeJS.WritableStream;
	lines: string[];
} {
	const lines: string[] = [];
	let buffer = "";
	const stderr = {
		write(chunk: string | Uint8Array): boolean {
			const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
			buffer += text;
			const idx = buffer.lastIndexOf("\n");
			if (idx !== -1) {
				lines.push(...buffer.slice(0, idx).split("\n").filter((l) => l.length > 0));
				buffer = buffer.slice(idx + 1);
			}
			return true;
		},
	} as NodeJS.WritableStream;
	return { stderr, lines };
}

/** Adapter che registra gli intenti save ricevuti (render deterministico dei tool). */
function createRecorderAdapters(): {
	adapters: IngestionAdapters;
	requirements: RequirementIngestionIntent[];
	decisions: DecisionIngestion[];
} {
	const requirements: RequirementIngestionIntent[] = [];
	const decisions: DecisionIngestion[] = [];
	return {
		requirements,
		decisions,
		adapters: {
			async saveRequirement(intent) {
				requirements.push(intent);
			},
			async saveDecision(intent) {
				decisions.push(intent);
			},
		},
	};
}

/** API stub con listener ORDINATI (l'ordine di registrazione è parte del contratto). */
function createOrderedApi(): {
	on: (e: string, h: (p: Record<string, unknown>) => void) => void;
	fire: (e: string, p: Record<string, unknown>) => void;
} {
	const lists = new Map<string, ((p: Record<string, unknown>) => void)[]>();
	return {
		on(event, handler) {
			const list = lists.get(event) ?? [];
			list.push(handler);
			lists.set(event, list);
		},
		fire(event, payload) {
			for (const h of lists.get(event) ?? []) h(payload);
		},
	};
}

/** Harness: converte gli intenti salvati in un REQUIREMENTS.md (simula i gsd_*_save). */
function renderRequirementsDocument(
	requirements: RequirementIngestionIntent[],
	decisions: DecisionIngestion[],
): string {
	const out: string[] = ["# Requisiti", ""];
	for (const r of requirements) {
		const label = r.id ? `${r.id} · ` : "";
		out.push(`- ${label}${r.title} (${r.priority}): ${r.description}`);
	}
	out.push("", "## Decisioni", "");
	for (const d of decisions) {
		out.push(`- ${d.statement}`);
		if (d.rationale) out.push(`  - Razionale: ${d.rationale}`);
	}
	return out.join("\n") + "\n";
}

test("end-to-end: discussion arena → extract → write → approva gate → ingest → REQUIREMENTS.md populato → cleanup", async () => {
	const cwd = await createTmpDir();
	try {
		const { stderr, lines } = createLogSink();

		// 1) discussion arena run: transcript reale di discussion_arena.
		const transcript = readTranscript();
		assert.ok(transcript.length > 0, "transcript non vuoto");

		// 2) extract → structured, SES fallback.
		const result = extractResearchDecisions(transcript, stderr);
		assert.ok(!isFallback(result), "il fixture deve parsare senza fallback");
		const structured = result as ResearchDecisions;

		// 3) write → pending-research.json + .md presenti.
		const written = await writePendingResearch(cwd, structured, transcript, stderr);
		assert.equal(written.changed, true, "prima scrittura changed");
		const { jsonPath, markdownPath } = pendingResearchPaths(cwd);
		assert.equal(await exists(jsonPath), true, "pending-research.json scritto");
		assert.equal(await exists(markdownPath), true, "pending-research.md scritto");

		// 4) approvazione gate: opt-in ingestion nel coordination + format versionato.
		const coordPath = await writeCoordination(cwd);
		const coord = loadDiscussionArenaCoordination(coordPath);
		assert.equal(coord.config.ingestion?.enabled, true, "ingestion opt-in attivo");
		assert.equal(coord.config.researchDecisionFormat?.version, 1, "research_decision_format version=1");
		assert.ok(
			typeof coord.config.researchDecisionFormat?.requirements_schema === "string",
			"requirements_schema preservata dal parser (T01)",
		);

		// 5) ingestion su milestone_end: hook registrati in ordine (ingestion PRIMA di cleanup).
		const recorder = createRecorderAdapters();
		const api = createOrderedApi();
		assert.equal(attachIngestionHooks(api, { adapters: recorder.adapters, stderr }), true);
		assert.equal(attachPendingResearchCleanupHooks(api, stderr), true);
		api.fire("milestone_end", {
			type: "milestone_end",
			milestoneId: "M008",
			status: "completed",
			cwd,
		});

		// Attende l'ingestion (3 requirement + 2 decision salvate) e il cleanup.
		await waitFor(
			async () =>
				recorder.requirements.length === 3 &&
				recorder.decisions.length === 2 &&
				!(await exists(jsonPath)) &&
				!(await exists(markdownPath)),
		);

		// Osservabilità: log stderr strutturato per ogni ingestion.
		assert.ok(
			lines.some((l) => l.includes("ingestion: requirement saved")),
			"log 'requirement saved' presente",
		);
		assert.ok(
			lines.some((l) => l.includes("ingestion: decision saved")),
			"log 'decision saved' presente",
		);

		// 6) REQUIREMENTS.md populato dall'harness dagli intenti salvati (intento = gsd_*_save).
		const requirementsMdPath = path.join(cwd, ".gsd", "REQUIREMENTS.md");
		const md = renderRequirementsDocument(recorder.requirements, recorder.decisions);
		await fs.mkdir(path.dirname(requirementsMdPath), { recursive: true });
		await fs.writeFile(requirementsMdPath, md, "utf8");
		const raw = await fs.readFile(requirementsMdPath, "utf-8");
		assert.ok(raw.includes("Trigger deterministico"), "REQUIREMENTS.md contiene REQ-4");
		assert.ok(raw.includes("Coordinamento e versioning del formato"), "REQUIREMENTS.md contiene REQ-6 (should-have)");
		assert.ok(raw.includes("Estendere il trigger-resolver esistente"), "REQUIREMENTS.md contiene la decisione 1");

		// 9) cleanup: nessun file pending residuo; la coord non è rimossa.
		assert.equal(await exists(jsonPath), false, "json pulito");
		assert.equal(await exists(markdownPath), false, "md pulito");
		assert.equal(await exists(coordPath), true, "coordination file intatto");
		assert.equal(await exists(requirementsMdPath), true, "REQUIREMENTS.md persistito");
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

test("idempotenza end-to-end: ri-ingesta dello stesso pending non duplica (REQUIREMENTS.md invariato)", async () => {
	const cwd = await createTmpDir();
	try {
		const stderrSink = createLogSink();
		const transcript = readTranscript();
		const structured = extractResearchDecisions(transcript, stderrSink.stderr) as ResearchDecisions;
		await writePendingResearch(cwd, structured, transcript);
		await writeCoordination(cwd);

		const recorder = createRecorderAdapters();
		const api = createOrderedApi();
		attachIngestionHooks(api, { adapters: recorder.adapters, stderr: stderrSink.stderr });

		// Primo milestone_end → ingerisce tutti gli intents.
		api.fire("milestone_end", { type: "milestone_end", cwd, status: "completed" });
		await waitFor(async () => recorder.requirements.length === 3 && recorder.decisions.length === 2);

		const md1 = renderRequirementsDocument(recorder.requirements, recorder.decisions);

		// Secondo milestone_end: l'ingestion fa solo skip (ledger), nessun nuovo intent.
		api.fire("milestone_end", { type: "milestone_end", cwd, status: "completed" });
		await waitFor(async () => recorder.requirements.length === 3); // resta 3
		assert.equal(recorder.requirements.length, 3, "re-run non aggiunge requirement");
		assert.equal(recorder.decisions.length, 2, "re-run non aggiunge decisioni");
		const md2 = renderRequirementsDocument(recorder.requirements, recorder.decisions);
		assert.equal(md2, md1, "REQUIREMENTS.md invariato su re-run (nessun duplicato)");
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});