#!/usr/bin/env node
// scripts/copy-template.mjs
//
// Postinstall hook (D137 + D142): copies
//   examples/discussion-arena-coordination.example.md
// bit-identically into
//   <GSD_AGENT_DIR>/discussion-arena/templates/discussion-arena-coordination.md
//
// Contract:
//   - Zero npm runtime deps (D004): node:fs / node:path / node:url / node:os
//     stdlib only — no third-party imports.
//   - Idempotent: second invocation on a populated agent dir skips without
//     overwriting the existing file (stat mtime unchanged) and exits 0.
//   - Failure-safe: ALWAYS exits 0. Source missing, dest not writable,
//     GSD_AGENT_DIR / HOME unresolved — all surface as a single stderr line
//     "[copy-template] postinstall: <reason> (skipping)" and exit 0, so
//     `npm install` is never blocked by this bootstrap step.
//   - Pure core (`copyTemplate`) returns a structured result
//     { installed, skipped, error? } so tests can assert behavior without
//     spawning the CLI; exports `resolveAgentDir`, `destPathFor`,
//     `SOURCE_FILENAME`, `copyTemplate` for in-process imports from .mjs
//     and .ts (via the project's ts-esm-loader).
//
// Stdout contract (one line per execution):
//   - install: "[copy-template] postinstall: template installed at <path>"
//   - skip:    "[copy-template] postinstall: template already present at <path> — skipped"
//
// Stderr contract (one line per failure safety event):
//   - "[copy-template] postinstall: <error message> (skipping)"

import {
	existsSync,
	mkdirSync,
	copyFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Canonical source filename shipped under examples/. */
export const SOURCE_FILENAME = "discussion-arena-coordination.example.md";

/** Canonical destination filename installed under the agent templates dir. */
const DEST_FILENAME = "discussion-arena-coordination.md";

/** Absolute path of the source template (resolved from import.meta.url —
 *  NEVER from process.cwd() so the script is portable across cwd). */
const SOURCE = resolve(
	__dirname,
	"..",
	"examples",
	SOURCE_FILENAME,
);

/**
 * @typedef {{ log: (message: string) => void, error: (message: string) => void }} CopyTemplateLogger
 */

/** Default logger writes to stdout / stderr — used when no logger is supplied. */
const defaultLogger = /** @type {CopyTemplateLogger} */ ({
	log: (m) => console.log(m),
	error: (m) => console.error(m),
});

/**
 * Resolve the user-level agent directory.
 *  - If `env.GSD_AGENT_DIR` is set AND non-empty, use it as-is (override).
 *  - Otherwise fall back to `<HOME>/.gsd/agent` (D137 convention).
 *
 * Exported so tests can drive it without spawning the CLI.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {string}
 */
export function resolveAgentDir(env = process.env) {
	const raw = env.GSD_AGENT_DIR;
	if (typeof raw === "string" && raw.length > 0) {
		return raw;
	}
	return join(homedir(), ".gsd", "agent");
}

/**
 * Compute the destination directory + file path for the installed template,
 * given a user-level agent dir.
 *
 * @param {string} agentDir
 * @returns {{ dir: string, file: string }}
 */
export function destPathFor(agentDir) {
	const dir = join(agentDir, "discussion-arena", "templates");
	const file = join(dir, DEST_FILENAME);
	return { dir, file };
}

/**
 * Pure copyTemplate logic — testable in-process.
 *
 * Returns one of:
 *   - { installed: true,  skipped: false }                — file created
 *   - { installed: false, skipped: true  }                — dest already present (idempotent)
 *   - { installed: false, skipped: false, error: <msg> }  — failure safety (NO throw)
 *
 * NEVER throws: any thrown error from mkdirSync / copyFileSync is converted
 * into a structured result and surfaced via logger.error (if provided).
 *
 * @param {{
 *   sourcePath: string,
 *   destDir: string,
 *   logger?: CopyTemplateLogger
 * }} opts
 * @returns {{ installed: boolean, skipped: boolean, error?: string }}
 */
export function copyTemplate(opts) {
	const { sourcePath, destDir } = opts;
	const logger = opts.logger ?? defaultLogger;
	const destFile = join(destDir, DEST_FILENAME);

	try {
		if (!existsSync(sourcePath)) {
			const msg = "source missing";
			logger.error(`[copy-template] postinstall: ${msg} (skipping)`);
			return { installed: false, skipped: false, error: msg };
		}
		if (existsSync(destFile)) {
			return { installed: false, skipped: true };
		}
		mkdirSync(destDir, { recursive: true });
		copyFileSync(sourcePath, destFile);
		return { installed: true, skipped: false };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		logger.error(`[copy-template] postinstall: ${msg} (skipping)`);
		return { installed: false, skipped: false, error: msg };
	}
}

/**
 * CLI entry point — always exits 0 (failure-safe). Logging is routed based on
 * the copyTemplate result:
 *   - installed -> stdout "postinstall: template installed at <path>"
 *   - skipped   -> stdout "postinstall: template already present at <path> — skipped"
 *   - error     -> stderr already emitted by copyTemplate via defaultLogger
 */
function main() {
	const agentDir = resolveAgentDir();
	const { dir, file } = destPathFor(agentDir);
	const result = copyTemplate({ sourcePath: SOURCE, destDir: dir });

	if (result.installed) {
		console.log(
			`[copy-template] postinstall: template installed at ${file}`,
		);
	} else if (result.skipped) {
		console.log(
			`[copy-template] postinstall: template already present at ${file} — skipped`,
		);
	}
	// error: copyTemplate already wrote the stderr line via defaultLogger.

	process.exit(0);
}

// Run only when invoked directly — allows tests to import the helpers without
// triggering the side effect.
if (
	typeof process !== "undefined" &&
	Array.isArray(process.argv) &&
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	main();
}