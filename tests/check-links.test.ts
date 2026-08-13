/**
 * Test unitari per scripts/check-links.mjs (M006/S01/T01) — link-checker
 * markdown locale zero-dipendenze.
 *
 * Copertura (fixture temporanee in os.tmpdir, mai path gitignored):
 *   - collectMarkdownFiles: walk ricorsivo, esclusione dir nascoste,
 *     node_modules/vendor e dell'archivio deliberativo (D069);
 *   - checkLinks in-process: link ok, link rotti (file/riga/target),
 *     fragment `#...` rimossi prima del resolve, immagini come link locali,
 *     code fence ignorati, titolo opzionale rimosso, target directory,
 *     link esterni/ancore/autolink saltati, errori I/O propagati;
 *   - contratto CLI via subprocess (l'oggetto osservabile reale del gate):
 *     exit 0 con corpus pulito, exit 1 con `file:riga: target` su stdout
 *     per i rotti, exit 2 con messaggio su stderr per root inesistente o
 *     corpus senza file markdown, exit 0 sul corpus reale del repo.
 */

import { afterEach, test } from "node:test";
import * as assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkLinks, classifyTarget, collectMarkdownFiles, extractTargets } from "../scripts/check-links.mjs";

// ---------------------------------------------------------------------------
// Infra di test
// ---------------------------------------------------------------------------

/** Path assoluto dello script, usato per gli spawn del CLI. */
const SCRIPT_PATH = fileURLToPath(new URL("../scripts/check-links.mjs", import.meta.url));

/** Directory temporanee create dai test; rimosse in afterEach. */
const tmpDirs: string[] = [];

async function makeTmp(prefix: string): Promise<string> {
	const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), prefix));
	tmpDirs.push(dir);
	return dir;
}

/** Scrive un albero di file (rel -> contenuto) sotto root. */
async function writeTree(root: string, files: Record<string, string>): Promise<void> {
	for (const [rel, content] of Object.entries(files)) {
		const p = path.join(root, rel);
		await fsPromises.mkdir(path.dirname(p), { recursive: true });
		await fsPromises.writeFile(p, content, "utf8");
	}
}

/** Spawn del CLI con una root esplicita. */
function runCli(root: string) {
	return spawnSync(process.execPath, [SCRIPT_PATH, root], { encoding: "utf8" });
}

/** Spawn del CLI senza argomenti (root = cwd del processo di test). */
function runCliNoArgs() {
	return spawnSync(process.execPath, [SCRIPT_PATH], { encoding: "utf8" });
}

afterEach(async () => {
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop()!;
		await fsPromises.rm(dir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// collectMarkdownFiles
// ---------------------------------------------------------------------------

test("collectMarkdownFiles: walk ricorsivo con esclusioni (dir nascoste, node_modules, vendor, archivio D069)", async () => {
	const root = await makeTmp("check-links-walk-");
	await writeTree(root, {
		"a.md": "# A",
		"sub/b.md": "# B",
		"sub/deep/c.md": "# C",
		".hidden/d.md": "# D",
		".git/e.md": "# E",
		"node_modules/f.md": "# F",
		"vendor/g.md": "# G",
		"docs/discussion-arena-deliberation-archive.md": "# archive",
		"docs/user-guide/index.md": "# Index",
		"sub/not-markdown.txt": "text",
	});

	const files = collectMarkdownFiles(root);
	const relative = files.map((f) => path.relative(root, f)).sort();
	assert.deepEqual(relative, ["a.md", "docs/user-guide/index.md", "sub/b.md", "sub/deep/c.md"]);
});

test("collectMarkdownFiles: root senza file markdown -> lista vuota", async () => {
	const root = await makeTmp("check-links-empty-");
	await writeTree(root, { "foo.txt": "text" });
	assert.deepEqual(collectMarkdownFiles(root), []);
});

// ---------------------------------------------------------------------------
// extractTargets / classifyTarget (unità di parsing)
// ---------------------------------------------------------------------------

test("extractTargets: estrae link inline, immagini e autolink, ignorando tag HTML", () => {
	assert.deepEqual(extractTargets("[a](b.md) ![img](pic.png)"), ["b.md", "pic.png"]);
	// Autolink: solo schemi URI o estensioni documentali; `<cwd>`, `<kbd>` no.
	assert.deepEqual(extractTargets("vedi <exists.md> e <https://example.com> e <cwd>/x"), [
		"exists.md",
		"https://example.com",
	]);
	// Target vuoto e link senza target non vengono estratti.
	assert.deepEqual(extractTargets("[x]() [y]( )"), []);
});

test("extractTargets: il titolo opzionale viene rimosso dal target", () => {
	assert.deepEqual(extractTargets('[a](target.md "Titolo")'), ["target.md"]);
});

test("classifyTarget: external per schemi URI, path assoluti e protocol-relative; anchor per #", () => {
	assert.equal(classifyTarget("https://example.com/x"), "external");
	assert.equal(classifyTarget("mailto:a@b.c"), "external");
	assert.equal(classifyTarget("C:\\docs\\x.md"), "external");
	assert.equal(classifyTarget("//host/x.md"), "external");
	assert.equal(classifyTarget("/abs/path.md"), "external");
	assert.equal(classifyTarget("#sezione"), "anchor");
	assert.equal(classifyTarget("target.md#sezione"), "local");
	assert.equal(classifyTarget("./target.md"), "local");
	assert.equal(classifyTarget("../target.md"), "local");
});

// ---------------------------------------------------------------------------
// checkLinks in-process
// ---------------------------------------------------------------------------

test("checkLinks: link locale risolto -> ok; rotto -> broken con file, riga e target", async () => {
	const root = await makeTmp("check-links-ok-");
	await writeTree(root, {
		"doc.md": "Intro\n\n[see](target.md)\n\n[missing](nope.md)\n",
		"target.md": "# Target",
	});

	const result = checkLinks(root);
	assert.equal(result.localTotal, 2);
	assert.equal(result.okCount, 1);
	assert.equal(result.brokenCount, 1);

	const broken = result.broken[0];
	assert.ok(broken.file.endsWith(path.join("doc.md")), `unexpected file: ${broken.file}`);
	assert.equal(broken.line, 5);
	assert.equal(broken.target, "nope.md");
	assert.equal(broken.ok, false);
	assert.equal(broken.kind, "local");
});

test("checkLinks: il fragment #... viene rimosso prima del resolve", async () => {
	const root = await makeTmp("check-links-frag-");
	await writeTree(root, {
		"doc.md": "[a](target.md#sec) [b](missing.md#sec)\n",
		"target.md": "# Target",
	});

	const result = checkLinks(root);
	assert.equal(result.okCount, 1);
	assert.equal(result.brokenCount, 1);
	assert.equal(result.broken[0].target, "missing.md#sec");
});

test("checkLinks: le immagini sono controllate come link locali", async () => {
	const root = await makeTmp("check-links-img-");
	await writeTree(root, {
		"doc.md": "![ok](pic.png) ![ko](no.png)\n",
		"pic.png": "not really an image, but exists",
	});

	const result = checkLinks(root);
	assert.equal(result.okCount, 1);
	assert.equal(result.brokenCount, 1);
	assert.equal(result.broken[0].target, "no.png");
});

test("checkLinks: il contenuto dentro i code fence non viene ispezionato", async () => {
	const root = await makeTmp("check-links-fence-");
	await writeTree(root, {
		"doc.md": "```\n[finto](fake-inside.md)\n```\n\n[finto](fake-outside.md)\n",
	});

	const result = checkLinks(root);
	assert.equal(result.brokenCount, 1);
	assert.equal(result.broken[0].target, "fake-outside.md");
	assert.equal(result.broken[0].line, 5);
});

test("checkLinks: link esterni, ancore, autolink e target vuoti vengono saltati", async () => {
	const root = await makeTmp("check-links-skip-");
	await writeTree(root, {
		"doc.md": "[ext](https://example.com/x) [anchor](#sec) <https://example.com> [mail](mailto:a@b.c) [x]()\n",
	});

	const result = checkLinks(root);
	assert.equal(result.localTotal, 0);
	assert.equal(result.brokenCount, 0);
	assert.equal(result.skippedCount, 4);
	assert.equal(result.links.length, 4);
	assert.ok(result.links.every((l) => l.kind !== "local"));
});

test("checkLinks: un target che punta a una directory risolve", async () => {
	const root = await makeTmp("check-links-dir-");
	await writeTree(root, {
		"doc.md": "[docs](sub/)\n",
		"sub/keep.txt": "x",
	});

	const result = checkLinks(root);
	assert.equal(result.okCount, 1);
	assert.equal(result.brokenCount, 0);
});

test("checkLinks: link relativi con risalita ../ risolvono rispetto alla dir del sorgente", async () => {
	const root = await makeTmp("check-links-up-");
	await writeTree(root, {
		"docs/user-guide/index.md": "[root](../../README.md)\n",
		"README.md": "# Root",
	});

	const result = checkLinks(root);
	assert.equal(result.okCount, 1);
	assert.equal(result.brokenCount, 0);
});

test("checkLinks: root inesistente -> Error con messaggio", async () => {
	const missing = path.join(os.tmpdir(), "check-links-no-such-dir");
	assert.throws(() => checkLinks(missing), /cannot read directory/);
});

test("checkLinks: corpus senza file markdown -> Error", async () => {
	const root = await makeTmp("check-links-nomd-");
	await writeTree(root, { "foo.txt": "text" });
	assert.throws(() => checkLinks(root), /no markdown files found/);
});

// ---------------------------------------------------------------------------
// Contratto CLI (subprocess): exit code e formato output
// ---------------------------------------------------------------------------

test("CLI: exit 0 con riepilogo su corpus pulito", async () => {
	const root = await makeTmp("check-links-cli-ok-");
	await writeTree(root, {
		"a.md": "[see](b.md)\n",
		"b.md": "# B",
	});

	const res = runCli(root);
	assert.equal(res.status, 0, res.stdout + res.stderr);
	// Il riepilogo contiene sempre la parola "broken" (anche con 0 rotti):
	// l'assert significativo è la riga di riepilogo.
	assert.match(res.stdout, /checked 1 local link across 2 files: 1 ok, 0 broken/);
});

test("CLI: exit 1 e riga `file:riga: target` per ogni link rotto", async () => {
	const root = await makeTmp("check-links-cli-ko-");
	await writeTree(root, {
		"sub/a.md": "# A\n\n[rotto](missing.md)\n",
		"b.md": "# B",
	});

	const res = runCli(root);
	assert.equal(res.status, 1);
	assert.match(res.stdout, /sub\/a\.md:3: missing\.md/);
	// L'unico link locale della fixture è quello rotto: 0 ok, 1 broken.
	assert.match(res.stdout, /0 ok, 1 broken/);
});

test("CLI: exit 1 su più file rotti con output ordinato e deterministico", async () => {
	const root = await makeTmp("check-links-cli-multi-");
	await writeTree(root, {
		"z.md": "[x](missing-z.md)\n",
		"a.md": "[x](missing-a.md) [y](missing-a2.md)\n",
	});

	const res = runCli(root);
	assert.equal(res.status, 1);
	const lines = res.stdout.split("\n").filter((l) => /: \S+\.md$/.test(l));
	assert.deepEqual(lines, ["a.md:1: missing-a.md", "a.md:1: missing-a2.md", "z.md:1: missing-z.md"]);
});

test("CLI: exit 2 con messaggio su stderr per root inesistente", () => {
	const res = runCli(path.join(os.tmpdir(), "check-links-no-such-dir"));
	assert.equal(res.status, 2);
	assert.match(res.stderr, /check-links: cannot read directory/);
});

test("CLI: exit 2 con messaggio su stderr per corpus senza file markdown", async () => {
	const root = await makeTmp("check-links-cli-nomd-");
	await writeTree(root, { "foo.txt": "text" });
	const res = runCli(root);
	assert.equal(res.status, 2);
	assert.match(res.stderr, /no markdown files found/);
});

test("CLI: il corpus reale del repo passa il link check (0 broken)", () => {
	// Senza argomenti la root è la cwd del processo di test = root del repo.
	const res = runCliNoArgs();
	assert.equal(res.status, 0, res.stdout + res.stderr);
	assert.match(res.stdout, /0 broken/);
});
