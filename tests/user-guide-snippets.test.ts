/**
 * Harness di validazione snippet della user guide (M006/S02/T01).
 *
 * Contratto eseguibile (Proof by production parser, non by prose): ogni fence
 * ```yaml delle pagine `docs/user-guide/` è un blocco `discussion_arena:`
 * copiabile, e come tale viene passato al parser di produzione
 * `parseDiscussionArenaBlock` (src/parse-discussion-arena-block.ts) in
 * strict:true — la stessa funzione che il writer usa per i file di override.
 * Se anche un solo snippet è sbagliato, la guida mente sull'API e questo test
 * fallisce nominando il file e la chiave offending.
 *
 * Convenzione dei fence (per le pagine della user guide):
 *   - ```yaml          → blocco `discussion_arena:` VALIDO: deve parsare
 *                        strict:true senza sollevare DiscussionArenaParseError;
 *   - ```yaml-invalid  → blocco deliberatamente MALFORMATO: deve sollevare
 *                        DiscussionArenaParseError con key/indent esattamente
 *                        quelli registrati in EXPECTED_PARSE_ERRORS per la
 *                        pagina (è il contratto della sezione troubleshooting);
 *   - ogni altro tag (bash, text, markdown, ...) → ignorato.
 *
 * Regole per gli autori delle pagine:
 *   - un fence ```yaml deve contenere il marcatore di root `discussion_arena:`
 *     a colonna 0: l'estrazione replica parsePreferences (trigger-resolver.ts)
 *     — la root apre la sezione, le righe indentate vengono raccolte, una riga
 *     a colonna 0 non vuota la chiude;
 *   - niente commenti inline dopo i valori (`enabled: true # comment` non
 *     matcha il pattern e strict:true lo rifiuta): i commenti vanno su righe
 *     proprie, con `#` indentato come la chiave;
 *   - un fence ```yaml-invalid senza registrazione in EXPECTED_PARSE_ERRORS
 *     fa fallire il test: la registrazione è il contratto che lega la pagina
 *     al comportamento reale del parser, e la stessa key deve comparire nella
 *     prosa della pagina.
 *
 * Nessuna dipendenza npm: solo node:test e il parser di produzione reale
 * (D004). Un caso di test per pagina, con il nome del file nel messaggio:
 * un fence rotto identifica la pagina senza bisecare.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	DiscussionArenaParseError,
	parseDiscussionArenaBlock,
} from "../src/parse-discussion-arena-block.js";

const USER_GUIDE_DIR = fileURLToPath(new URL("../docs/user-guide", import.meta.url));

const ROOT_MARKER_RE = /^discussion_arena:\s*$/;
const ROOT_MARKER_COMMENT_RE = /^discussion_arena:\s*#/;
const FENCE_RE = /^\s*(```|~~~)\s*([^\s`]*)/;

/**
 * Registro degli snippet deliberatamente malformati: basename della pagina →
 * errori attesi (key e indent) per ogni fence ```yaml-invalid presente.
 * La stessa key deve essere documentata nella prosa della pagina.
 */
const EXPECTED_PARSE_ERRORS: Record<string, Array<{ key: string; indent: number }>> = {
	// Esempio per la sezione troubleshooting (aggiunta in S02/T05):
	// "troubleshooting.md": [{ key: "bogus_key", indent: 2 }],
};

interface SnippetFence {
	tag: string;
	startLine: number;
	lines: string[];
}

/** Estrae i code fence (``` o ~~~) con language tag e righe del corpo. */
function extractFences(content: string): SnippetFence[] {
	const lines = content.split(/\r?\n/);
	const fences: SnippetFence[] = [];
	let inFence = false;
	let tag = "";
	let startLine = 0;
	let body: string[] = [];

	for (let i = 0; i < lines.length; i++) {
		const m = lines[i]!.match(FENCE_RE);
		if (m) {
			if (!inFence) {
				inFence = true;
				tag = m[2] ?? "";
				startLine = i + 1;
				body = [];
			} else {
				fences.push({ tag, startLine, lines: body });
				inFence = false;
			}
			continue;
		}
		if (inFence) body.push(lines[i]!);
	}
	// Fence non chiuso a fine file: viene comunque validato, mai silenzioso.
	if (inFence) fences.push({ tag, startLine, lines: body });
	return fences;
}

/**
 * Estrae le righe del blocco `discussion_arena:` da un fence, replicando
 * parsePreferences (trigger-resolver.ts): la root apre la sezione, le righe
 * indentate vengono raccolte, una riga a colonna 0 non vuota la chiude.
 */
function extractDiscussionArenaBody(fence: SnippetFence): string[] {
	const body: string[] = [];
	let inSection = false;
	for (const line of fence.lines) {
		if (ROOT_MARKER_RE.test(line) || ROOT_MARKER_COMMENT_RE.test(line)) {
			inSection = true;
			continue;
		}
		if (!inSection) continue;
		if (/^\S/.test(line)) break; // chiave a colonna 0: fine del blocco
		if (line.trim()) body.push(line);
	}
	return body;
}

/** Enumera le pagine `.md` della user guide (ordine deterministico). */
function userGuidePages(): string[] {
	return fs
		.readdirSync(USER_GUIDE_DIR)
		.filter((name) => name.endsWith(".md"))
		.sort();
}

for (const page of userGuidePages()) {
	test(`user-guide snippet fences in ${page} match the production parser contract`, () => {
		const content = fs.readFileSync(path.join(USER_GUIDE_DIR, page), "utf8");
		const fences = extractFences(content);
		const valid = fences.filter((f) => f.tag === "yaml");
		const invalid = fences.filter((f) => f.tag === "yaml-invalid");
		const expected = EXPECTED_PARSE_ERRORS[page] ?? [];

		for (const fence of valid) {
			const where = `${page}:${fence.startLine}`;
			assert.ok(
				fence.lines.some((line) => /^discussion_arena:/.test(line.trim())),
				`${where}: fence yaml senza il marcatore di root "discussion_arena:" — i fence yaml delle pagine user-guide sono blocchi discussion_arena per contratto (usa un altro tag per altro YAML)`,
			);
			const body = extractDiscussionArenaBody(fence);
			assert.ok(
				body.length > 0,
				`${where}: blocco discussion_arena vuoto dopo l'estrazione`,
			);
			assert.doesNotThrow(
				() => parseDiscussionArenaBlock(body, { strict: true }),
				`${where}: lo snippet yaml non passa parseDiscussionArenaBlock strict:true`,
			);
		}

		assert.equal(
			invalid.length,
			expected.length,
			`${page}: ${invalid.length} fence yaml-invalid ma ${expected.length} registrazione/i in EXPECTED_PARSE_ERRORS — registra la key attesa per ogni snippet malformato`,
		);
		for (let i = 0; i < invalid.length; i++) {
			const fence = invalid[i]!;
			const exp = expected[i]!;
			const where = `${page}:${fence.startLine}`;
			const body = extractDiscussionArenaBody(fence);
			assert.throws(
				() => parseDiscussionArenaBlock(body, { strict: true }),
				(err) => {
					if (!(err instanceof DiscussionArenaParseError)) return false;
					assert.strictEqual(
						err.key,
						exp.key,
						`${where}: chiave offending diversa da quella documentata (attesa "${exp.key}", trovata "${err.key}")`,
					);
					assert.strictEqual(
						err.indent,
						exp.indent,
						`${where}: indent della chiave offending diverso da quello documentato (atteso ${exp.indent}, trovato ${err.indent})`,
					);
					return true;
				},
				`${where}: lo snippet yaml-invalid non solleva DiscussionArenaParseError in strict:true`,
			);
		}
	});
}

test("guardia: configuration.md e configuration.it.md contengono almeno un fence yaml ciascuno", () => {
	for (const page of ["configuration.md", "configuration.it.md"]) {
		const content = fs.readFileSync(path.join(USER_GUIDE_DIR, page), "utf8");
		const fences = extractFences(content);
		assert.ok(
			fences.some((f) => f.tag === "yaml"),
			`${page} deve contenere almeno un fence yaml validato dall'harness, altrimenti la pagina non è ancorata al parser di produzione`,
		);
	}
});
