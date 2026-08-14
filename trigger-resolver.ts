/**
 * Pure trigger resolver for discussion_arena auto-mode integration.
 *
 * Implements 4-tier fallback logic for GSD_DISCUSSION_ARENA_AUTO:
 * Tier 1: env var GSD_DISCUSSION_ARENA_AUTO=1
 * Tier 2 (canonical): coordination file `.gsd/discussion-arena/discussion-arena-coordination.md`
 *               section `activation:` — global enabled or milestone-specific enabled
 * Tier 2-bis (deprecated): PREFERENCES.md discussion_arena[.milestones].enabled: true
 * Tier 3: fallback availability-only (discussion_arena available but not forced)
 *
 * Pure function — no ExtensionAPI dependency. Input: cwd, milestoneId, env, stderr.
 * Output: { decision: "forced" | "available-only", source: "env" | "coordination" | "preferences" | "fallback", warnings: string[], parseErrors: string[] }
 *
 * The coordination file is the canonical Tier 2 source (S02/M007): it is read
 * FIRST, before the PREFERENCES path which remains as a deprecated Tier 2-bis
 * so existing projects keep working untouched. Both surfaces share the same
 * activation grammar via `parseDiscussionArenaBlock` (mode, milestone IDs,
 * enabled booleans), so the decision logic is uniform across them.
 *
 * Parsing strategy reuses the session-parser module pattern: line-by-line
 * frontmatter YAML, key: value format, section marker "discussion_arena:".
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseDiscussionArenaBlock } from "./src/shared-parser.js";
import { LOG_PREFIX } from "./src/log-prefix.js";
import {
	DISCUSSION_ARENA_COORDINATION_DIR,
	DISCUSSION_ARENA_COORDINATION_FILENAME,
	type DiscussionArenaActivationConfig,
	loadDiscussionArenaCoordination,
} from "./src/discussion-arena-coordination.js";

export interface ResolveTriggerInput {
	cwd: string;
	milestoneId: string;
	env: NodeJS.ProcessEnv;
	stderr?: NodeJS.WritableStream;
}

export interface ResolveTriggerOutput {
	decision: "forced" | "available-only";
	source: "env" | "coordination" | "preferences" | "fallback";
	warnings: string[];
	parseErrors: string[];
}

/**
 * Shape del blocco `discussion_arena:` dentro PREFERENCES.md — Tier 2-bis
 * DEPRECATO (S01/M007). Condivide la stessa grammatica della sezione
 * `activation:` del coordination file (`DiscussionArenaActivationConfig`),
 * quindi la logica di decisione di `resolveTrigger` è uniforme tra i due
 * canali: `milestones.<id>.enabled` (per-milestone) oppure `enabled` globale.
 */
export interface PreferencesConfig {
	discussion_arena?: DiscussionArenaActivationConfig;
}

/**
 * Parse PREFERENCES.md frontmatter and extract discussion_arena section.
 * Returns empty config if file is missing or section is missing.
 * Collects parse errors but does not throw.
 */
function parsePreferences(content: string): {
	config: PreferencesConfig;
	parseErrors: string[];
} {
	const parseErrors: string[] = [];
	const config: PreferencesConfig = {};

	// Simple frontmatter extraction (same pattern as the session-parser module)
	const match = content.match(/^---\n([\s\S]*?)\n---/);
	if (!match) {
		parseErrors.push("no frontmatter found");
		return { config, parseErrors };
	}

	const [, frontmatter] = match;
	const lines = frontmatter.split("\n");

	let inDiscussionArena = false;
	const discussionArenaLines: string[] = [];

	for (const line of lines) {
		// Detect section marker "discussion_arena:" at root level
		if (line.match(/^discussion_arena:\s*$/) || line.match(/^discussion_arena:\s*#/)) {
			inDiscussionArena = true;
			continue;
		}

		// If we're in discussion_arena section, collect lines until next top-level key
		if (inDiscussionArena) {
			// Check if we've reached a new top-level key (no leading space)
			if (line.match(/^\S/) && !line.match(/^\s/)) {
				inDiscussionArena = false;
				break;
			}
			// Collect lines that belong to discussion_arena (have indentation)
			if (line.trim()) {
				discussionArenaLines.push(line);
			}
		}
	}

	// Parse discussion_arena nested structure via il parser condiviso (S01).
	// strict:false (default, esplicito qui per retrocompatibilita): le chiavi
	// sconosciute e le indentazioni fuori schema vengono saltate
	// silenziosamente, esattamente come faceva il parser pre-refactor, quindi
	// parseErrors non cambia semantica ne popolamento. Il parser condiviso
	// adotta la forma PERMISSIVA della MID_RE ([A-Za-z0-9_.-]+), cosi gli ID
	// di milestone scritti dal wizard TUI con `_` o `.` non vengono piu
	// ignorati silenziosamente.
	if (discussionArenaLines.length > 0) {
		config.discussion_arena = parseDiscussionArenaBlock(
			discussionArenaLines,
			{ strict: false },
		);
	}

	return { config, parseErrors };
}

/**
 * Resolve the trigger decision for discussion_arena auto-mode.
 *
 * Tier 1: Check env var GSD_DISCUSSION_ARENA_AUTO=1
 * Tier 2: Check the coordination file activation section
 *         (discussion-arena-coordination.md) — canonical (S01/M007).
 * Tier 2-bis: Check PREFERENCES.md discussion_arena[.milestones].<milestoneId>.enabled
 *         (deprecated, kept working for backward compatibility).
 * Tier 3: Fallback to availability-only (never throw, always return a decision).
 * Precedence: env > coordination > preferences > fallback.
 */
export async function resolveTrigger(
	input: ResolveTriggerInput,
): Promise<ResolveTriggerOutput> {
	const warnings: string[] = [];
	const parseErrors: string[] = [];

	// Tier 1: Env var
	if (input.env.GSD_DISCUSSION_ARENA_AUTO === "1") {
		return {
			decision: "forced",
			source: "env",
			warnings,
			parseErrors,
		};
	}

	// Tier 2 (canonical): coordination file. Never throws (D053): when the file
	// is absent (ENOENT) it is a silent no-op with zero warnings, so the flow
	// cleanly falls through to the deprecated PREFERENCES Tier 2-bis.
	const coordinationPath = path.join(
		input.cwd,
		DISCUSSION_ARENA_COORDINATION_DIR,
		DISCUSSION_ARENA_COORDINATION_FILENAME,
	);
	const coordination = loadDiscussionArenaCoordination(coordinationPath);
	warnings.push(...coordination.warnings);

	const activation = coordination.config.activation;
	if (
		activation &&
		(activation.milestones?.[input.milestoneId]?.enabled === true ||
			activation.enabled === true)
	) {
		return {
			decision: "forced",
			source: "coordination",
			warnings,
			parseErrors,
		};
	}

	// Tier 2-bis (deprecated, backward-compatible): PREFERENCES.md
	const preferencesPath = path.join(input.cwd, ".gsd", "PREFERENCES.md");
	let preferencesContent: string | null = null;

	try {
		preferencesContent = await fs.readFile(preferencesPath, "utf-8");
	} catch (err) {
		// File not found or unreadable — this is not an error, proceed to Tier 3
		if (
			err instanceof Error &&
			err.message.includes("ENOENT")
		) {
			// File doesn't exist — expected in many cases
		} else {
			warnings.push(
				`Could not read PREFERENCES.md: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	if (preferencesContent) {
		const { config, parseErrors: prefs_parseErrors } =
			parsePreferences(preferencesContent);
		parseErrors.push(...prefs_parseErrors);

		// Check milestone-specific config (same activation grammar as coordination)
		if (config.discussion_arena?.milestones?.[input.milestoneId]?.enabled) {
			return {
				decision: "forced",
				source: "preferences",
				warnings,
				parseErrors,
			};
		}

		// Check global enabled flag
		if (config.discussion_arena?.enabled === true) {
			return {
				decision: "forced",
				source: "preferences",
				warnings,
				parseErrors,
			};
		}
	}

	// Tier 3: Fallback to availability-only
	// This is the safe default: discussion_arena is available but not forced
	return {
		decision: "available-only",
		source: "fallback",
		warnings,
		parseErrors,
	};
}

/**
 * Variant of resolveTrigger that optionally logs decision to stderr.
 * Useful for observability during auto-mode execution.
 */
export async function resolveTriggerWithLogging(
	input: ResolveTriggerInput,
): Promise<ResolveTriggerOutput> {
	const result = await resolveTrigger(input);

	if (input.stderr) {
		const logMessage =
			`${LOG_PREFIX} trigger resolved: decision=${result.decision} source=${result.source}` +
			(result.warnings.length > 0
				? ` warnings=${result.warnings.join(";")} `
				: "");
		input.stderr.write(logMessage + "\n");
	}

	return result;
}
