/**
 * Loader del file di coordination della discussion-arena per-progetto
 * (S03/M004, T01).
 *
 * Il file `<cwd>/.gsd/discussion-arena/discussion-arena-coordination.md`
 * definisce la "forma" della discussion arena, ed è la fonte canonica per:
 *   - `rounds_default`: default dei round quando né il tool né il command
 *     passano un valore esplicito (livello 3 della gerarchia a 4 livelli,
 *     consumato dal resolver `resolveRoundsDefault` di T03);
 *   - `model_default`: modello di fallback per i participant senza `model`
 *     esplicito (consumato da `discoverParticipants`, T02);
 *   - `roles_virtuals`: ruoli one-off definiti interamente qui, senza file in
 *     `participants/` (participant di prima classe con `source: "virtual"`,
 *     applicati da T02);
 *   - `activation`: shape della sezione di attivazione della discussion arena
 *     (S01/M007) — `{ enabled, mode, milestones }` con la stessa grammatica
 *     del blocco `discussion_arena:` di PREFERENCES.md. Il corpo della
 *     sezione viene delegato al parser condiviso `parseDiscussionArenaBlock`
 *     (indentation shape identica: sub-chiavi 2 spazi, milestone ID 4 spazi,
 *     chiavi di milestone 6 spazi), così mode e milestone ID restano
 *     allineati per costruzione a `DISCUSSION_ARENA_MODES` e `MID_RE`.
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
 * Zero dipendenze npm (D004): solo `node:fs` e il parser condiviso
 * `parse-discussion-arena-block.ts` (nessun pacchetto YAML).
 */

import * as fs from "node:fs";
import {
	type DiscussionArenaMode,
	parseDiscussionArenaBlock,
} from "./parse-discussion-arena-block.js";

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

/** Chiavi dei sotto-blocchi schema del blocco `research_decision_format:`. */
const RESEARCH_SCHEMA_KEYS = [
	"hypotheses_schema",
	"decisions_schema",
	"requirements_schema",
] as const;

type ResearchSchemaKey = (typeof RESEARCH_SCHEMA_KEYS)[number];

/**
 * Configurazione del blocco `research_decision_format:` (M008/S04, T01).
 *
 * Dichiarazione versionata del formato di output della discussion arena in
 * fase research-decision (ipotesi, decisioni, requisiti), documentata nel
 * coordination file.
 *
 * Il blocco è opzionale: i vecchi coordination file che non lo contengono
 * caricano senza warning. La `version` deve essere un intero positivo; i
 * tre blocchi `*_schema` sono la "nested structure" del formato dichiarata
 * dal progetto e vengono preservati come corpo de-indentato (testo grezzo):
 * il loader non ne interpreta la semantica, è un contratto documentale
 * opzionale consumato dall'ingestion flow di T02.
 *
 * Mai throw: version non valida, schema assenti o blocco scalare inline
 * producono un warning D053 e il blocco viene scartato (config vuota), il
 * resto del coordination file resta valido.
 */
export interface DiscussionArenaResearchDecisionFormatConfig {
	/** Versione del formato (intero positivo, validato dal loader). */
	version?: number;
	/** Corpo de-indentato dello schema ipotesi (nested structure opzionale). */
	hypotheses_schema?: string;
	/** Corpo de-indentato dello schema decisioni. */
	decisions_schema?: string;
	/** Corpo de-indentato dello schema requisiti. */
	requirements_schema?: string;
}

/** Configurazione dell'opt-in `ingestion:` del coordination file (M008/S04/T02). */
export interface DiscussionArenaIngestionConfig {
	/** Abilitazione globale dell'ingestion per questo progetto. */
	enabled?: boolean;
}

/** Configurazione della sezione `activation:` del coordination file (S01/M007). */
export interface DiscussionArenaActivationConfig {
	/** Abilitazione globale della discussion arena per questo progetto. */
	enabled?: boolean;
	/** Modalità di attivazione (stesso enum del blocco `discussion_arena:` di PREFERENCES). */
	mode?: DiscussionArenaMode;
	/** Abilitazione per-milestone: chiave = milestone ID (shape permissiva MID_RE). */
	milestones?: Record<string, { enabled?: boolean }>;
}

/** Configurazione della "forma" della discussion arena letta dal coordination file. */
export interface DiscussionArenaCoordinationConfig {
	/** Default dei round quando tool/command non passano un valore esplicito. */
	roundsDefault?: number;
	/** Modello di fallback per i participant senza `model` esplicito (T02). */
	modelDefault?: string;
	/** Ruoli virtuali per chiave di dict (chiave canonica del ruolo). */
	rolesVirtuals: Record<string, DiscussionArenaVirtualRole>;
	/** Sezione `activation:` — shape compatibile con `DiscussionArenaBlock` (S01). */
	activation?: DiscussionArenaActivationConfig;
	/** Blocco `research_decision_format:` versionato (M008/S04, T01, opzionale). */
	researchDecisionFormat?: DiscussionArenaResearchDecisionFormatConfig;
	/** Sezione `ingestion:` — opt-in del flow di ingest (M008/S04, T02). */
	ingestion?: DiscussionArenaIngestionConfig;
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
 *   activation:                             (livello 0, apre la sezione attivazione)
 *     enabled: <bool>                       (livello 2)
 *     mode: <per-milestone|always-on|availability-only>   (livello 2)
 *     milestones:                           (livello 2)
 *       <milestone ID>:                     (livello 4)
 *         enabled: <bool>                   (livello 6)
 *   Il corpo della sezione `activation:` viene delegato a
 *   `parseDiscussionArenaBlock` (stessa indentation shape del blocco
 *   `discussion_arena:` di PREFERENCES): mode fuori enum e milestone ID fuori
 *   MID_RE vengono scartati in modalità lenient, come nel parser condiviso.
 *
 * Regole di robustezza:
 *   - righe vuote e commenti `#` ignorati (le righe vuote DENTRO un block
 *     scalar sono parte del blocco, come da YAML);
 *   - linee che non matchano `chiave: valore` ignorate (lenient);
 *   - campo con valore vuoto = campo mancante (skip della entry con D053);
 *   - `roles_virtuals` con valore scalare inline → errore strutturale fatale
 *     (config scartata con D053 generico);
 *   - `activation` con valore scalare inline → stesso comportamento fatale
 *     (la sezione deve essere una mappatura).
 */
function parseCoordinationFrontmatter(yaml: string): ParsedFrontmatter {
	const config = emptyConfig();
	const warnings: string[] = [];

	const lines = yaml.split("\n");
	let mode: "top" | "roles" | "activation" | "research" | "ingestion" = "top";
	/** Righe raw del corpo della sezione `activation:` (delegate a parseDiscussionArenaBlock). */
	let activationLines: string[] = [];
	/** Righe raw del corpo del blocco `research_decision_format:` (parse in `parseResearch`). */
	const researchLines: string[] = [];
	/** Righe raw del corpo della sezione `ingestion:` (parse in `parseIngestion`). */
	let ingestionLines: string[] = [];
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

	/**
	 * Committa la sezione `activation:` delegando il corpo al parser
	 * condiviso `parseDiscussionArenaBlock` e trasformandone gli scarti
	 * (mode vuoto/fuori enum, milestone ID fuori MID_RE, enabled non-bool) in
	 * warning D053 — stessa policy never-throw del loader (validazione
	 * runtime T02). I warning vengono raccolti come stringhe nel vettore
	 * `warnings`, e poi emessi su stderr dal chiamante.
	 */
	const parseActivation = (lines: readonly string[]): void => {
		config.activation = parseDiscussionArenaBlock(lines, {
			onDiscard: (kind, value) => {
				if (kind === "mode") {
					warnings.push(
						value === ""
							? "activation mode is empty — skipped"
							: `activation mode '${value}' must be one of per-milestone, always-on, availability-only — skipped`,
					);
				} else if (kind === "milestone") {
					warnings.push(
						`activation milestone '${value}' does not match MID_RE — skipped`,
					);
				} else {
					warnings.push(
						`activation enabled must be a boolean (got '${value}') — skipped`,
					);
				}
			},
		});
	};

	/**
	 * Committa il blocco `research_decision_format:` (scrittura su
	 * `config.researchDecisionFormat`): mai throw, ogni errore (version non
	 * positiva, blocco senza schema, body malformato) scarta SOLO questo
	 * blocco con un warning D053 — il resto del coordination file resta
	 * valido (forward-compat). La `*_schema` di ogni sotto-blocco viene
	 * preservata come corpo de-indentato (testo grezzo), senza interpretarne
	 * la semantica: il loader non consuma la nested structure, è un
	 * contratto documentale opzionale per l'ingestion flow di T02.
	 */
	const parseResearch = (raw: readonly string[]): void => {
		const lines = raw.map((l) => l);
		const format: DiscussionArenaResearchDecisionFormatConfig = {};
		let versionRaw: string | null = null;
		let i = 0;
		while (i < lines.length) {
			const line = lines[i]!;
			const content = line.trim();
			if (content === "" || content.startsWith("#")) {
				i++;
				continue;
			}
			const match = content.match(KEY_VALUE_RE);
			if (!match) {
				i++; // riga senza chiave: ignorata (lenient)
				continue;
			}
			const key = match[1]!;
			const value = stripInlineComment(match[2]!);
			const keyIndent = leadingSpaces(line);
			if (key === "version") {
				versionRaw = value;
				i++;
				continue;
			}
			if ((RESEARCH_SCHEMA_KEYS as readonly string[]).includes(key)) {
				const field = key as ResearchSchemaKey;
				if (value !== "") {
					// schema inline scalare: accettato come corpo breve.
					format[field] = value;
					i++;
					continue;
				}
				// Schema annidato: raccoglie le righe più indentate dell'intestazione
				// (incluse le vuote), deindentate rispetto al contenuto.
				const body: string[] = [];
				let bodyIndent: number | null = null;
				let j = i + 1;
				for (; j < lines.length; j++) {
					const l = lines[j]!;
					if (l.trim() === "") {
						body.push("");
						continue;
					}
					if (leadingSpaces(l) <= keyIndent) break;
					if (bodyIndent === null) bodyIndent = leadingSpaces(l);
					body.push(l.slice(bodyIndent));
				}
				format[field] = body.join("\n").trim();
				i = j;
				continue;
			}
			// Chiave sconosciuta dentro il blocco: ignorata (forward-compat).
			i++;
		}

		if (versionRaw === null || versionRaw === "") {
			warnings.push(
				"research_decision_format version must be a positive integer (got empty) — block discarded",
			);
			return; // blocco scartato
		}
		const n = Number(versionRaw);
		if (!Number.isInteger(n) || n < 1) {
			warnings.push(
				`research_decision_format version must be a positive integer (got ${versionRaw}) — block discarded`,
			);
			return; // blocco scartato
		}
		format.version = n;

		if (
			!format.hypotheses_schema &&
			!format.decisions_schema &&
			!format.requirements_schema
		) {
			warnings.push(
				"research_decision_format is missing a schema block (hypotheses_schema, decisions_schema, requirements_schema) — block discarded",
			);
			return; // blocco scartato
		}
		config.researchDecisionFormat = format;
	};

	/**
	 * Committa la sezione `ingestion:` (opt-in del flusso di ingest, T02).
	 * Mai throw: legge `enabled` (boolean); se assente o non-booleano →
	 * `enabled` resta undefined con warning D053; chiavi sconosciute ignorate
	 * (forward-compat). `ingestion: {}` = no-op. Il resto della config resta
	 * valido.
	 */
	const parseIngestion = (lines: readonly string[]): void => {
		const cfg: DiscussionArenaIngestionConfig = {};
		for (const line of lines) {
			const content = line.trim();
			if (content === "" || content.startsWith("#")) continue;
			const match = content.match(KEY_VALUE_RE);
			if (!match) continue;
			if (match[1] !== "enabled") continue; // chiave sconosciuta: ignorata
			const raw = stripInlineComment(match[2]!);
			if (raw === "true") cfg.enabled = true;
			else if (raw === "false") cfg.enabled = false;
			else {
				warnings.push(
					`ingestion enabled must be a boolean (got '${raw}') — skipped`,
				);
			}
		}
		config.ingestion = cfg;
	};

	/** Chiude il blocco scalar corrente scrivendo il contenuto nel campo. */
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
			} else {
				continue; // indentazioni fuori schema: ignorate (lenient)
			}
		}

		if (mode === "research") {
			if (indent === 0) {
				// Fine del blocco research_decision_format: parse e committa
				// (mai throw — scarta SOLO il blocco con warning D053).
				parseResearch(researchLines);
				mode = "top";
				// fall through: la riga è una chiave top-level.
			} else {
				researchLines.push(rawLine);
				continue;
			}
		}

		if (mode === "ingestion") {
			if (indent === 0) {
				// Fine della sezione ingestion: parse e committa (mai throw).
				parseIngestion(ingestionLines);
				mode = "top";
				// fall through: la riga è una chiave top-level.
			} else {
				ingestionLines.push(rawLine);
				continue;
			}
		}

		if (mode === "activation") {
			if (indent === 0) {
				// Fine della sezione activation: parse e committa. Il parser
				// condiviso applica la stessa grammatica del blocco
				// `discussion_arena:` (mode lenient, MID_RE permissivo); gli
				// scarti diventano warning D053 (validazione runtime T02).
				parseActivation(activationLines);
				mode = "top";
				// fall through: la riga corrente è una chiave top-level.
			} else {
				activationLines.push(rawLine);
				continue;
			}
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
		} else if (key === "activation") {
			if (value === "" || value === "{}") {
				mode = "activation";
				activationLines = [];
			} else {
				return {
					config: emptyConfig(),
					warnings,
					fatal: `activation must be a mapping (got '${value}')`,
				};
			}
		} else if (key === "ingestion") {
			if (value === "" || value === "{}") {
				mode = "ingestion";
				ingestionLines = [];
			} else {
				// Sezione scalare inline: contratto violato — scartata SOLO essa
				// (non-fatale, come research_decision_format): il resto vale.
				warnings.push(
					`ingestion must be a mapping (got '${value}') — section discarded`,
				);
			}
		} else if (key === "research_decision_format") {
			if (value === "") {
				mode = "research";
				researchLines.length = 0;
			} else if (value === "{}") {
				// Blocco vuoto esplicito: nessuna config, nessun warning (no-op).
			} else {
				// Scala inline: contratto violato — scartato SOLO questo blocco
				// (non-fatale, a differenza di roles_virtuals/activation).
				warnings.push(
					`research_decision_format must be a mapping (got '${value}') — block discarded`,
				);
			}
		}
		// Chiavi top-level sconosciute: ignorate silenziosamente (forward-compat).
	}

	// Blocco research_decision_format ancora aperto a fine input (file che
	// termina col corpo del blocco, senza una chiave top-level successiva).
	if (mode === "research") {
		parseResearch(researchLines);
	}

	// Block scalar ancora aperto a fine input (es. ultima riga del file).
	if (blockField !== null && roleFields) {
		roleFields[blockField] = blockLines.join("\n").trim();
	}
	commitRole();

	// Sezione activation ancora aperta a fine input (file che termina con il
	// corpo della sezione, senza una chiave top-level successiva).
	if (mode === "activation") {
		parseActivation(activationLines);
	}

	// Sezione ingestion ancora aperta a fine input.
	if (mode === "ingestion") {
		parseIngestion(ingestionLines);
	}

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
