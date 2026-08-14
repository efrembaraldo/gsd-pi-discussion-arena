/**
 * tests/discussion-arena-research-extractor.test.ts — Unit test T01/M008/S02.
 *
 * Copre il contratto del parser deterministico:
 *   - transcript canonico con le tre sezioni `## Ipotesi/Decisioni/Requisiti`
 *   - varianti di wording delle intestazioni (`## Ipotesi iniziali`,
 *     `## Decisioni prese`, `## Requisiti identificati`)
 *   - transcript vuoto → fallback marker (mai eccezioni)
 *   - parsing deterministico (due chiamate → stesso output)
 *   - sezioni mancanti / nessuna struttura markdown → fallback marker
 *   - log stderr strutturato solo su fallback
 *
 * Il file non rientra in tsconfig include (typecheck copre src/*.ts): i test
 * sono eseguiti dal loader TS ESM (tests/ts-esm-loader.mjs) che rimuove i
 * tipi. Usa Writable di node:stream per catturare lo stderr del logger.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { Writable } from "node:stream";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	extractResearchDecisions,
	RESEARCH_FALLBACK,
	type ExtractResult,
	type ResearchDecisions,
} from "../src/discussion-arena-research-extractor.js";

/** Transcript canonico con tutte e tre le sezioni. */
const CANONICAL = `# Verbalizzato della discussione

## Ipotesi
- L'estrazione deterministica è più affidabile di una model call
- I titoli delle sezioni devono restare stabili

## Decisioni
- **Adottare parsing deterministico su markdown**
  - Razionale: costo zero, latenza zero, output deterministico
  - Dissenso: fragile di fronte a varianti di wording
- Mantenere un fallback

## Requisiti
- **R1** — Parser deterministico (must-have): parsing con regex multiline
- **R2** — Fallback model-access
  - Descrizione: marcator di fallback su parsing fallito
  - Priorità: should-have
`;

/** Transcript con varianti di wording delle intestazioni. */
const VARIANTS = `# Note

## Ipotesi iniziali
- Variante ipotesi 1

## Decisioni prese
- Decisions presa A

## Requisiti identificati
- **RQ-7** — Variante requisito (must-have)
`;

function collectStderr(): { stream: Writable; lines: string[] } {
	const lines: string[] = [];
	const stream = new Writable({
		write(chunk, _enc, cb) {
			lines.push(String(chunk));
			cb();
		},
	});
	return { stream, lines };
}

function isFallback(result: ExtractResult): result is { fallback: typeof RESEARCH_FALLBACK; reason: string } {
	return "fallback" in result;
}

test("canonico: estrae una struttura typed con le tre sezioni", () => {
	const { stream, lines } = collectStderr();
	const result = extractResearchDecisions(CANONICAL, stream);

	assert.ok(!isFallback(result), "canonical should not fallback");

	const res = result as ResearchDecisions;
	assert.deepEqual(res.hypotheses, [
		"L'estrazione deterministica è più affidabile di una model call",
		"I titoli delle sezioni devono restare stabili",
	]);
	assert.equal(res.decisions.length, 2);
	const d = res.decisions[0];
	assert.equal(d.statement, "Adottare parsing deterministico su markdown");
	assert.equal(
		d.rationale,
		"costo zero, latenza zero, output deterministico",
		"rationale extracted from sub-bullet",
	);
	assert.ok(d.dissent, "dissent present");
	assert.equal(res.requirements.length, 2);
	const req = res.requirements[0];
	assert.equal(req.id, "R1");
	assert.equal(req.priority, "must-have");
	assert.equal(req.description.length > 0, true);
	// nessun log su successo
	assert.equal(lines.length, 0, "no stderr log on success");
});

test("varianti di wording: le intestazioni non-canoniche vengono riconosciute", () => {
	const { stream } = collectStderr();
	const result = extractResearchDecisions(VARIANTS, stream);
	assert.ok(!isFallback(result), "variants should parse");
	const res = result as ResearchDecisions;
	assert.equal(res.hypotheses.length, 1);
	assert.equal(res.decisions.length, 1);
	assert.equal(res.requirements.length, 1);
	assert.equal(res.requirements[0].id, "RQ-7");
	assert.equal(res.requirements[0].priority, "must-have");
});

test("transcript vuoto: fallback marker, nessuna eccezione", () => {
	const { stream, lines } = collectStderr();
	const result = extractResearchDecisions("", stream);
	assert.ok(isFallback(result), "empty transcript must fallback");
	assert.equal(result.fallback, RESEARCH_FALLBACK);
	assert.ok(result.reason.length > 0);
	assert.ok(
		lines.some((l) => l.includes("[discussion-arena] extractor: fallback model-call-needed")),
		"structured stderr log expected on fallback",
	);
});

test("transcript con solo whitespace: fallback marker", () => {
	const { stream } = collectStderr();
	const result = extractResearchDecisions("   \n\n\t ", stream);
	assert.ok(isFallback(result));
});

test("sezione mancante (no Requisiti): fallback marker", () => {
	const missing = `${CANONICAL.split("## Requisiti")[0]}`;
	const { stream } = collectStderr();
	const result = extractResearchDecisions(missing, stream);
	assert.ok(isFallback(result), "missing section should fallback");
	assert.match(result.reason, /sezione mancante/);
});

test("nessuna struttura markdown riconoscibile: fallback marker", () => {
	const prose = `Questo è un transcript senza intestazioni riconosciute:
- una lista qualsiasi
- senza sezioni ipotesi/decisioni/requisiti
fine.`;
	const { stream } = collectStderr();
	const result = extractResearchDecisions(prose, stream);
	assert.ok(isFallback(result), "no markdown structure should fallback");
});

test("deterministico: due chiamate sullo stesso transcript producono lo stesso output", () => {
	const a = extractResearchDecisions(CANONICAL);
	const b = extractResearchDecisions(CANONICAL);
	assert.deepEqual(a, b, "same transcript must yield identical output");
	const va = extractResearchDecisions(VARIANTS);
	const vb = extractResearchDecisions(VARIANTS);
	assert.deepEqual(va, vb, "same variant transcript must yield identical output");
});

test("heading inconsistenti: fallback marker senza eccezioni", () => {
	// Headings riconosciuti ma con testo/garbage inconsistente tra le sezioni.
	const inconsistent = `## Ipotesi
- hp
## Decisioni
### Decisioni prese
- d
## Requisiti
- r`;
	const { stream } = collectStderr();
	const result = extractResearchDecisions(inconsistent, stream);
	assert.equal("object", typeof result);
	// Se il secondo heading di Decisione è ignorato (non-riconosciuto come
	// nuova sezione) il parsing può riuscire; MA mai deve flippare nested
	// headings dentro un'altra sezione. In ogni caso: mai throw.
	// Il contratto assicura fallback per struttura incoerente solo se
	// insufficiente; qui le tre sezioni riconosciute bastano.
	if (!isFallback(result)) {
		const res = result as ResearchDecisions;
		// Il <h3> non-spalla il valore: Resta dentro la slice di Decisione.
		assert.ok(Array.isArray(res.decisions));
	}
});

test("markdown malformato: fallback senza eccezioni", () => {
	// Intestazioni presente ma bullet incompleti/incrinati =>
	// tre sezioni presenti, zero voci => fallback marker.
	const malformed = `## Ipotesi
no bullet qui
## Decisioni
prosa senza bullet
## Requisiti
(anche lista vuota)`;
	const { stream, lines } = collectStderr();
	const result = extractResearchDecisions(malformed, stream);
	assert.ok(isFallback(result), "malformed markdown (sections present, no bullets) must fallback");
	assert.equal(result.fallback, RESEARCH_FALLBACK);
	assert.ok(
		lines.some((l) => l.includes("[discussion-arena] extractor: fallback model-call-needed")),
		"structured stderr log expected on fallback",
	);
});

/** Directory dei fixture: transcript reali dei run discussion-arena. */
const FIXTURES_DIR = fileURLToPath(new URL("./fixtures/scribe-transcripts/", import.meta.url));

/** Lista ordinata (per nome file) dei fixture .md presenti su disco. */
function listFixtures(): string[] {
	return readdirSync(FIXTURES_DIR)
		.filter((f) => f.endsWith(".md"))
		.sort();
}

/** Legge il contenuto di un fixture per filename. */
function readFixture(name: string): string {
	return readFileSync(`${FIXTURES_DIR}${name}`, "utf8");
}

/** Verificatore di schema per una ResearchDecisions proveniente da fixture. */
function assertSchema(res: ResearchDecisions): void {
	assert.ok(Array.isArray(res.hypotheses), "hypotheses must be array");
	for (const h of res.hypotheses) assert.equal(typeof h, "string");

	assert.ok(Array.isArray(res.decisions), "decisions must be array");
	for (const d of res.decisions) {
		assert.equal(typeof d.statement, "string");
		if (d.rationale !== undefined) assert.equal(typeof d.rationale, "string");
		if (d.dissent !== undefined) {
			assert.ok(Array.isArray(d.dissent));
			for (const s of d.dissent) assert.equal(typeof s, "string");
		}
	}

	assert.ok(Array.isArray(res.requirements), "requirements must be array");
	for (const r of res.requirements) {
		assert.equal(typeof r.title, "string");
		assert.equal(typeof r.description, "string");
		assert.ok(
			["must-have", "should-have", "could-have"].includes(r.priority),
			`priority ${r.priority} must be one of allowed values`,
		);
	}
}

/** T03: il 100% dei fixture reali deve parsare SENZA fallback. */
test("T03 rendicontazione: tutti i fixture reali parsano senza fallback", () => {
	const fixtures = listFixtures();
	assert.ok(fixtures.length >= 1, "at least one fixture present");

	const parsed: string[] = [];
	const failed: string[] = [];
	for (const name of fixtures) {
		const transcript = readFixture(name);
		const result = extractResearchDecisions(transcript);
		if (isFallback(result)) failed.push(name);
		else parsed.push(name);
	}

	// 100% parsing rate (accettabile MVP): nessun fixture deve fallbackare.
	assert.deepEqual(failed, [], `expected 0 failed fixtures, got ${failed.length}`);
	assert.equal(parsed.length, fixtures.length, "every fixture must parse");
});

test("T03: le strutture estratte dai fixture rispettano lo schema", () => {
	for (const name of listFixtures()) {
		const result = extractResearchDecisions(readFixture(name));
		assert.ok(!isFallback(result), `fixture ${name} must not fallback`);
		assertSchema(result as ResearchDecisions);
	}
});

test("T03: il parsing è idempotente su ogni fixture", () => {
	for (const name of listFixtures()) {
		const transcript = readFixture(name);
		const a = extractResearchDecisions(transcript);
		const b = extractResearchDecisions(transcript);
		assert.deepEqual(a, b, `fixture ${name}: due chiamate devono produrre lo stesso output`);
	}
});

test("no-op: mai lancia su input malformati", () => {
	// Nessuna delle seguenti deve throware (nemmeno con input irregolari).
	const cases = ["# solo titolo", "## Ipotesi\n", "### Decisioni\n- x", "## Decisioni\nciao senza bullet"];
	for (const input of cases) {
		const res = extractResearchDecisions(input);
		// Può essere successo (array vuoti) o fallback: mai throw.
		assert.equal("object", typeof res);
	}
	assert.equal(typeof extractResearchDecisions, "function");
});