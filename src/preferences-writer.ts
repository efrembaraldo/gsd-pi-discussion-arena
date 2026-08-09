/**
 * Atomic writer + pure YAML-subset editor for the `discussion_arena` section
 * inside `<cwd>/.gsd/PREFERENCES.md`.
 *
 * Goals (D025):
 *  - Preserve every non-`discussion_arena` section byte-for-byte (models.*,
 *    dynamic_routing, comments, other keys).
 *  - Insert/update ONLY the `discussion_arena:` subtree, in the exact
 *    indentation shape the trigger-resolver parser expects (root at col 0,
 *    sub-keys 2-sp, milestones 4-sp, milestone keys 6-sp).
 *  - Write atomically: temp file in the same dir -> fsync -> rename ->
 *    fsync dir. Never leave a partially-written PREFERENCES.md.
 *  - Zero new dependencies (D004): pure string/line manipulation, no yaml pkg.
 *
 * Two layers, each independently testable:
 *  - `mergeArenaPreference(content, update)` — pure, returns new full text.
 *  - `writeArenaPreference(file, update)` — read -> merge -> atomic write.
 */

import { open, readFile, rename, mkdir } from "node:fs/promises";
import * as path from "node:path";

export type ArenaMode = "per-milestone" | "always-on" | "availability-only";

export interface ArenaPreferenceUpdate {
	mode: ArenaMode;
	/** Required when mode === "per-milestone". */
	milestoneId?: string;
}

export interface ArenaConfig {
	enabled?: boolean;
	mode?: ArenaMode;
	milestones?: Record<string, { enabled?: boolean }>;
}

export interface ArenaWriteResult {
	content: string;
	changed: boolean;
}

export const VALID_MODES: readonly ArenaMode[] = [
	"per-milestone",
	"always-on",
	"availability-only",
];

const ROOT_BLOCK_RE = /^discussion_arena:\s*(#.*)?$/;
const TOPLEVEL_KEY_RE = /^[^\s#]/;
const BOOL_KEY_RE = /^enabled:\s*(true|false)$/;
const MODE_KEY_RE = /^mode:\s*(.+)$/;
const MILESTONE_KEY_RE = /^milestones:\s*$/;
const MID_RE = /^([A-Za-z0-9_.-]+):\s*$/;

function indentOf(line: string): number {
	return line.match(/^(\s*)/)?.[1]?.length ?? 0;
}

/**
 * Locate the `discussion_arena:` block boundaries within the line array.
 * Indented/content lines and column-0 comments/blanks stay inside the block;
 * a genuine top-level key (column-0 non-space, non-comment) closes it.
 */
function findArenaBlock(
	lines: string[],
): { start: number; end: number } | null {
	const start = lines.findIndex((l) => ROOT_BLOCK_RE.test(l));
	if (start === -1) return null;
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		if (TOPLEVEL_KEY_RE.test(lines[i]!)) {
			end = i;
			break;
		}
	}
	return { start, end };
}

/** Parse an existing `discussion_arena` subtree (after the root line). */
function parseArenaBody(bodyLines: string[]): ArenaConfig {
	const config: ArenaConfig = {};
	let inMilestones = false;
	let currentMid: string | null = null;

	for (const line of bodyLines) {
		const indent = indentOf(line);
		const content = line.trim();
		if (!content || content.startsWith("#")) continue;

		if (indent === 2) {
			if (BOOL_KEY_RE.test(content)) {
				config.enabled = content.includes("true");
			} else if (MODE_KEY_RE.test(content)) {
				const v = content.replace(/^mode:\s*/, "").trim();
				if ((VALID_MODES as readonly string[]).includes(v)) {
					config.mode = v as ArenaMode;
				}
			} else if (MILESTONE_KEY_RE.test(content)) {
				inMilestones = true;
			} else {
				inMilestones = false;
			}
		} else if (indent === 4 && inMilestones) {
			const m = content.match(MID_RE);
			if (m) {
				currentMid = m[1]!;
				if (!config.milestones) config.milestones = {};
				if (!config.milestones[currentMid]) {
					config.milestones[currentMid] = {};
				}
			}
		} else if (indent === 6 && currentMid && BOOL_KEY_RE.test(content)) {
			if (!config.milestones) config.milestones = {};
			if (!config.milestones[currentMid]) config.milestones[currentMid] = {};
			config.milestones[currentMid]!.enabled = content.includes("true");
		}
	}
	return config;
}

/** Render the `discussion_arena:` block lines (root line first). */
function renderArenaBlock(config: ArenaConfig): string[] {
	const out: string[] = ["discussion_arena:"];
	if (typeof config.enabled === "boolean") {
		out.push(`  enabled: ${config.enabled}`);
	}
	if (config.mode) {
		out.push(`  mode: ${config.mode}`);
	}
	const milestones = config.milestones ?? {};
	const mids = Object.keys(milestones).sort();
	if (mids.length > 0) {
		out.push("  milestones:");
		for (const mid of mids) {
			const m = milestones[mid];
			if (!m) continue;
			out.push(`    ${mid}:`);
			if (typeof m.enabled === "boolean") {
				out.push(`      enabled: ${m.enabled}`);
			}
		}
	}
	return out;
}

function applyUpdate(config: ArenaConfig, update: ArenaPreferenceUpdate): void {
	if (update.milestoneId) {
		if (!config.milestones) config.milestones = {};
		if (!config.milestones[update.milestoneId]) {
			config.milestones[update.milestoneId] = {};
		}
		config.milestones[update.milestoneId]!.enabled = true;
		return;
	}
	if (update.mode === "always-on") {
		config.enabled = true;
		return;
	}
	// availability-only
	config.enabled = false;
}

/**
 * Pure merge: returns the FULL PREFERENCES.md text with the `discussion_arena`
 * subtree updated/inserted, preserving every other byte.
 */
export function mergeArenaPreference(
	current: string,
	update: ArenaPreferenceUpdate,
): string {
	const normalized =
		current.length > 0 && !current.endsWith("\n")
			? current + "\n"
			: current;
	const lines = normalized.split("\n");

	const block = findArenaBlock(lines);
	const existing: ArenaConfig = block
		? parseArenaBody(lines.slice(block.start + 1, block.end))
		: {};
	applyUpdate(existing, update);
	const rendered = renderArenaBlock(existing);

	if (block) {
		const next = [...lines];
		next.splice(block.start, block.end - block.start, ...rendered);
		return next.join("\n");
	}

	// No existing block: insert inside the frontmatter right before the closing
	// fence, or wrap the whole body in a fresh minimal frontmatter.
	const closingIdx = lines.findIndex(
		(l, i) => i > 0 && l === "---" && lines[i - 1] !== "---",
	);
	const hasFrontmatter = lines[0] === "---" && closingIdx !== -1;

	if (hasFrontmatter) {
		const out = [...lines];
		out.splice(closingIdx, 0, ...rendered);
		return out.join("\n");
	}

	return `---\n${rendered.join("\n")}\n---\n\n${normalized}`;
}

/**
 * Atomic file write. Temp file in the same dir -> fsync -> rename -> dir fsync
 * (best-effort). Ensures the containing directory exists.
 */
export async function writeFileAtomic(
	filePath: string,
	content: string,
): Promise<void> {
	const dir = path.dirname(filePath);
	await mkdir(dir, { recursive: true });
	const tmp = path.join(
		dir,
		`.PREFERENCES.${process.pid}.${Date.now()}.${Math.random()
			.toString(36)
			.slice(2, 8)}.tmp`,
	);
	const fh = await open(tmp, "w");
	try {
		await fh.writeFile(content, "utf-8");
		await fh.sync();
	} finally {
		await fh.close();
	}
	await rename(tmp, filePath);
	// Best-effort dir fsync (throws on some platforms/filesystems).
	let dh: Awaited<ReturnType<typeof open>> | undefined;
	try {
		dh = await open(dir, "r");
		await dh.sync();
	} catch {
		// Ignore — rename already durable on most platforms.
	} finally {
		await dh?.close().catch(() => {});
	}
}

/**
 * Orchestrator: read current content (ENOENT -> empty), merge, and atomically
 * write only if the content actually changed (idempotency). If the file does
 * not exist, an initial frontmatter containing the block is created.
 */
export async function writeArenaPreference(
	filePath: string,
	update: ArenaPreferenceUpdate,
): Promise<ArenaWriteResult> {
	let current = "";
	try {
		current = await readFile(filePath, "utf-8");
	} catch (err) {
		if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) {
			throw err;
		}
	}

	const content = mergeArenaPreference(current, update);
	const changed = content !== current;
	if (changed) {
		await writeFileAtomic(filePath, content);
	}
	return { content, changed };
}