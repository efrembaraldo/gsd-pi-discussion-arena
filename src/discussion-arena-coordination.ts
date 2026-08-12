/**
 * Loader del file di coordination della discussion-arena per-progetto
 * (S03/M004, T01).
 *
 * Il file `<cwd>/.gsd/discussion-arena/discussion-arena-coordination.md`
 * definisce la "forma" dell'arena, ed è la fonte canonica per:
 *   - `rounds_default`: default dei round quando né il tool né il command
 *     passano un valore esplicito (livello 3 della gerarchia a 4 livelli,
 *     consumato dal resolver `resolveRoundsDefault` di T03);
 *   - `model_default`: modello di fallback per i participant senza `model`
 *     esplicito (consumato da `discoverParticipants`, T02);
 *   - `roles_virtuals`: ruoli one-off definiti interamente qui, senza file in
 *     `participants/` (participant di prima classe con `source: "virtual"`,
 *     applicati da T02).
 *
 * Contratto del loader (Must-Have 1 S03):
 *   - mai throw: ogni condizione di errore produce una config vuota (code
 *     defaults) con un log stderr diagnostico a prefisso canonico
 *     `[discussion-arena]` (D053) — l'assenza del file (ENOENT) è invece un
 *     no-op silenzioso (`sourcePath: null`, zero warnings, zero log);
 *   - parser indentation-aware proprio (D051): `parseFrontmatter()` di
 *     `@gsd/pi-coding-agent` appiattisce le chiavi annidate, quindi non può
 *     rappresentare `roles_virtuals: { <role>: { ... } }`. Questo modulo
 *     parsa il frontmatter con un piccolo parser a indentazione dedicato,
 *     zero dipendenze (D004);
 *   - `rounds_default`: deve essere un integer positivo (>= 1). Un valore
 *     invalido viene ignorato con log D053 e si applicano i code defaults.
 *     Il cap a `MAX_ROUNDS` NON è qui: è responsabilità del resolver
 *     `resolveRoundsDefault` (T03, index.ts), che centralizza la gerarchia e
 *     il clamp — importare `MAX_ROUNDS` da index.ts in src/ creerebbe un
 *     accoppiamento invertito (index.ts importa i moduli src/);
 *   - `roles_virtuals.<key>`: i 4 campi required (name, role, description,
 *     systemPrompt) devono essere presenti; una entry incompleta viene
 *     saltata con log D053 e le altre continuano a valere. Il check
 *     "chiave dict !== field name" è di competenza di T02
 *     (discoverParticipants), non del loader;
 *   - chiavi top-level sconosciute: ignorate silenziosamente (forward-compat:
 *     un coordination file scritto per una versione futura non deve azzerare
 *     la config; una chiave con refuso non deve buttare via `rounds_default`
 *     già parsato);
 *   - commenti inline (`key: value # ...`) e righe `#` intere: strippati.
 *
 * Il risultato espone `warnings` (ispezione programmatica, stesse stringhe
 * dei log D053) oltre ai log stderr (superficie osservativa canonica).
 *
 * Zero dipendenze npm (D004): solo `node:fs`.
 */

import * as fs from "node:fs";

/** Directory del coordination file dentro `.gsd/` (stessa dir del tier 0 override). */
export const DISCUSSION_ARENA_COORDINATION_DIR = ".gsd/discussion-arena";

/** Nome canonico del coordination file per-progetto. */
export const DISCUSSION_ARENA_COORDINATION_FILENAME =
	"discussion-arena-coordination.md";

/** Campi required di una entry di `roles_virtuals` (shape `ParticipantConfig`). */
const REQUIRED_VIRTUAL_FIELD_NAMES = [
	"name",
	"role",
	"description",
	"systemPrompt",
] as const;

type VirtualFieldName = (typeof REQUIRED_VIRTUAL_FIELD_NAMES)[number];

/** Ruolo virtuale: participant di prima classe definito nel coordination file. */
export interface DiscussionArenaVirtualRole {
	name: string;
	role: string;
	description: string;
	systemPrompt: string;
}

/** Configurazione della "forma" dell'arena letta dal coordination file. */
export interface DiscussionArenaCoordinationConfig {
	/** Default dei round quando tool/command non passano un valore esplicito. */
	roundsDefault?: number;
	/** Modello di fallback per i participant senza `model` esplicito (T02). */
	modelDefault?: string;
	/** Ruoli virtuali per chiave di dict (chiave canonica del ruolo). */
	rolesVirtuals: Record<string, DiscussionArenaVirtualRole>;
}

/** Risultato del loader: mai throw, sempre con una config (eventualmente vuota). */
export interface LoadDiscussionArenaCoordinationResult {
	/** Config parsata; `{ rolesVirtuals: {} }` quando il file è assente o non valido. */
	config: DiscussionArenaCoordinationConfig;
	/** Warning diagnostici raccolti durante il parsing (stesse stringhe dei log D053). */
	warnings: string[];
	/** Path del coordination file letto, o null se il file non esiste (ENOENT). */
	sourcePath: string | null;
}

/** Log stderr con il prefisso canonico `[discussion-arena]` (trasparenza operazionale). */
function logStderr(message: string): void {
	process.stderr.write(`[discussion-arena] ${message}\n`);
}

function emptyConfig(): DiscussionArenaCoordinationConfig {
	return { rolesVirtuals: {} };
}

function isEnoent(err: unknown): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		"code" in err &&
		(err as { code?: unknown }).code === "ENOENT"
	);
}

/**
 * Estrae il blocco YAML tra i due marcatori `---`, o null se il marcatore di
 * chiusura manca (frontmatter unterminated → parse error D053). Il chiamante
 * ha già verificato che il contenuto inizi con `---`.
 */
function extractFrontmatter(content: string): string | null {
	const rest = content.slice(3);
	const endIndex = rest.indexOf("\n---");
	if (endIndex === -1) return null;
	return rest.slice(0, endIndex);
}

/** Larghezza del prefisso di indentazione (spazi e tab) di una riga. */
function leadingSpaces(line: string): number {
	const match = line.match(/^[ \t]*/);
	return match ? match[0].length : 0;
}

/** `chiave: valore` su una riga (subset YAML; la chiave esclude i `:`). */
const KEY_VALUE_RE = /^([A-Za-z0-9_.-]+):\s*(.*)$/;

/** Stripta un commento inline (` # ...`) da un valore, rispettando `#` mid-token. */
function stripInlineComment(value: string): string {
	return value.replace(/\s+#.*$/, "").trim();
}

interface ParsedFrontmatter {
	config: DiscussionArenaCoordinationConfig;
	warnings: string[];
	/** Errore strutturale (es. `roles_virtuals` con valore scalare): config scartata. */
	fatal: string | null;
}

/**
 * Parser indentation-aware del frontmatter del coordination file (D051).
 *
 * Grammatica supportata (subset YAML):
 *   rounds_default: <integer positivo>      (livello 0)
 *   model_default: <stringa>                (livello 0)
 *   roles_virtuals:                         (livello 0, apre la sezione ruoli)
 *     <chiave>:                             (livello 2, header di un ruolo)
 *       name: <stringa>                     (livello 4)
 *       role: <stringa>                     (livello 4)
 *       description: <stringa>              (livello 4)
 *       systemPrompt: |                     (livello 4, block scalar)
 *         <riga>...                         (livello > 4, contenuto del blocco)
 *
 * Regole di robustezza:
 *   - righe vuote e commenti `#` ignorati (le righe vuote DENTRO un block
 *     scalar sono parte del blocco, come da YAML);
 *   - linee che non matchano `chiave: valore` ignorate (lenient);
 *   - campo con valore vuoto = campo mancante (skip della entry con D053);
 *   - `roles_virtuals` con valore scalare inline → errore strutturale fatale
 *     (config scartata con D053 generico).
 */
function parseCoordinationFrontmatter(yaml: string): ParsedFrontmatter {
	const config = emptyConfig();
	const warnings: string[] = [];

	const lines = yaml.split("\n");
	let mode: "top" | "roles" = "top";
	let roleKey: string | null = null;
	let roleFields: Partial<Record<VirtualFieldName, string>> | null = null;
	let blockField: VirtualFieldName | null = null;
	let blockIndent = 0;
	/** Indentazione del contenuto del blocco (fissata sulla prima riga non vuota). */
	let blockContentIndent: number | null = null;
	let blockLines: string[] = [];

	/** Valida e committa il ruolo corrente; se incompleto lo salta con D053. */
	const commitRole = (): void => {
		if (roleKey === null || roleFields === null) return;
		for (const field of REQUIRED_VIRTUAL_FIELD_NAMES) {
			if (!roleFields[field]) {
				warnings.push(
					`virtual role '${roleKey}' missing required field ${field} — skipped`,
				);
				roleKey = null;
				roleFields = null;
				return;
			}
		}
		config.rolesVirtuals[roleKey] = {
			name: roleFields.name!,
			role: roleFields.role!,
			description: roleFields.description!,
			systemPrompt: roleFields.systemPrompt!,
		};
		roleKey = null;
		roleFields = null;
	};

	/** Chiude il block scalar corrente scrivendo il contenuto nel campo. */
	const endBlockScalar = (): void => {
		if (blockField === null) return;
		if (roleFields) {
			roleFields[blockField] = blockLines.join("\n").trim();
		}
		blockField = null;
		blockIndent = 0;
		blockContentIndent = null;
		blockLines = [];
	};

	for (const rawLine of lines) {
		const indent = leadingSpaces(rawLine);
		const content = rawLine.trim();
		const isBlank = content === "";

		// Continuazione di un block scalar: ogni riga più indentata
		// dell'intestazione (incluse le vuote, parte del blocco) appartiene
		// al blocco; la prima riga non più indentata lo chiude e viene poi
		// processata come riga normale.
		if (blockField !== null) {
			if (isBlank) {
				blockLines.push("");
				continue;
			}
			if (indent > blockIndent) {
				// YAML: il contenuto del literal block viene deindentato rispetto
				// all'indentazione della PRIMA riga di contenuto (non del marker
				// `|`): es. `systemPrompt: |` a indent 4 con righe a indent 6.
				if (blockContentIndent === null) blockContentIndent = indent;
				blockLines.push(rawLine.slice(blockContentIndent));
				continue;
			}
			endBlockScalar();
		}

		if (isBlank || content.startsWith("#")) continue;

		if (mode === "roles") {
			if (indent === 0) {
				// Fine della sezione roles_virtuals: committa il ruolo corrente.
				endBlockScalar();
				commitRole();
				mode = "top";
				// fall through: la riga corrente è una chiave top-level.
			} else if (indent === 2) {
				const match = content.match(KEY_VALUE_RE);
				if (match) {
					endBlockScalar();
					commitRole();
					// Un valore inline non è un map valido: la entry parte con
					// campi vuoti e viene saltata dal check required field.
					roleKey = match[1]!;
					roleFields = {};
				}
				continue;
			} else if (indent === 4) {
				if (roleFields === null) continue; // campo senza header di ruolo
				const match = content.match(KEY_VALUE_RE);
				if (!match) continue;
				const key = match[1]! as VirtualFieldName;
				if (!REQUIRED_VIRTUAL_FIELD_NAMES.includes(key)) continue;
				const value = stripInlineComment(match[2]!);
				if (value === "|") {
					blockField = key;
					blockIndent = indent;
					blockContentIndent = null;
					blockLines = [];
				} else {
					roleFields[key] = value;
				}
				continue;
			}
			continue; // indentazioni fuori schema: ignorate (lenient)
		}

		// mode === "top"
		if (indent !== 0) continue; // riga indentata fuori posto: ignorata
		const match = content.match(KEY_VALUE_RE);
		if (!match) continue; // riga senza chiave: ignorata
		const key = match[1]!;
		const value = stripInlineComment(match[2]!);

		if (key === "rounds_default") {
			const n = Number(value);
			if (!Number.isInteger(n) || n < 1) {
				warnings.push(
					`rounds_default must be a positive integer (got ${value}) — using code defaults`,
				);
			} else {
				config.roundsDefault = n;
			}
		} else if (key === "model_default") {
			if (value !== "") config.modelDefault = value;
		} else if (key === "roles_virtuals") {
			if (value === "" || value === "{}") {
				mode = "roles";
			} else {
				return {
					config: emptyConfig(),
					warnings,
					fatal: `roles_virtuals must be a mapping (got '${value}')`,
				};
			}
		}
		// Chiavi top-level sconosciute: ignorate silenziosamente (forward-compat).
	}

	// Block scalar ancora aperto a fine input (es. ultima riga del file).
	if (blockField !== null && roleFields) {
		roleFields[blockField] = blockLines.join("\n").trim();
	}
	commitRole();

	return { config, warnings, fatal: null };
}

/**
 * Legge e parsa il coordination file per-progetto (mai throw, D053).
 *
 * Ritorna `{ config, warnings, sourcePath }`; sul parse error la config è
 * vuota e il chiamante resta sui code defaults. ENOENT → `sourcePath: null`
 * senza alcun log (il file è opzionale).
 */
export function loadDiscussionArenaCoordination(
	filePath: string,
): LoadDiscussionArenaCoordinationResult {
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf-8");
	} catch (err) {
		if (isEnoent(err)) {
			return { config: emptyConfig(), warnings: [], sourcePath: null };
		}
		// EACCES, EISDIR, I/O error: fallback diagnostico, mai throw.
		const reason = err instanceof Error ? err.message : String(err);
		const warning = `coordination parse error: ${reason} — using code defaults`;
		logStderr(warning);
		return { config: emptyConfig(), warnings: [warning], sourcePath: filePath };
	}

	// Normalizzazione CRLF / CR (file scritti su Windows).
	const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	if (!normalized.startsWith("---")) {
		// File senza frontmatter: nessuna configurazione (no-op silenzioso).
		return { config: emptyConfig(), warnings: [], sourcePath: filePath };
	}

	const yaml = extractFrontmatter(normalized);
	if (yaml === null) {
		const warning =
			"coordination parse error: unterminated frontmatter (missing closing ---) — using code defaults";
		logStderr(warning);
		return { config: emptyConfig(), warnings: [warning], sourcePath: filePath };
	}

	const parsed = parseCoordinationFrontmatter(yaml);
	if (parsed.fatal !== null) {
		const fatalWarning = `coordination parse error: ${parsed.fatal} — using code defaults`;
		const warnings = [...parsed.warnings, fatalWarning];
		for (const warning of warnings) logStderr(warning);
		return { config: emptyConfig(), warnings, sourcePath: filePath };
	}

	for (const warning of parsed.warnings) logStderr(warning);
	return {
		config: parsed.config,
		warnings: parsed.warnings,
		sourcePath: filePath,
	};
}
