#!/usr/bin/env node
/**
 * scripts/check-links.mjs — link-checker markdown locale, zero dipendenze.
 *
 * Milestone M006 / S01 (T01). Verifica che ogni link interno dei documenti
 * markdown del repo risolva a un file esistente. Solo stdlib (node:fs,
 * node:path, node:url): nessuna dipendenza npm (D004).
 *
 * Contratto osservabile (leggibile da umano e da CI senza parsing):
 *   - una riga `file:riga: target` su stdout per ogni link locale rotto;
 *   - una riga riassuntiva `checked N local link(s) across M file(s):
 *     K ok, B broken (S skipped: external or anchor)`;
 *   - exit code 0 se nessun link locale è rotto, 1 se almeno uno lo è,
 *     2 per errori d'uso o I/O (root inesistente, file illeggibile,
 *     corpus senza file markdown).
 *
 * Regole di scansione:
 *   - cammina ricorsivamente da <root> (default: cwd) su tutti i file
 *     `*.md`, escludendo: directory nascoste (nome che inizia con "." —
 *     copre .git, .gsd*, .agents, .claude, .vscode, .github), le directory
 *     vendored `node_modules/` e `vendor/`, e il file
 *     `docs/discussion-arena-deliberation-archive.md` (archivio deliberativo
 *     locale, fuori dalla navigazione documentale, D069).
 *   - estrae i link inline `[text](target)` (incluse le immagini
 *     `![alt](target)`) e gli autolink `[...]` bare solo quando il contenuto
 *     ha uno schema URI (http:, mailto:, ...) o un'estensione documentale
 *     (.md, .markdown, .mdx, .txt, .html) — i tag HTML tipo `<cwd>` o
 *     `<kbd>` non vengono trattati come link;
 *   - il contenuto dentro i code fence (``` o ~~~) non viene ispezionato;
 *   - per ogni target locale: un eventuale fragment `#...` viene rimosso
 *     prima del resolve, poi il path viene risolto rispetto alla directory
 *     del file sorgente e verificato con fs.existsSync (funziona anche per
 *     target che puntano a directory);
 *   - i target esterni (schemi URI, `//host`, `/abs`, `C:\...`) e le ancora
 *     (`#sezione`) vengono contati come skipped e non verificati;
 *   - limite noto: i symlink a directory non vengono seguiti (un link a
 *     una directory symlinkata non viene attraversato), e i link
 *     root-relativi (`/docs/foo.md`) non vengono verificati.
 *
 * Uso:
 *   node scripts/check-links.mjs [root]
 *
 * Esporta anche le funzioni `collectMarkdownFiles` e `checkLinks` per i test
 * (tests/check-links.test.ts) senza eseguire il CLI (guard su import.meta.url).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** Directory vendored o di terze parti escluse dalla scansione (non nascoste). */
const EXCLUDED_DIRS = new Set(["node_modules", "vendor"]);

/** Link inline `[text](target)` e immagini `![alt](target)`. */
const INLINE_LINK_RE = /!?\[([^\]]*)\]\(([^)]+)\)/g;

/** Autolink bare `<...>`: solo schemi URI o estensioni documentali. */
const AUTOLINK_RE = /<([^<>]+)>/g;

/** Estensioni trattate come risorse documentali negli autolink. */
const DOC_EXT_RE = /\.(md|markdown|mdx|txt|html?)$/i;

/** Schema URI generico (`http:`, `mailto:`, `file:`, anche `C:\`). */
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

/** Titolo opzionale markdown: `[text](target "titolo")`. */
const TITLE_RE = /^(.*?)\s+"[^"]*"$/;

/**
 * Enumera ricorsivamente i file `*.md` sotto `root`, applicando le esclusioni
 * documentate in testa al modulo. Ritorna path assoluti ordinati.
 */
export function collectMarkdownFiles(root) {
	const resolvedRoot = path.resolve(root);
	const excludedArchive = path.join(resolvedRoot, "docs", "discussion-arena-deliberation-archive.md");
	const files = [];

	const walk = (dir) => {
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch (err) {
			throw new Error(`cannot read directory ${dir}: ${err.message}`);
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name.startsWith(".") || EXCLUDED_DIRS.has(entry.name)) continue;
				walk(full);
			} else if (entry.isFile() && entry.name.endsWith(".md")) {
				if (path.resolve(full) === excludedArchive) continue;
				files.push(full);
			}
		}
	};

	walk(resolvedRoot);
	return files.sort();
}

/**
 * Estrae i target dei link presenti in una riga di markdown.
 * Ritorna un array di stringhe (target grezzi, senza classificazione).
 */
export function extractTargets(line) {
	const targets = [];
	for (const match of line.matchAll(INLINE_LINK_RE)) {
		let target = match[2].trim();
		const title = target.match(TITLE_RE);
		if (title) target = title[1].trim();
		if (target) targets.push(target);
	}
	for (const match of line.matchAll(AUTOLINK_RE)) {
		const target = match[1].trim();
		if (SCHEME_RE.test(target) || DOC_EXT_RE.test(target)) targets.push(target);
	}
	return targets;
}

/**
 * Classifica un target grezzo: `local` (verificabile sul filesystem),
 * `external` (schema URI, path assoluto o protocol-relative) o `anchor`.
 */
export function classifyTarget(target) {
	if (SCHEME_RE.test(target) || target.startsWith("//") || target.startsWith("/")) return "external";
	if (target.startsWith("#")) return "anchor";
	return "local";
}

/**
 * Verifica tutti i link locali dei file markdown sotto `root`.
 *
 * Ritorna:
 *   - `files`: path assoluti dei file markdown scansionati;
 *   - `links`: dettaglio per ogni link estratto
 *       { file, line, target, kind: local|external|anchor, ok, resolved };
 *   - `localTotal` / `okCount` / `brokenCount` / `skippedCount`;
 *   - `broken`: sottoinsieme dei link locali non risolti, ordinati per
 *     (file, riga) per un output deterministico.
 *
 * Lancia Error per errori I/O (root o file illeggibili) o se il corpus
 * non contiene file markdown.
 */
export function checkLinks(root) {
	const files = collectMarkdownFiles(root);
	if (files.length === 0) {
		throw new Error(`no markdown files found under ${path.resolve(root)}`);
	}

	const links = [];
	for (const file of files) {
		let content;
		try {
			content = fs.readFileSync(file, "utf8");
		} catch (err) {
			throw new Error(`cannot read ${file}: ${err.message}`);
		}
		const lines = content.split(/\r?\n/);
		let inFence = false;
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (/^\s*(```|~~~)/.test(line)) {
				inFence = !inFence;
				continue;
			}
			if (inFence) continue;
			for (const target of extractTargets(line)) {
				const kind = classifyTarget(target);
				if (kind !== "local") {
					links.push({ file, line: i + 1, target, kind, ok: null, resolved: null });
					continue;
				}
				const fragmentIndex = target.indexOf("#");
				const pathPart = fragmentIndex >= 0 ? target.slice(0, fragmentIndex) : target;
				const resolved = path.resolve(path.dirname(file), pathPart);
				const ok = fs.existsSync(resolved);
				links.push({ file, line: i + 1, target, kind, ok, resolved });
			}
		}
	}

	const local = links.filter((link) => link.kind === "local");
	const broken = local
		.filter((link) => !link.ok)
		.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));

	return {
		root: path.resolve(root),
		files,
		links,
		localTotal: local.length,
		okCount: local.length - broken.length,
		brokenCount: broken.length,
		skippedCount: links.length - local.length,
		broken,
	};
}

/** Entry point CLI: `node scripts/check-links.mjs [root]`. */
function main() {
	const root = process.argv[2] ?? process.cwd();
	let result;
	try {
		result = checkLinks(root);
	} catch (err) {
		console.error(`check-links: ${err.message}`);
		process.exit(2);
	}

	const rel = (p) => path.relative(result.root, p) || path.basename(p);
	for (const link of result.broken) {
		console.log(`${rel(link.file)}:${link.line}: ${link.target}`);
	}
	const fileNoun = result.files.length === 1 ? "file" : "files";
	const linkNoun = result.localTotal === 1 ? "link" : "links";
	console.log(
		`checked ${result.localTotal} local ${linkNoun} across ${result.files.length} ${fileNoun}: ` +
			`${result.okCount} ok, ${result.brokenCount} broken (${result.skippedCount} skipped: external or anchor)`,
	);
	if (result.brokenCount > 0) process.exit(1);
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	main();
}
