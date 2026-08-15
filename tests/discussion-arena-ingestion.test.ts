/**
 * tests/discussion-arena-ingestion.test.ts — M008/S04/T02.
 *
 * Test unit-integrazione dell'ingestion flow idempotente dei pending-research
 * verso gli intent di salvataggio GSD (gsd_requirement_save / gsd_decision_save).
 *
 * Contratto (Verify T02):
 *   - pending-research.json con 3 requirement + 2 decision → 3
 *     requirement_save + 2 decision_save chiamati (adapter iniettati che
 *     registrano le chiamate).
 *   - Idempotenza: ri-run sullo stesso albero → 0 chiamate (tutte saltate per
 *     giveaway già ingerite nel ledger), nessun duplicato.
 *
 * Il modulo è decoupled dai tool: gli adapter reali sono iniettati qui come
 * recorder; il default (createFileOutboxAdapters) viene esercitato per il
 * handoff su file outbox. Il log stderr viene catturato passando un sink
 * dedicato via `options.stderr`.
 */

// Self-sufficiency: registra gli hook ESM (`.js` -> `.ts` + stub) anche quando
// il file gira sotto `node --test` senza il flag `--import ./tests/ts-esm-loader.mjs`.
import "./ts-esm-loader.mjs";
import * as assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { ResearchDecisions } from "../src/discussion-arena-research-extractor.js";
import {
	ingestPendingResearch,
	clearIngestionLedger,
	readIngestionLedger,
	buildIngestionPlan,
	isIngestionEnabled,
	attachIngestionHooks,
	type IngestionAdapters,
} from "../src/discussion-arena-ingestion.js";

/** Crea un workspace dir temporaneo. */
async function createTmpDir(): Promise<string> {
	return await fs.mkdtemp(path.join(os.tmpdir(), "ingestion-"));
}

/** Assicura la dir `.gsd/discussion-arena/` e ritorna il path della dir. */
async function ensurePendingDir(cwd: string): Promise<string> {
	const dir = path.join(cwd, ".gsd", "discussion-arena");
	await fs.mkdir(dir, { recursive: true });
	return dir;
}

/** Scrive un file pending-research.json con la structured data data. */
async function writePendingJson(
	cwd: string,
	structured: ResearchDecisions,
): Promise<string> {
	const dir = await ensurePendingDir(cwd);
	const p = path.join(dir, "pending-research.json");
	await fs.writeFile(p, JSON.stringify({ version: 1, structured }, null, 2), "utf-8");
	return p;
}

/** Struttura di test: 3 requirement + 2 decisioni (contratto Verify T2). */
function sampleStructured(): ResearchDecisions {
	return {
		hypotheses: ["H1"],
		decisions: [
			{
				statement: "Adottare il formato versionato research_decision_format",
				rationale: "Coerenza con la slice M008/S04",
				dissent: ["Aggiunge complessita di parsing"],
			},
			{
				statement: "L'ingestion resta idempotente via ledger",
				rationale: "Re-run non duplica",
			},
		],
		requirements: [
			{ id: "R1", title: "Coordination file parsa research_decision_format", description: "Blocco versionato", priority: "must-have" },
			{ id: "R2", title: "gsd_requirement_save invocato per ogni requirement", description: "estrattore", priority: "must-have" },
			{ title: "Docs di flusso aggiornate", description: "senza id", priority: "should-have" },
		],
	};
}

/** Un sink stderr che accumula le righe di log. */
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

/** Builda un linker di ingest che registra le chiamate in array. */
function createRecorderAdapters(): {
	adapters: IngestionAdapters;
	requirements: unknown[];
	decisions: unknown[];
} {
	const requirements: unknown[] = [];
	const decisions: unknown[] = [];
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

test("verify: 3 requirement + 2 decisioni → 3 saveRequirement + 2 saveDecision chiamati", async () => {
	const cwd = await createTmpDir();
	try {
		await writePendingJson(cwd, sampleStructured());
		const { requirements, decisions, adapters } = createRecorderAdapters();
		const { stderr } = createLogSink();
		const res = await ingestPendingResearch(cwd, { adapters, stderr });
		assert.equal(res.requirementsSaved, 3, "3 requirement salvati");
		assert.equal(res.decisionsSaved, 2, "2 decisioni salvate");
		assert.equal(res.requirementsSkipped, 0);
		assert.equal(res.decisionsSkipped, 0);
		assert.deepEqual(res.errors, []);
		assert.equal(requirements.length, 3, "saveRequirement chiamato 3 volte");
		assert.equal(decisions.length, 2, "saveDecision chiamato 2 volte");
		// Ledger persistito con le chiavi.
		const ledger = await readIngestionLedger(cwd);
		assert.equal(ledger.requirements.length, 3);
		assert.equal(ledger.decisions.length, 2);
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

test("idempotenza: re-run non duplica (0 chiamate, tutto skippato)", async () => {
	const cwd = await createTmpDir();
	try {
		await writePendingJson(cwd, sampleStructured());
		const a = createRecorderAdapters();
		await ingestPendingResearch(cwd, { adapters: a.adapters });
		assert.equal(a.requirements.length, 3);

		// Secondo run sullo stesso albero (ledger già presente).
		const b = createRecorderAdapters();
		const res = await ingestPendingResearch(cwd, { adapters: b.adapters });
		assert.equal(res.requirementsSaved, 0, "re-run non ri-salva i requirement");
		assert.equal(res.decisionsSaved, 0, "re-run non ri-salva le decisioni");
		assert.equal(res.requirementsSkipped, 3, "tutti i requirement già nel ledger");
		assert.equal(res.decisionsSkipped, 2, "tutte le decisioni già nel ledger");
		assert.equal(b.requirements.length, 0, "nessuna nuova chiamata requirement");
		assert.equal(b.decisions.length, 0, "nessuna nuova chiamata decision");
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

test("nessun pending-research.json → no-op, errori vuoti, log diagnostico", async () => {
	const cwd = await createTmpDir();
	try {
		await ensurePendingDir(cwd);
		const { stderr, lines } = createLogSink();
		const res = await ingestPendingResearch(cwd, { stderr });
		assert.equal(res.requirementsSaved, 0);
		assert.equal(res.decisionsSaved, 0);
		assert.deepEqual(res.errors, []);
		assert.ok(
			lines.some((l) => l.includes("no pending-research file")),
			"log diagnostico per file assente",
		);
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

test("adapter fallito → chiave NON committata, errore segnalato, re-run lo ripesca", async () => {
	const cwd = await createTmpDir();
	try {
		await writePendingJson(cwd, sampleStructured());
		let calls = 0;
		const flaky: IngestionAdapters = {
			async saveRequirement() {
				calls++;
				if (calls === 1) throw new Error("boom requirement");
			},
			async saveDecision() {},
		};
		const res = await ingestPendingResearch(cwd, { adapters: flaky });
		assert.equal(res.errors.length, 1, "un errore requirement");
		assert.equal(res.errors[0]?.kind, "requirement");
		assert.equal(res.requirementsSaved, 2, "gli altri 2 requirement salvati");
		assert.equal(res.decisionsSaved, 2);
		const ledger = await readIngestionLedger(cwd);
		assert.equal(ledger.requirements.length, 2, "chiave fallita NON committata");
		// Re-run con adapter che non fallisce: il 3° requirement viene ripescato.
		const ok: IngestionAdapters = {
			async saveRequirement() {},
			async saveDecision() {},
		};
		const res2 = await ingestPendingResearch(cwd, { adapters: ok });
		assert.equal(res2.requirementsSaved, 1, "il fallito viene salvato al re-run");
		assert.equal(res2.decisionsSaved, 0, "decisioni già committate");
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

test("pending malformato (JSON/version/structured invalidi) → mai throw, no-op", async () => {
	const cwd = await createTmpDir();
	try {
		const dir = await ensurePendingDir(cwd);
		const { stderr } = createLogSink();
		// JSON invalido
		await fs.writeFile(path.join(dir, "pending-research.json"), "not json{", "utf-8");
		const r1 = await ingestPendingResearch(cwd, { stderr });
		assert.equal(r1.requirementsSaved, 0);
		assert.deepEqual(r1.errors, []);
		// version != 1
		await fs.writeFile(path.join(dir, "pending-research.json"), JSON.stringify({ version: 2, structured: {} }), "utf-8");
		const r2 = await ingestPendingResearch(cwd, { stderr });
		assert.equal(r2.requirementsSaved, 0);
		// structured assente
		await fs.writeFile(path.join(dir, "pending-research.json"), JSON.stringify({ version: 1 }), "utf-8");
		const r3 = await ingestPendingResearch(cwd, { stderr });
		assert.equal(r3.requirementsSaved, 0);
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

test("buildIngestionPlan mappa requirement e decision nello shape stabile", () => {
	const plan = buildIngestionPlan(sampleStructured());
	assert.equal(plan.requirements.length, 3);
	assert.deepEqual(plan.requirements[0], {
		id: "R1",
		title: "Coordination file parsa research_decision_format",
		description: "Blocco versionato",
		priority: "must-have",
	});
	assert.equal(plan.requirements[2].id, undefined, "requirement senza id preservato");
	assert.equal(plan.decisions.length, 2);
	assert.equal(plan.decisions[0].rationale, "Coerenza con la slice M008/S04");
	assert.deepEqual(plan.decisions[0].dissent, ["Aggiunge complessita di parsing"]);
	assert.equal(plan.decisions[1].rationale, "Re-run non duplica");
	assert.ok(plan.decisions[1].dissent === undefined, "dissent opzionale assente");
});

test("createFileOutboxAdapters: adapter di default accoda intent su outbox (3 req + 2 dec)", async () => {
	const cwd = await createTmpDir();
	try {
		await writePendingJson(cwd, sampleStructured());
		const res = await ingestPendingResearch(cwd);
		const outbox = path.join(cwd, ".gsd", "discussion-arena", "ingestion-outbox.jsonl");
		const raw = await fs.readFile(outbox, "utf-8");
		const records = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
		assert.equal(records.filter((r) => r.kind === "requirement_save").length, 3);
		assert.equal(records.filter((r) => r.kind === "decision_save").length, 2);
		assert.equal(res.requirementsSaved, 3);
		assert.equal(res.decisionsSaved, 2);
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

test("clearIngestionLedger azzera il registro; il refresh permette di re-ingerire", async () => {
	const cwd = await createTmpDir();
	try {
		await writePendingJson(cwd, sampleStructured());
		const a = createRecorderAdapters();
		await ingestPendingResearch(cwd, { adapters: a.adapters });
		assert.equal(a.requirements.length, 3);
		const { removed } = await clearIngestionLedger(cwd);
		assert.equal(removed, true);
		const ledger = await readIngestionLedger(cwd);
		assert.equal(ledger.requirements.length, 0);
		// Clear → re-run ripesca tutto (nessun duplicato, ma ri-propagato).
		const b = createRecorderAdapters();
		const res = await ingestPendingResearch(cwd, { adapters: b.adapters });
		assert.equal(res.requirementsSaved, 3);
		assert.equal(b.requirements.length, 3);
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

test("isIngestionEnabled: opt-in solo se enabled === true", () => {
	assert.equal(isIngestionEnabled({ rolesVirtuals: {}, ingestion: { enabled: true } }), true);
	assert.equal(isIngestionEnabled({ rolesVirtuals: {} }), false);
	assert.equal(isIngestionEnabled({ rolesVirtuals: {}, ingestion: {} }), false);
	assert.equal(isIngestionEnabled({ rolesVirtuals: {}, ingestion: { enabled: false } }), false);
});

test("attachIngestionHooks: milestone_end con ingestion disabilitata → no-op (nessuna voce)", async () => {
	const cwd = await createTmpDir();
	try {
		await writePendingJson(cwd, sampleStructured());
		const coordDir = await ensurePendingDir(cwd);
		await fs.writeFile(
			path.join(coordDir, "discussion-arena-coordination.md"),
			"---\ningestion:\n  enabled: false\n---\n",
			"utf-8",
		);
		const adapters = createRecorderAdapters();
		const handlers = new Map<string, (p: Record<string, unknown>) => void>();
		const api = {
			on: (e: string, h: (p: Record<string, unknown>) => void) => {
				handlers.set(e, h);
				return undefined;
			},
		};
		attachIngestionHooks(api as never, { adapters: adapters.adapters });
		handlers.get("milestone_end")?.({ type: "milestone_end", cwd, status: "completed" });
		// attende che l'async interno comprenda (no-op su disabled)
		await new Promise((r) => setTimeout(r, 40));
		assert.equal(adapters.requirements.length, 0, "disabled → nessun save");
		const ledger = await readIngestionLedger(cwd);
		assert.equal(ledger.requirements.length, 0, "ledger vuoto");
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

test("attachIngestionHooks: milestone_end con ingestion.enabled → ingest eseguito", async () => {
	const cwd = await createTmpDir();
	try {
		await writePendingJson(cwd, sampleStructured());
		const coordDir = await ensurePendingDir(cwd);
		await fs.writeFile(
			path.join(coordDir, "discussion-arena-coordination.md"),
			"---\ningestion:\n  enabled: true\n---\n",
			"utf-8",
		);
		const adapters = createRecorderAdapters();
		const handlers = new Map<string, (p: Record<string, unknown>) => void>();
		const api = {
			on: (e: string, h: (p: Record<string, unknown>) => void) => {
				handlers.set(e, h);
				return undefined;
			},
		};
		attachIngestionHooks(api as never, { adapters: adapters.adapters });
		handlers.get("milestone_end")?.({ type: "milestone_end", cwd, status: "completed" });
		await waitFor(async () => adapters.requirements.length === 3);
		assert.equal(adapters.requirements.length, 3, "ingest 3 requirement su milestone_end");
		assert.equal(adapters.decisions.length, 2, "ingest 2 decisioni su milestone_end");
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

/** Attende fino a `timeoutMs` che `cond` diventi true (polling). */
async function waitFor(cond: () => Promise<boolean> | boolean, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (await cond()) return;
		await new Promise((r) => setTimeout(r, 10));
	}
	throw new Error(`waitFor: condizione mai vera entro ${timeoutMs}ms`);
}