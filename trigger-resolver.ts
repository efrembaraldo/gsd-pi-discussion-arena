/**
 * Pure trigger resolver for discussion-arena auto-mode integration.
 *
 * Implements 3-tier fallback logic for GSD_DISCUSSION_ARENA_AUTO:
 * Tier 1: env var GSD_DISCUSSION_ARENA_AUTO=1
 * Tier 2: PREFERENCES.md discussion_arena.milestones.<mid>.enabled: true
 * Tier 3: fallback availability-only (arena available but not forced)
 *
 * Pure function — no ExtensionAPI dependency. Input: cwd, milestoneId, env, stderr.
 * Output: { decision: "forced" | "available-only", source: "env" | "preferences" | "fallback", warnings: string[], parseErrors: string[] }
 *
 * Parsing strategy reuses discussion-arena-session.ts pattern: line-by-line
 * frontmatter YAML, key: value format, section marker "discussion_arena:".
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface ResolveTriggerInput {
	cwd: string;
	milestoneId: string;
	env: NodeJS.ProcessEnv;
	stderr?: NodeJS.WritableStream;
}

export interface ResolveTriggerOutput {
	decision: "forced" | "available-only";
	source: "env" | "preferences" | "fallback";
	warnings: string[];
	parseErrors: string[];
}

export interface PreferencesConfig {
	discussion_arena?: {
		enabled?: boolean;
		milestones?: Record<string, { enabled?: boolean }>;
		mode?: "per-milestone" | "always-on" | "availability-only";
	};
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

	// Simple frontmatter extraction (same pattern as discussion-arena-session.ts:parseSession)
	const match = content.match(/^---\n([\s\S]*?)\n---/);
	if (!match) {
		parseErrors.push("no frontmatter found");
		return { config, parseErrors };
	}

	const [, frontmatter] = match;
	const lines = frontmatter.split("\n");

	let inDiscussionArena = false;
	const depth = 0;
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

	// Parse discussion_arena nested structure
	if (discussionArenaLines.length > 0) {
		const daConfig: {
			enabled?: boolean;
			milestones?: Record<string, { enabled?: boolean }>;
			mode?: "per-milestone" | "always-on" | "availability-only";
		} = {};

		let inMilestones = false;
		let currentMilestone: string | null = null;

		for (const line of discussionArenaLines) {
			// Get indentation level
			const indent = line.match(/^(\s*)/)?.[1]?.length ?? 0;
			const content = line.trim();

			// Top-level keys under discussion_arena (2-space indent)
			if (indent === 2) {
				if (content.match(/^enabled:\s*true$/)) {
					daConfig.enabled = true;
				} else if (content.match(/^enabled:\s*false$/)) {
					daConfig.enabled = false;
				} else if (content.match(/^mode:\s*(.+)$/)) {
					const modeMatch = content.match(/^mode:\s*(.+)$/);
					if (modeMatch) {
						const modeValue = modeMatch[1];
						if (
							modeValue === "per-milestone" ||
							modeValue === "always-on" ||
							modeValue === "availability-only"
						) {
							daConfig.mode = modeValue;
						}
					}
				} else if (content.match(/^milestones:\s*$/)) {
					inMilestones = true;
				}
			}

			// Nested keys under milestones (4-space indent)
			if (inMilestones && indent === 4) {
				const milestoneMatch = content.match(/^([A-Za-z0-9-]+):\s*$/);
				if (milestoneMatch) {
					currentMilestone = milestoneMatch[1];
					if (!daConfig.milestones) daConfig.milestones = {};
					daConfig.milestones[currentMilestone] = {};
				}
			}

			// Keys under current milestone (6-space indent)
			if (
				currentMilestone &&
				daConfig.milestones &&
				indent === 6
			) {
				if (content.match(/^enabled:\s*true$/)) {
					daConfig.milestones[currentMilestone]!.enabled = true;
				} else if (content.match(/^enabled:\s*false$/)) {
					daConfig.milestones[currentMilestone]!.enabled = false;
				}
			}
		}

		config.discussion_arena = daConfig;
	}

	return { config, parseErrors };
}

/**
 * Resolve the trigger decision for discussion-arena auto-mode.
 *
 * Tier 1: Check env var GSD_DISCUSSION_ARENA_AUTO=1
 * Tier 2: Check PREFERENCES.md discussion_arena.milestones.<milestoneId>.enabled
 * Tier 3: Fallback to availability-only (never throw, always return a decision)
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

	// Tier 2: PREFERENCES.md
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

		// Check milestone-specific config
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
	// This is the safe default: arena is available but not forced
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
			`[discussion-arena] trigger resolved: decision=${result.decision} source=${result.source}` +
			(result.warnings.length > 0
				? ` warnings=${result.warnings.join(";")} `
				: "");
		input.stderr.write(logMessage + "\n");
	}

	return result;
}
