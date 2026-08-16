/**
 * Test di shape del file `examples/participants/scribe.example.md` (S06/T01).
 *
 * Contratto: l'esempio è un copy realistico del participant bundled `Scribe`
 * ed è consumato dal loader di produzione `discoverParticipants`. Mentre
 * `tests/examples-validation.test.ts` dimostra che il file viene realemente
 * caricato da quel loader (via symlink, come l'examples-dir di un progetto),
 * questa suite isola le proprietà strutturali del file (double belt:
 * loader works + content conforms).
 *
 * Le asserzioni vivono QUI dentro, non nei verify command — policy
 * GSD pre-execution gate W-8a709f07. Nessuna dipendenza npm: solo node:test,
 * node:assert e fs. Nessun sideload di ~/.pi/agent: il test legge il file
 * reale dell'esempio via URL relativo al modulo.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

const SCRIBE_EXAMPLE = fileURLToPath(
	new URL("../examples/participants/scribe.example.md", import.meta.url),
);

function readExample(): string {
	return fs.readFileSync(SCRIBE_EXAMPLE, "utf8");
}

test("scribe example: frontmatter YAML delimitato da --- e campo name: scribe", () => {
	const content = readExample();
	const match = content.match(/^---\n([\s\S]*?)\n---\n/);
	assert.ok(match, "il file deve aprire con un frontmatter delimitato da ---");
	const fm = match![1]!;
	assert.match(fm, /^name:\s*scribe\s*$/m);
});

test("scribe example: campi frontmatter obbligatori (role, description, tools, model)", () => {
	const content = readExample();
	const match = content.match(/^---\n([\s\S]*?)\n---\n/);
	assert.ok(match, "frontmatter presente");
	const fm = match![1]!;
	assert.match(fm, /^role:\s*Scribe\s*$/m);
	assert.match(fm, /^description:\s*\S/m);
	assert.match(
		fm,
		/^tools:\s*[a-z]+(?:\s*,\s*[a-z]+)*\s*$/m,
		"tools deve essere una lista separata da virgole di nomi di tool",
	);
	assert.match(fm, /^model:\s*[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+\s*$/m);
});

test("scribe example: modello minimax/minimax-m3 (forma provider-id usata dagli esempi)", () => {
	const content = readExample();
	assert.match(content, /^model:\s*minimax\/minimax-m3\s*$/m);
});

test("scribe example: systemPrompt istruisce le tre sezioni markdown obbligatorie", () => {
	const content = readExample();
	assert.match(content, /## Ipotesi/, "sezione Ipotesi obbligatoria");
	assert.match(content, /## Decisioni/, "sezione Decisioni obbligatoria");
	assert.match(content, /## Requisiti/, "sezione Requisiti obbligatoria");
});

test("scribe example: sub-label Razionale e Dissenso per le Decisioni", () => {
	const content = readExample();
	assert.match(content, /- Razionale:/, "sub-bullet Razionale presente");
	assert.match(content, /- Dissenso:/, "sub-bullet Dissenso presente");
});

test("scribe example: sub-label Descrizione e Priorità per i Requisiti", () => {
	const content = readExample();
	assert.match(content, /- Descrizione:/, "sub-bullet Descrizione presente");
	assert.match(content, /- Priorità:/, "sub-bullet Priorità presente");
});

test("scribe example: priorità inline must-have/should-have/could-have", () => {
	const content = readExample();
	assert.match(
		content,
		/\(\s*(must-have|should-have|could-have)\s*\)/,
		"almeno una priorità inline tra parentesi",
	);
});

test("scribe example: esempio di id requisito R<N> o REQ-N presente", () => {
	const content = readExample();
	assert.match(content, /\*\*R[0-9]+\*\*|\bR[0-9]+\b|\bREQ-[0-9]+\b/);
});

test("scribe example: assenza dei 5 limiti opzionali (zero bounds)", () => {
	const content = readExample();
	// I limiti per-participante sono opzionali: questo esempio realistico NON
	// deve dichiararli (come il bundled architect). Quando assenti, la
	// discussion-arena applica i defaults. Regex letterali statiche: niente
	// pattern runtime (evita false ReDoS e mantiene la guardia deterministic).
	const limitFieldRes = [
		["round_timeout_ms", /^round_timeout_ms:/m],
		["event_timeout_ms", /^event_timeout_ms:/m],
		["output_limit_chars", /^output_limit_chars:/m],
		["cost_budget_usd", /^cost_budget_usd:/m],
		["termination", /^termination:/m],
	] as const;
	for (const [field, re] of limitFieldRes) {
		assert.doesNotMatch(
			content,
			re,
			`il campo ${field} non deve comparire nel frontmatter`,
		);
	}
});

test("scribe example: sezione 'Come usare questo esempio' autodocumenta l'install", () => {
	const content = readExample();
	assert.match(
		content,
		/## Come usare questo esempio/,
		"la guida all'install deve essere presente",
	);
	assert.match(
		content,
		/\.gsd\/discussion-arena\/participants\/scribe\.md/,
		"deve indicare il path di destinazione per-progetto",
	);
});