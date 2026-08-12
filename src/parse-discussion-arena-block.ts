/**
 * Parser condiviso del blocco `discussion_arena:` dentro PREFERENCES.md e nei
 * file di override (S02).
 *
 * Estratto dalle due implementazioni duplicate in `trigger-resolver.ts`
 * (parsePreferences) e `src/preferences-writer.ts` (parser locale del blocco), che erano
 * andate in drift sulla regex degli ID di milestone:
 *   - trigger-resolver:   /^([A-Za-z0-9-]+):\s*$/   (M_002 ignorato)
 *   - preferences-writer: /^([A-Za-z0-9_.-]+):\s*$/ (M_002 accettato)
 * Il parser condiviso adotta la forma PERMISSIVA, cosi gli ID di milestone
 * scritti dal wizard TUI (con `_` o `.`) fanno round-trip attraverso
 * resolveTrigger senza essere ignorati silenziosamente.
 *
 * Contratto:
 *   - Input: le righe del corpo DOPO il marcatore di root `discussion_arena:`
 *     (root esclusa, top-level sibling esclusi).
 *   - Indentation shape: sub-chiavi 2 spazi, milestone ID 4 spazi, chiavi di
 *     milestone 6 spazi.
 *   - strict:false (default, retrocompatibile): chiavi sconosciute e
 *     indentazioni malformate vengono saltate silenziosamente, esattamente
 *     come facevano entrambi i parser pre-refactor.
 *   - strict:true: le chiavi sconosciute lanciano `DiscussionArenaParseError`
 *     con il nome della chiave offending e il livello di indentazione. E il
 *     punto d'ingresso che S02 usera per validare i file di override.
 *
 * Zero dipendenze (D004): manipolazione pura di stringhe/righe, nessun
 * pacchetto YAML.
 */

export type DiscussionArenaMode =
	| "per-milestone"
	| "always-on"
	| "availability-only";

export interface DiscussionArenaBlock {
	enabled?: boolean;
	mode?: DiscussionArenaMode;
	milestones?: Record<string, { enabled?: boolean }>;
}

export interface ParseDiscussionArenaOptions {
	/**
	 * strict:true lancia `DiscussionArenaParseError` alla prima chiave
	 * sconosciuta o indentazione fuori schema. Default false: skip silenzioso
	 * (retrocompatibilita con i due parser duplicati pre-refactor).
	 */
	strict?: boolean;
}

export const DISCUSSION_ARENA_MODES: readonly DiscussionArenaMode[] = [
	"per-milestone",
	"always-on",
	"availability-only",
];

/** Errore tipizzato per il path strict:true (consumato da S02). */
export class DiscussionArenaParseError extends Error {
	/** Nome della chiave offending (porzione prima di `:`). */
	readonly key: string;
	/** Livello di indentazione della riga offending (0, 2, 4, 6, ...). */
	readonly indent: number;
	/** Riga raw offending, per diagnostica. */
	readonly line: string;

	constructor(key: string, indent: number, line: string) {
		super(
			`unknown key "${key}" at indent ${indent} in discussion_arena block` +
				(line.trim() && line.trim() !== key ? ` (line: ${line.trim()})` : ""),
		);
		this.name = "DiscussionArenaParseError";
		this.key = key;
		this.indent = indent;
		this.line = line;
	}
}

const BOOL_KEY_RE = /^enabled:\s*(true|false)$/;
const MODE_KEY_RE = /^mode:\s*(.+)$/;
const MILESTONES_KEY_RE = /^milestones:\s*$/;
// Forma permissiva (con _ e .) — risolve la divergenza MID_RE.
const MID_RE = /^([A-Za-z0-9_.-]+):\s*$/;

function indentOf(line: string): number {
	return line.match(/^(\s*)/)?.[1]?.length ?? 0;
}

/** Estrae il nome della chiave da una riga `chiave: valore`. */
function keyNameOf(content: string): string {
	const m = content.match(/^([^:]+):/);
	if (m) return m[1]!.trim();
	return content.split(/\s+/, 1)[0] || content;
}

/**
 * Parsa il corpo del blocco `discussion_arena:` (righe dopo la root line).
 *
 * In modalita `strict:false` (default) la semantica e identica ai due parser
 * pre-refactor: le chiavi sconosciute a livello 2 chiudono la sezione
 * milestones corrente (semantica YAML dei sibling), le righe fuori schema
 * vengono ignorate. In modalita `strict:true` la prima chiave sconosciuta o
 * la prima indentazione fuori schema lancia `DiscussionArenaParseError`.
 */
export function parseDiscussionArenaBlock(
	bodyLines: readonly string[],
	options: ParseDiscussionArenaOptions = {},
): DiscussionArenaBlock {
	const strict = options.strict ?? false;
	const config: DiscussionArenaBlock = {};
	let inMilestones = false;
	let currentMid: string | null = null;

	const throwUnknown = (content: string, indent: number): never => {
		throw new DiscussionArenaParseError(keyNameOf(content), indent, content);
	};

	const ensureMilestone = (mid: string): { enabled?: boolean } => {
		if (!config.milestones) config.milestones = {};
		if (!config.milestones[mid]) config.milestones[mid] = {};
		return config.milestones[mid]!;
	};

	for (const line of bodyLines) {
		const indent = indentOf(line);
		const content = line.trim();
		if (!content || content.startsWith("#")) continue;

		if (indent === 2) {
			if (BOOL_KEY_RE.test(content)) {
				config.enabled = content.includes("true");
			} else if (MODE_KEY_RE.test(content)) {
				const v = content.replace(/^mode:\s*/, "").trim();
				if ((DISCUSSION_ARENA_MODES as readonly string[]).includes(v)) {
					config.mode = v as DiscussionArenaMode;
				}
			} else if (MILESTONES_KEY_RE.test(content)) {
				inMilestones = true;
			} else {
				// Chiave sconosciuta a livello 2: chiude la sezione milestones
				// (stesso livello = sibling in YAML).
				inMilestones = false;
				if (strict) throwUnknown(content, indent);
			}
			continue;
		}

		if (indent === 4 && inMilestones) {
			const m = content.match(MID_RE);
			if (m) {
				currentMid = m[1]!;
				ensureMilestone(currentMid);
			} else if (strict) {
				throwUnknown(content, indent);
			}
			continue;
		}

		if (indent === 6 && currentMid) {
			if (BOOL_KEY_RE.test(content)) {
				ensureMilestone(currentMid).enabled = content.includes("true");
			} else if (strict) {
				throwUnknown(content, indent);
			}
			continue;
		}

		// Qualsiasi altra riga di contenuto fuori schema (indent 0 leakato,
		// indent 4 fuori milestones, indent 6 senza milestone corrente,
		// indentazioni piu profonde): skip in lenient, errore in strict.
		if (strict) throwUnknown(content, indent);
	}

	return config;
}
