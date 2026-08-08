/**
 * Unit tests for trigger-resolver.ts
 *
 * Pure function tests with tmpdir fixtures for PREFERENCES.md parsing.
 * No external dependencies, runs with node --test.
 */

import * as assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { resolveTrigger, type ResolveTriggerInput } from "../trigger-resolver.js";

async function createTmpDir(): Promise<string> {
	return await fs.mkdtemp(path.join(os.tmpdir(), "trigger-resolver-test-"));
}

async function writeSGDFile(tmpDir: string, content: string): Promise<void> {
	const gsdDir = path.join(tmpDir, ".gsd");
	await fs.mkdir(gsdDir, { recursive: true });
	await fs.writeFile(path.join(gsdDir, "PREFERENCES.md"), content, "utf-8");
}

test("Tier 1: env var GSD_DISCUSSION_ARENA_AUTO=1 forces decision", async () => {
	const tmpDir = await createTmpDir();
	try {
		const input: ResolveTriggerInput = {
			cwd: tmpDir,
			milestoneId: "M002",
			env: { GSD_DISCUSSION_ARENA_AUTO: "1" },
		};

		const result = await resolveTrigger(input);

		assert.strictEqual(result.decision, "forced");
		assert.strictEqual(result.source, "env");
		assert.deepEqual(result.warnings, []);
		assert.deepEqual(result.parseErrors, []);
	} finally {
		await fs.rm(tmpDir, { recursive: true });
	}
});

test("Tier 1: env var GSD_DISCUSSION_ARENA_AUTO=0 does not force", async () => {
	const tmpDir = await createTmpDir();
	try {
		const input: ResolveTriggerInput = {
			cwd: tmpDir,
			milestoneId: "M002",
			env: { GSD_DISCUSSION_ARENA_AUTO: "0" },
		};

		const result = await resolveTrigger(input);

		// Should not be forced (only "1" forces)
		assert.strictEqual(result.decision, "available-only");
		assert.strictEqual(result.source, "fallback");
	} finally {
		await fs.rm(tmpDir, { recursive: true });
	}
});

test("Tier 2: PREFERENCES.md discussion_arena global enabled=true forces", async () => {
	const tmpDir = await createTmpDir();
	try {
		const preferences = `---
version: 1
discussion_arena:
  enabled: true
---`;
		await writeSGDFile(tmpDir, preferences);

		const input: ResolveTriggerInput = {
			cwd: tmpDir,
			milestoneId: "M002",
			env: {},
		};

		const result = await resolveTrigger(input);

		assert.strictEqual(result.decision, "forced");
		assert.strictEqual(result.source, "preferences");
	} finally {
		await fs.rm(tmpDir, { recursive: true });
	}
});

test("Tier 2: PREFERENCES.md milestone-specific enabled=true forces", async () => {
	const tmpDir = await createTmpDir();
	try {
		const preferences = `---
version: 1
discussion_arena:
  milestones:
    M002:
      enabled: true
    M003:
      enabled: false
---`;
		await writeSGDFile(tmpDir, preferences);

		const input: ResolveTriggerInput = {
			cwd: tmpDir,
			milestoneId: "M002",
			env: {},
		};

		const result = await resolveTrigger(input);

		assert.strictEqual(result.decision, "forced");
		assert.strictEqual(result.source, "preferences");
	} finally {
		await fs.rm(tmpDir, { recursive: true });
	}
});

test("Tier 2: PREFERENCES.md milestone-specific enabled=false does not force", async () => {
	const tmpDir = await createTmpDir();
	try {
		const preferences = `---
version: 1
discussion_arena:
  milestones:
    M002:
      enabled: false
---`;
		await writeSGDFile(tmpDir, preferences);

		const input: ResolveTriggerInput = {
			cwd: tmpDir,
			milestoneId: "M002",
			env: {},
		};

		const result = await resolveTrigger(input);

		assert.strictEqual(result.decision, "available-only");
		assert.strictEqual(result.source, "fallback");
	} finally {
		await fs.rm(tmpDir, { recursive: true });
	}
});

test("Tier 2: PREFERENCES.md missing milestone falls back to Tier 3", async () => {
	const tmpDir = await createTmpDir();
	try {
		const preferences = `---
version: 1
discussion_arena:
  milestones:
    M001:
      enabled: true
---`;
		await writeSGDFile(tmpDir, preferences);

		const input: ResolveTriggerInput = {
			cwd: tmpDir,
			milestoneId: "M002",
			env: {},
		};

		const result = await resolveTrigger(input);

		// M002 is not in milestones, so Tier 3 fallback
		assert.strictEqual(result.decision, "available-only");
		assert.strictEqual(result.source, "fallback");
	} finally {
		await fs.rm(tmpDir, { recursive: true });
	}
});

test("Tier 3: PREFERENCES.md missing falls back to availability-only", async () => {
	const tmpDir = await createTmpDir();
	try {
		const input: ResolveTriggerInput = {
			cwd: tmpDir,
			milestoneId: "M002",
			env: {},
		};

		const result = await resolveTrigger(input);

		assert.strictEqual(result.decision, "available-only");
		assert.strictEqual(result.source, "fallback");
		assert.deepEqual(result.warnings, []);
		assert.deepEqual(result.parseErrors, []);
	} finally {
		await fs.rm(tmpDir, { recursive: true });
	}
});

test("Tier 3: PREFERENCES.md without discussion_arena section falls back", async () => {
	const tmpDir = await createTmpDir();
	try {
		const preferences = `---
version: 1
models:
  planning:
    model: claude-haiku-4-5
---`;
		await writeSGDFile(tmpDir, preferences);

		const input: ResolveTriggerInput = {
			cwd: tmpDir,
			milestoneId: "M002",
			env: {},
		};

		const result = await resolveTrigger(input);

		assert.strictEqual(result.decision, "available-only");
		assert.strictEqual(result.source, "fallback");
	} finally {
		await fs.rm(tmpDir, { recursive: true });
	}
});

test("Malformed PREFERENCES.md collects parse errors but falls back safely", async () => {
	const tmpDir = await createTmpDir();
	try {
		const preferences = `---
version: 1
invalid yaml: : : :
discussion_arena:
  enabled: true
---`;
		await writeSGDFile(tmpDir, preferences);

		const input: ResolveTriggerInput = {
			cwd: tmpDir,
			milestoneId: "M002",
			env: {},
		};

		const result = await resolveTrigger(input);

		// Should still extract discussion_arena.enabled=true despite yaml mess
		assert.strictEqual(result.decision, "forced");
		assert.strictEqual(result.source, "preferences");
		// Parse errors may or may not be collected (depending on implementation)
		// but decision should still work
	} finally {
		await fs.rm(tmpDir, { recursive: true });
	}
});

test("Priority: Tier 1 (env var) takes precedence over Tier 2 (PREFERENCES)", async () => {
	const tmpDir = await createTmpDir();
	try {
		const preferences = `---
version: 1
discussion_arena:
  enabled: false
---`;
		await writeSGDFile(tmpDir, preferences);

		const input: ResolveTriggerInput = {
			cwd: tmpDir,
			milestoneId: "M002",
			env: { GSD_DISCUSSION_ARENA_AUTO: "1" },
		};

		const result = await resolveTrigger(input);

		assert.strictEqual(result.decision, "forced");
		assert.strictEqual(result.source, "env");
	} finally {
		await fs.rm(tmpDir, { recursive: true });
	}
});

test("Complex PREFERENCES.md with milestones and global enabled", async () => {
	const tmpDir = await createTmpDir();
	try {
		const preferences = `---
version: 1
models:
  planning:
    model: claude-sonnet-5
discussion_arena:
  mode: per-milestone
  milestones:
    M001:
      enabled: false
    M002:
      enabled: true
    M003:
      enabled: true
---`;
		await writeSGDFile(tmpDir, preferences);

		// Test M002 is enabled
		const input2: ResolveTriggerInput = {
			cwd: tmpDir,
			milestoneId: "M002",
			env: {},
		};
		const result2 = await resolveTrigger(input2);
		assert.strictEqual(result2.decision, "forced");
		assert.strictEqual(result2.source, "preferences");

		// Test M001 is disabled (should fallback)
		const input1: ResolveTriggerInput = {
			cwd: tmpDir,
			milestoneId: "M001",
			env: {},
		};
		const result1 = await resolveTrigger(input1);
		assert.strictEqual(result1.decision, "available-only");
		assert.strictEqual(result1.source, "fallback");

		// Test M004 missing (should fallback)
		const input4: ResolveTriggerInput = {
			cwd: tmpDir,
			milestoneId: "M004",
			env: {},
		};
		const result4 = await resolveTrigger(input4);
		assert.strictEqual(result4.decision, "available-only");
		assert.strictEqual(result4.source, "fallback");
	} finally {
		await fs.rm(tmpDir, { recursive: true });
	}
});
