/**
 * Unit tests for src/preferences-writer.ts
 *
 * Covers both the pure merge (`mergeDiscussionArenaPreference`) and the atomic
 * orchestrator (`writeDiscussionArenaPreference`) using tmpdir fixtures, no external
 * deps. Asserts the five S07-T01 persistence guarantees:
 *   (2) per-milestone writes discussion_arena.milestones.<mid>.enabled: true
 *   (3) always-on    writes discussion_arena.enabled: true
 *   (4) availability-only writes discussion_arena.enabled: false
 *   (5) atomic write preserves non-discussion_arena sections byte-for-byte
 *   plus idempotency and missing-file frontmatter creation.
 */

// Self-sufficiency: this static import registers the ESM hooks (`.js` -> `.ts`
// remap + @gsd/pi-coding-agent stub) so the file also runs under a bare
// `node --test <file>`, without the `--import ./tests/ts-esm-loader.mjs` flag
// that `npm test` normally adds. src modules are read via dynamic imports
// below (resolved after hooks are registered).
import "./ts-esm-loader.mjs";
import * as assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
const {
	mergeDiscussionArenaPreference,
	writeDiscussionArenaPreference,
} = await import("../src/preferences-writer.js");

const BASE_PREFS = `---
version: 1
unique_milestone_ids: false
models:
  planning:
    model: claude-sonnet-5
dynamic_routing:
  enabled: true
---`;

async function createTmpDir(): Promise<string> {
	return await fs.mkdtemp(path.join(os.tmpdir(), "prefs-writer-test-"));
}

async function writePrefs(tmpDir: string, content: string): Promise<string> {
	const gsdDir = path.join(tmpDir, ".gsd");
	await fs.mkdir(gsdDir, { recursive: true });
	const file = path.join(gsdDir, "PREFERENCES.md");
	await fs.writeFile(file, content, "utf-8");
	return file;
}

test("(2) per-milestone merge writes milestones.<mid>.enabled: true, preserving base", () => {
	const out = mergeDiscussionArenaPreference(BASE_PREFS, {
		mode: "per-milestone",
		milestoneId: "M003",
	});

	assert.match(out, /discussion_arena:\n {2}milestones:\n {4}M003:\n {6}enabled: true/);
	// Non-discussion_arena sections preserved verbatim.
	assert.ok(out.includes("version: 1"));
	assert.ok(out.includes("planning:\n    model: claude-sonnet-5"));
	assert.ok(out.includes("dynamic_routing:\n  enabled: true"));
});

test("(3) always-on merge writes discussion_arena.enabled: true", () => {
	const out = mergeDiscussionArenaPreference(BASE_PREFS, { mode: "always-on" });
	assert.match(out, /discussion_arena:\n {2}enabled: true/);
});

test("(4) availability-only merge writes discussion_arena.enabled: false", () => {
	const out = mergeDiscussionArenaPreference(BASE_PREFS, { mode: "availability-only" });
	assert.match(out, /discussion_arena:\n {2}enabled: false/);
});

test("(5) existing discussion_arena block updated but adjacent sections preserved", () => {
	const withExisting = `---
version: 1
models:
  planning:
    model: claude-sonnet-5
discussion_arena:
  enabled: false
  mode: availability-only
dynamic_routing:
  enabled: true
---`;
	const out = mergeDiscussionArenaPreference(withExisting, {
		mode: "per-milestone",
		milestoneId: "M002",
	});
	assert.match(out, /discussion_arena:\n {2}enabled: false\n {2}mode: availability-only\n {2}milestones:\n {4}M002:\n {6}enabled: true/);
	assert.ok(out.includes("planning:\n    model: claude-sonnet-5"));
	assert.ok(out.includes("dynamic_routing:\n  enabled: true"));
});

test("merging a second per-milestone preserves the first one", () => {
	const out1 = mergeDiscussionArenaPreference(BASE_PREFS, {
		mode: "per-milestone",
		milestoneId: "M001",
	});
	const out2 = mergeDiscussionArenaPreference(out1, {
		mode: "per-milestone",
		milestoneId: "M002",
	});
	assert.match(out2, /M001:\n {6}enabled: true/);
	assert.match(out2, /M002:\n {6}enabled: true/);
});

test("missing file: writeDiscussionArenaPreference creates .gsd/PREFERENCES.md with block", async () => {
	const tmpDir = await createTmpDir();
	try {
		const file = path.join(tmpDir, ".gsd", "PREFERENCES.md");
		const res = await writeDiscussionArenaPreference(file, {
			mode: "always-on",
		});
		assert.equal(res.changed, true);
		const content = await fs.readFile(file, "utf-8");
		assert.match(content, /discussion_arena:\n {2}enabled: true/);
		assert.ok(content.startsWith("---\n"));
	} finally {
		await fs.rm(tmpDir, { recursive: true });
	}
});

test("idempotent: re-writing identical preference is a no-op on disk", async () => {
	const tmpDir = await createTmpDir();
	try {
		const file = await writePrefs(tmpDir, BASE_PREFS);
		const first = await writeDiscussionArenaPreference(file, { mode: "always-on" });
		assert.equal(first.changed, true);
		const after = await fs.readFile(file, "utf-8");
		const second = await writeDiscussionArenaPreference(file, { mode: "always-on" });
		assert.equal(second.changed, false);
		assert.equal(await fs.readFile(file, "utf-8"), after);
	} finally {
		await fs.rm(tmpDir, { recursive: true });
	}
});

test("atomic write: no temp files left behind after rename", async () => {
	const tmpDir = await createTmpDir();
	try {
		const file = await writePrefs(tmpDir, BASE_PREFS);
		await writeDiscussionArenaPreference(file, { mode: "availability-only" });
		const leftovers = (await fs.readdir(path.dirname(file))).filter((f) =>
			f.endsWith(".tmp"),
		);
		assert.equal(leftovers.length, 0, "no .tmp residue after atomic write");
	} finally {
		await fs.rm(tmpDir, { recursive: true });
	}
});

test("round-trip: written milestones config is re-parsed as forced by trigger-resolver", async () => {
	const { resolveTrigger } = await import("../trigger-resolver.js");
	const tmpDir = await createTmpDir();
	try {
		const file = await writePrefs(tmpDir, BASE_PREFS);
		await writeDiscussionArenaPreference(file, {
			mode: "per-milestone",
			milestoneId: "M002",
		});
		const result = await resolveTrigger({
			cwd: tmpDir,
			milestoneId: "M002",
			env: {},
		});
		assert.strictEqual(result.decision, "forced");
		assert.strictEqual(result.source, "preferences");
	} finally {
		await fs.rm(tmpDir, { recursive: true });
	}
});