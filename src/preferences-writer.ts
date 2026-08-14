/**
 * Atomic writer + pure YAML-subset editor for the `discussion_arena` section
 * inside `<cwd>/.gsd/PREFERENCES.md`, and for the `activation:` section of the
 * coordination file (S02/M007, T02).
 *
 * Goals (D025):
 *  - Preserve every non-target section byte-for-byte (models.*,
 *    dynamic_routing, comments, other keys; for the coordination file:
 *    rounds_default, model_default, roles_virtuals and unknown top-level keys).
 *  - Insert/update ONLY the target subtree, in the exact indentation shape the
 *    trigger-resolver parser expects (root at col 0, sub-keys 2-sp,
 *    milestones 4-sp, milestone keys 6-sp).
 *  - Write atomically: temp file in the same dir -> fsync -> rename ->
 *    fsync dir. Never leave a partially-written file.
 *  - Zero new dependencies (D004): pure string/line manipulation, no yaml pkg.
 *
 * Layers, each independently testable:
 *  - `mergeDiscussionArenaPreference(content, update)` — PREFERENCES.md editor.
 *  - `writeDiscussionArenaPreference(file, update)` — read -> merge -> atomic write.
 *  - `mergeCoordinationActivation(content, update)` — coordination file editor
 *    (T02): merges the `activation:` section, auto-creating a minimal valid
 *    coordination frontmatter when the file is absent.
 *  - `writeCoordinationActivation(file, update)` — read -> merge -> atomic write.
 */

import { open, readFile, rename, mkdir } from "node:fs/promises";
import * as path from "node:path";
import { parseDiscussionArenaBlock } from "./parse-discussion-arena-block.js";
import {
	DEPRECATION_PREFERENCES_MESSAGE,
	emitDeprecationWarningOnce,
} from "./deprecation.js";

export type DiscussionArenaMode = "per-milestone" | "always-on" | "availability-only";

export interface DiscussionArenaPreferenceUpdate {
	mode: DiscussionArenaMode;
	/** Required when mode === "per-milestone". */
	milestoneId?: string;
}

export interface DiscussionArenaConfig {
	enabled?: boolean;
	mode?: DiscussionArenaMode;
	milestones?: Record<string, { enabled?: boolean }>;
}

export interface DiscussionArenaWriteResult {
	content: string;
	changed: boolean;
}

// Canonical mode list, kept for API compatibility; mirrors
// DISCUSSION_ARENA_MODES in src/parse-discussion-arena-block.ts.
export const VALID_MODES: readonly DiscussionArenaMode[] = [
	"per-milestone",
	"always-on",
	"availability-only",
];

const ROOT_BLOCK_RE = /^discussion_arena:\s*(#.*)?$/;
const ACTIVATION_ROOT_RE = /^activation:\s*(#.*)?$/;
const TOPLEVEL_KEY_RE = /^[^\s#]/;

/**
 * Locate a top-level block (root marker line + its indented content) within
 * the line array. Indented/content lines and column-0 comments/blanks stay
 * inside the block; a genuine top-level key (column-0 non-space, non-comment)
 * closes it.
 */
function findTopLevelBlock(
	lines: string[],
	rootRe: RegExp,
): { start: number; end: number } | null {
	const start = lines.findIndex((l) => rootRe.test(l));
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

/** Locate the `discussion_arena:` block boundaries. */
function findDiscussionArenaBlock(
	lines: string[],
): { start: number; end: number } | null {
	return findTopLevelBlock(lines, ROOT_BLOCK_RE);
}

/** Locate the `activation:` block boundaries (coordination file, T02). */
function findActivationBlock(
	lines: string[],
): { start: number; end: number } | null {
	return findTopLevelBlock(lines, ACTIVATION_ROOT_RE);
}

/** Render the `activation:` block lines (root line first) — coordinate file,
 * same indentation shape as `discussion_arena:` (T02). */
function renderActivationBlock(config: DiscussionArenaConfig): string[] {
	const out: string[] = ["activation:"];
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

/** Render the `discussion_arena:` block lines (root line first). */
function renderDiscussionArenaBlock(config: DiscussionArenaConfig): string[] {
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

function applyUpdate(config: DiscussionArenaConfig, update: DiscussionArenaPreferenceUpdate): void {
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
export function mergeDiscussionArenaPreference(
	current: string,
	update: DiscussionArenaPreferenceUpdate,
): string {
	const normalized =
		current.length > 0 && !current.endsWith("\n")
			? current + "\n"
			: current;
	const lines = normalized.split("\n");

	const block = findDiscussionArenaBlock(lines);
	const existing: DiscussionArenaConfig = block
		? parseDiscussionArenaBlock(lines.slice(block.start + 1, block.end))
		: {};
	applyUpdate(existing, update);
	const rendered = renderDiscussionArenaBlock(existing);

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

/** Opzioni di scrittura per il writer della sezione deprecata (S03/M007). */
export interface WriteDiscussionArenaPreferenceOptions {
	/** Stderr opzionale per il deprecation warning one-shot (default process.stderr). */
	stderr?: NodeJS.WritableStream;
}

/**
 * Orchestrator: read current content (ENOENT -> empty), merge, and atomically
 * write only if the content actually changed (idempotency). If the file does
 * not exist, an initial frontmatter containing the block is created.
 *
 * Questo percorso scrive la sezione DEPRECATA `discussion_arena:` in
 * PREFERENCES.md (Tier 2-bis, S03/M007): ad ogni invocazione emette il
 * deprecation warning, ma ONE-SHOT per file (dedup modulo-scope) per evitare
 * spam su scritture ripetute allo stesso path.
 */
export async function writeDiscussionArenaPreference(
	filePath: string,
	update: DiscussionArenaPreferenceUpdate,
	options: WriteDiscussionArenaPreferenceOptions = {},
): Promise<DiscussionArenaWriteResult> {
	emitDeprecationWarningOnce(
		`preferences-writer:${filePath}`,
		DEPRECATION_PREFERENCES_MESSAGE,
		options.stderr,
	);
	let current = "";
	try {
		current = await readFile(filePath, "utf-8");
	} catch (err) {
		if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) {
			throw err;
		}
	}

	const content = mergeDiscussionArenaPreference(current, update);
	const changed = content !== current;
	if (changed) {
		await writeFileAtomic(filePath, content);
	}
	return { content, changed };
}

/** Riga `roles_virtuals:` vuota con cui viene auto-creato un coordination file
 * minimal (T02): la sezione è opzionale per il loader, il placeholder mantiene
 * lo shape canonico `rounds_default / activation / roles_virtuals` documentato
 * in `examples/discussion-arena-coordination.example.md` senza inventare un
 * valore per `rounds_default`/`model_default` (che il wizard non conosce e che
 * non deve cambiare la configurazione di default dei round). */
const AUTO_CREATED_ROLES_VIRTUALS = "roles_virtuals:";

/**
 * Pure merge per la sezione `activation:` del coordination file (T02).
 *
 *  - Trova il blocco `activation:` e lo sostituisce con la config aggiornata,
 *    preservando byte-per-byte ogni altra chiave top-level (rounds_default,
 *    model_default, roles_virtuals, chiavi sconosciute forward-compat).
 *  - Se la sezione manca ma il frontmatter esiste, la inserisce subito prima
 *    della fence di chiusura `---`.
 *  - Se il file è assente o privo di frontmatter, auto-crea un frontmatter
 *    minimo valido: `---`, il blocco activation, il placeholder
 *    `roles_virtuals:` vuoto, `---`.
 *
 * Grammatica del blocco identica a `discussion_arena:` (2/4/6 spazi), consumata
 * dallo stesso `parseDiscussionArenaBlock` condiviso. Write idempotente: merge
 * dello stesso update su un file già scritto produce testo identico.
 */
export function mergeCoordinationActivation(
	current: string,
	update: DiscussionArenaPreferenceUpdate,
): string {
	const normalized =
		current.length > 0 && !current.endsWith("\n")
			? current + "\n"
			: current;
	const lines = normalized.split("\n");

	const block = findActivationBlock(lines);
	const existing: DiscussionArenaConfig = block
		? parseDiscussionArenaBlock(lines.slice(block.start + 1, block.end))
		: {};
	applyUpdate(existing, update);
	const rendered = renderActivationBlock(existing);

	if (block) {
		const next = [...lines];
		next.splice(block.start, block.end - block.start, ...rendered);
		return next.join("\n");
	}

	// Nessun blocco activation: inserimento dentro il frontmatter esistente
	// subito prima della fence di chiusura, oppure auto-create del file.
	const closingIdx = lines.findIndex(
		(l, i) => i > 0 && l === "---" && lines[i - 1] !== "---",
	);
	const hasFrontmatter = lines[0] === "---" && closingIdx !== -1;

	if (hasFrontmatter) {
		const out = [...lines];
		out.splice(closingIdx, 0, ...rendered);
		return out.join("\n");
	}

	// Auto-create del file: frontmatter minimo valido per
	// `loadDiscussionArenaCoordination`. La stringa termina con `\n` così il
	// merge successivo (idempotenza) produce testo identico senza introdurre
	// una differenza di trailing newline alla seconda scrittura.
	return ["---", ...rendered, AUTO_CREATED_ROLES_VIRTUALS, "---", ""].join("\n");
}

/**
 * Orchestrator del coordination file (T02): read (ENOENT -> vuoto), merge della
 * sezione `activation:`, scrittura atomica solo se il contenuto è cambiato
 * (idempotenza). Auto-create quando il file non esiste.
 */
export async function writeCoordinationActivation(
	filePath: string,
	update: DiscussionArenaPreferenceUpdate,
): Promise<DiscussionArenaWriteResult> {
	let current = "";
	try {
		current = await readFile(filePath, "utf-8");
	} catch (err) {
		if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) {
			throw err;
		}
	}

	const content = mergeCoordinationActivation(current, update);
	const changed = content !== current;
	if (changed) {
		await writeFileAtomic(filePath, content);
	}
	return { content, changed };
}