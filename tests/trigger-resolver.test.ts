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
import { writeDiscussionArenaPreference } from "../src/preferences-writer.js";
import { DISCUSSION_ARENA_COORDINATION_DIR, DISCUSSION_ARENA_COORDINATION_FILENAME } from "../src/discussion-arena-coordination.js";
import { DEPRECATION_PREFERENCES_MESSAGE } from "../src/deprecation.js";

/** Stderr in-memory che raccoglie i chunk scritti per asserire il warning one-shot. */
function makeCollectingStderr(): { stream: NodeJS.WritableStream; text: () => string } {
	let buf = "";
	const stream = {
		write: (chunk: unknown) => {
			buf += String(chunk);
			return true;
		},
	} as NodeJS.WritableStream;
	return { stream, text: () => buf };
}

async function createTmpDir(): Promise<string> {
	return await fs.mkdtemp(path.join(os.tmpdir(), "trigger-resolver-test-"));
}

async function writeSGDFile(tmpDir: string, content: string): Promise<void> {
	const gsdDir = path.join(tmpDir, ".gsd");
	await fs.mkdir(gsdDir, { recursive: true });
	await fs.writeFile(path.join(gsdDir, "PREFERENCES.md"), content, "utf-8");
}

/** Scrive il coordination file nel path canonico (Tier 2 S02/M007). */
async function writeCoordinationFile(
	tmpDir: string,
	content: string,
): Promise<string> {
	const filePath = path.join(
		tmpDir,
		DISCUSSION_ARENA_COORDINATION_DIR,
		DISCUSSION_ARENA_COORDINATION_FILENAME,
	);
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, content, "utf-8");
	return filePath;
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

// ─── S01-T04: regressione end-to-end della divergenza MID_RE ────────────────
// Il bug che giustifica la slice S01 è osservabile solo attraversando entrambi
// i layer: preferences-writer accetta un milestone ID con `_`/`.` (regex
// permissiva [A-Za-z0-9_.-]+), mentre il trigger-resolver pre-refactor lo
// ignorava silenziosamente (regex ristretta [A-Za-z0-9-]+, M_002 mai matchata).
// S01 ha unificato i due parser sul modulo condiviso; questi test scrivono la
// preferenza con il writer REALE e la risolvono con resolveTrigger, quindi
// sarebbero falliti sul codice pre-refactor (decision available-only invece di
// forced).

test("S01-T04 e2e: milestone ID with underscore written via writeDiscussionArenaPreference round-trips through resolveTrigger", async () => {
	const tmpDir = await createTmpDir();
	try {
		const prefFile = path.join(tmpDir, ".gsd", "PREFERENCES.md");
		const written = await writeDiscussionArenaPreference(prefFile, {
			mode: "per-milestone",
			milestoneId: "M_002",
		});
		assert.strictEqual(written.changed, true);
		assert.match(written.content, /M_002/);

		const resolved = await resolveTrigger({
			cwd: tmpDir,
			milestoneId: "M_002",
			env: {},
		});

		// Pre-refactor: M_002 non matchava /^([A-Za-z0-9-]+):/ => available-only.
		assert.strictEqual(resolved.decision, "forced");
		assert.strictEqual(resolved.source, "preferences");
		assert.deepEqual(resolved.parseErrors, []);
	} finally {
		await fs.rm(tmpDir, { recursive: true });
	}
});

test("S01-T04 e2e: milestone ID with dot written via writeDiscussionArenaPreference round-trips through resolveTrigger", async () => {
	const tmpDir = await createTmpDir();
	try {
		const prefFile = path.join(tmpDir, ".gsd", "PREFERENCES.md");
		const written = await writeDiscussionArenaPreference(prefFile, {
			mode: "per-milestone",
			milestoneId: "M.002",
		});
		assert.strictEqual(written.changed, true);
		assert.match(written.content, /M\.002/);

		const resolved = await resolveTrigger({
			cwd: tmpDir,
			milestoneId: "M.002",
			env: {},
		});

		// Pre-refactor: M.002 non matchava /^([A-Za-z0-9-]+):/ => available-only.
		assert.strictEqual(resolved.decision, "forced");
		assert.strictEqual(resolved.source, "preferences");
		assert.deepEqual(resolved.parseErrors, []);
	} finally {
		await fs.rm(tmpDir, { recursive: true });
	}
});

test("S01-T04 e2e: milestone ID with a space stays unmatched (permissive regex boundary)", async () => {
	const tmpDir = await createTmpDir();
	try {
		// La regex permissiva [A-Za-z0-9_.-]+ NON ammette spazi: la chiave
		// "M 002" viene saltata silenziosamente (strict:false, retrocompatibile)
		// e la decisione resta available-only. Protegge il confine del path
		// permissivo: il round-trip non è diventato "match-anything".
		const prefFile = path.join(tmpDir, ".gsd", "PREFERENCES.md");
		const written = await writeDiscussionArenaPreference(prefFile, {
			mode: "per-milestone",
			milestoneId: "M 002",
		});
		assert.strictEqual(written.changed, true);

		const resolved = await resolveTrigger({
			cwd: tmpDir,
			milestoneId: "M 002",
			env: {},
		});
		assert.strictEqual(resolved.decision, "available-only");
		assert.strictEqual(resolved.source, "fallback");
	} finally {
		await fs.rm(tmpDir, { recursive: true });
	}
});

// ─── S02/M007 T01: coordination file come Tier 2 canonico ──────────────────
// Il coordination file `.gsd/discussion-arena/discussion-arena-coordination.md`
// è la nuova fonte canonica attivazione (S01/M007): letto PRIMA del
// PREFERENCES (Tier 2-bis deprecato). Una sezione `activation:` con
// `enabled: true` globale o per-milestone produce `decision: forced` con
// `source: coordination`.

test("Tier 2 coordination: file assente ricade silenziosamente su fallback", async () => {
	const tmpDir = await createTmpDir();
	try {
		// Nessun coordination file: nessun warning, decisione via Tier 3.
		const resolved = await resolveTrigger({
			cwd: tmpDir,
			milestoneId: "M002",
			env: {},
		});
		assert.strictEqual(resolved.decision, "available-only");
		assert.strictEqual(resolved.source, "fallback");
		assert.deepEqual(resolved.warnings, [], "coordination ENOENT → zero warning");
		assert.deepEqual(resolved.parseErrors, []);
	} finally {
		await fs.rm(tmpDir, { recursive: true });
	}
});

test("Tier 2: coordination activation global enabled=true forces source=coordination", async () => {
	const tmpDir = await createTmpDir();
	try {
		await writeCoordinationFile(tmpDir, `---\nactivation:\n  enabled: true\n  mode: always-on\n---`);

		const result = await resolveTrigger({
			cwd: tmpDir,
			milestoneId: "M002",
			env: {},
		});
		assert.strictEqual(result.decision, "forced");
		assert.strictEqual(result.source, "coordination");
	} finally {
		await fs.rm(tmpDir, { recursive: true });
	}
});

test("Tier 2: coordination activation milestone-specific enabled=true forces source=coordination", async () => {
	const tmpDir = await createTmpDir();
	try {
		await writeCoordinationFile(tmpDir, `---\nactivation:\n  mode: per-milestone\n  milestones:\n    M002:\n      enabled: true\n    M003:\n      enabled: false\n---`);

		const result = await resolveTrigger({
			cwd: tmpDir,
			milestoneId: "M002",
			env: {},
		});
		assert.strictEqual(result.decision, "forced");
		assert.strictEqual(result.source, "coordination");
	} finally {
		await fs.rm(tmpDir, { recursive: true });
	}
});

test("Tier 2: coordination activation milestone-specific=false ripiega su Tier 3", async () => {
	const tmpDir = await createTmpDir();
	try {
		await writeCoordinationFile(tmpDir, `---\nactivation:\n  mode: per-milestone\n  milestones:\n    M001:\n      enabled: true\n    M002:\n      enabled: false\n---`);

		const result = await resolveTrigger({
			cwd: tmpDir,
			milestoneId: "M002",
			env: {},
		});
		assert.strictEqual(result.decision, "available-only");
		assert.strictEqual(result.source, "fallback");
		assert.deepEqual(result.parseErrors, []);
	} finally {
		await fs.rm(tmpDir, { recursive: true });
	}
});

test("Tier 2: coordination activation global=false non forza (come PREFERENCES)", async () => {
	const tmpDir = await createTmpDir();
	try {
		await writeCoordinationFile(tmpDir, `---\nactivation:\n  enabled: false\n  mode: availability-only\n---`);

		const result = await resolveTrigger({
			cwd: tmpDir,
			milestoneId: "M002",
			env: {},
		});
		assert.strictEqual(result.decision, "available-only");
		assert.strictEqual(result.source, "fallback");
	} finally {
		await fs.rm(tmpDir, { recursive: true });
	}
});

test("Precedence: Tier 1 (env) batte il coordination file", async () => {
	const tmpDir = await createTmpDir();
	try {
		await writeCoordinationFile(tmpDir, `---\nactivation:\n  enabled: false\n---`);

		const result = await resolveTrigger({
			cwd: tmpDir,
			milestoneId: "M002",
			env: { GSD_DISCUSSION_ARENA_AUTO: "1" },
		});
		assert.strictEqual(result.decision, "forced");
		assert.strictEqual(result.source, "env");
	} finally {
		await fs.rm(tmpDir, { recursive: true });
	}
});

test("Precedence: coordination file batte PREFERENCES (entrambi enabled)", async () => {
	const tmpDir = await createTmpDir();
	try {
		await writeCoordinationFile(tmpDir, `---\nactivation:\n  enabled: true\n---`);
		await writeSGDFile(tmpDir, `---\nversion: 1\ndiscussion_arena:\n  enabled: true\n---`);

		const result = await resolveTrigger({
			cwd: tmpDir,
			milestoneId: "M002",
			env: {},
		});
		assert.strictEqual(result.decision, "forced");
		assert.strictEqual(result.source, "coordination");
	} finally {
		await fs.rm(tmpDir, { recursive: true });
	}
});

// ─── S03/M007 T01: deprecation warning one-shot della sezione discussion_arena ──
// Quando Tier 2-bis legge PREFERENCES.md con la sezione `discussion_arena:`
// presente, `warnings` include il messaggio di deprecazione (ispezione
// programmatica) e stderr riceve il warning esattamente UNA volta per processo
// (dedup per cwd) — non a ogni call, per evitare spam.

test("T03 deprecation: PREFERENCES con sezione discussion_arena emette warning one-shot su stderr", async () => {
	const tmpDir = await createTmpDir();
	try {
		await writeSGDFile(tmpDir, `---\nversion: 1\ndiscussion_arena:\n  enabled: true\n---`);
		const { stream, text } = makeCollectingStderr();

		const first = await resolveTrigger({
			cwd: tmpDir,
			milestoneId: "M002",
			env: {},
			stderr: stream,
		});
		const second = await resolveTrigger({
			cwd: tmpDir,
			milestoneId: "M002",
			env: {},
			stderr: stream,
		});

		// Il warning è visibile programmaticamente a OGNI call con la sezione presente.
		assert.strictEqual(first.source, "preferences");
		assert.ok(
			first.warnings.some((w) => w === DEPRECATION_PREFERENCES_MESSAGE),
			"warnings deve includere il deprecation message alla prima risoluzione",
		);
		assert.ok(
			second.warnings.some((w) => w === DEPRECATION_PREFERENCES_MESSAGE),
			"warnings deve includere il deprecation message anche alla seconda risoluzione",
		);

		// Stderr: one-shot — il messaggio è stato emesso esattamente UNA volta.
		const occurrences = text().split(DEPRECATION_PREFERENCES_MESSAGE).length - 1;
		assert.strictEqual(occurrences, 1, "deprecation warning emesso una sola volta su stderr");
		assert.ok(text().includes(DEPRECATION_PREFERENCES_MESSAGE), "stderr contiene il messaggio esatto");
	} finally {
		await fs.rm(tmpDir, { recursive: true });
	}
});

test("T03/T01: PREFERENCES senza sezione discussion_arena non emette warning", async () => {
	const tmpDir = await createTmpDir();
	try {
		await writeSGDFile(tmpDir, `---\nversion: 1\nmodels:\n  planning:\n    model: claude-haiku-4-5\n---`);
		const { stream, text } = makeCollectingStderr();

		const result = await resolveTrigger({
			cwd: tmpDir,
			milestoneId: "M002",
			env: {},
			stderr: stream,
		});
		assert.strictEqual(result.source, "fallback");
		assert.deepEqual(result.warnings, [], "nessun warning senza sezione deprecata");
		assert.strictEqual(text(), "", "stderr non deve contenere il warning");
	} finally {
		await fs.rm(tmpDir, { recursive: true });
	}
});

test("T03/T01: coordination attiva come Tier 2 non emette warning PREFERENCES (sezione assente)", async () => {
	const tmpDir = await createTmpDir();
	try {
		await writeCoordinationFile(tmpDir, `---\nactivation:\n  enabled: true\n  mode: always-on\n---`);
		const { stream, text } = makeCollectingStderr();

		const result = await resolveTrigger({
			cwd: tmpDir,
			milestoneId: "M002",
			env: {},
			stderr: stream,
		});
		assert.strictEqual(result.source, "coordination");
		assert.deepEqual(result.warnings, [], "coordination file: nessun deprecation warning");
		assert.strictEqual(text(), "", "stderr non deve contenere il warning");
	} finally {
		await fs.rm(tmpDir, { recursive: true });
	}
});

// Snapshot / parità: la stessa config di attivazione scritta nel PREFERENCES
// oppure nel coordination file produce lo STESSO `decision` (forzato), con
// `source` diverso (preferences vs coordination). Garantisce che il Tier
// 2-bis deprecato resta funzionante e allineato col nuovo Tier 2 canonico.
test("Snapshot: stessa activation in PREFERENCES e coordination → stesso decision forced", async () => {
	const tmpDir = await createTmpDir();
	try {
		await writeSGDFile(tmpDir, `---\nversion: 1\ndiscussion_arena:\n  mode: per-milestone\n  milestones:\n    M007:\n      enabled: true\n---`);

		const viaPreferences = await resolveTrigger({
			cwd: tmpDir,
			milestoneId: "M007",
			env: {},
		});
		assert.strictEqual(viaPreferences.decision, "forced");
		assert.strictEqual(viaPreferences.source, "preferences");

		// Stessa shape nel coordination file.
		await writeCoordinationFile(tmpDir, `---\nactivation:\n  mode: per-milestone\n  milestones:\n    M007:\n      enabled: true\n---`);
		const viaCoordination = await resolveTrigger({
			cwd: tmpDir,
			milestoneId: "M007",
			env: {},
		});
		assert.strictEqual(viaCoordination.decision, "forced");
		assert.strictEqual(viaCoordination.source, "coordination");

		assert.strictEqual(
			viaCoordination.decision,
			viaPreferences.decision,
			"stessa config → stesso decision (forced)",
		);
	} finally {
		await fs.rm(tmpDir, { recursive: true });
	}
});
