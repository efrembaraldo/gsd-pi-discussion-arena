/**
 * Agent Discussion Arena — Participant discovery
 *
 * Carica le definizioni dei partecipanti da file Markdown con frontmatter,
 * stesso formato usato dal subagent tool bundled in
 * packages/pi-coding-agent/examples/extensions/subagent/agents.ts, così i
 * ruoli già portati da BMAD-METHOD (analyst, pm, architect, dev, ux-designer,
 * tech-writer) sono riutilizzabili senza conversione.
 *
 * Differenza deliberata rispetto all'esempio upstream: la ricerca a livello
 * di progetto punta a `.gsd/discussion-arena/participants` (non `.pi/agents`),
 * perché questo file non passa dal seam vendoring di ADR-010 — è codice
 * originale scritto per gsd-pi, non codice pi vendorizzato.
 *
 * Cinque sorgenti di partecipanti (precedenza highest → lowest):
 *   override — `.gsd/discussion-arena/participants-overrides/*.md`, walk-up
 *              verso la root git come il tier project; un file per ruolo con
 *              lo stesso formato frontmatter di `participants/*.md`, ma con
 *              sostituzione TOTALE del file base (tier 0, precedenza assoluta).
 *              Un override senza corrispondente base (project ∪ user ∪ bundled
 *              ∪ virtual) è un orfano: discoverParticipants lancia un errore
 *              bloccante, nessun fallback silenzioso.
 *   virtual — `.gsd/discussion-arena/discussion-arena-coordination.md` →
 *              `roles_virtuals`: ruoli one-off definiti interamente nel
 *              coordination file, participant di prima classe senza alcun
 *              file in `participants/` (source: "virtual", filePath =
 *              coordination file). Sorgente S03: sta tra base e override nella
 *              precedenza (base < virtual < override, D052); un override che
 *              punta a un ruolo virtuale NON è orfano.
 *   project — `.gsd/discussion-arena/participants/*.md`, walk-up verso la root git
 *   user    — `~/.gsd/agent/discussion-arena/participants/*.md`
 *   bundled — `participants/*.md` accanto al modulo installato (esempi
 *             dell'estensione; l'utente li sovrascrive con i propri).
 * Dopo l'install l'utente ha già i 4 esempi (analyst/architect/dev/qa) bundled
 * e la discussion-arena è utilizzabile senza setup aggiuntivo.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter } from "@gsd/pi-coding-agent";
import type { ParticipantLimitsInput } from "./helpers.js";
import {
	DISCUSSION_ARENA_COORDINATION_DIR,
	DISCUSSION_ARENA_COORDINATION_FILENAME,
	loadDiscussionArenaCoordination,
} from "./src/discussion-arena-coordination.js";
import {
	resolveAgentDir,
	DISCUSSION_ARENA_USER_COORDINATION_RELATIVE_PATH,
} from "./src/agent-dir.js";

export type ParticipantSource =
	| "override"
	| "virtual"
	| "user"
	| "project"
	| "bundled";

/**
 * Engine di esecuzione di un participant (M015): "gsd" = flusso di prompt
 * interno dell'estensione (default storico); "hermes" = runtime esterno che
 * consuma il system prompt parsato + un set di toolsets/skills (S02 cablaggio
 * runtime). La string literal union è deliberatamente chiusa: valori non
 * riconosciuti degradano al default "gsd" via `normalizeEngine` invece di
 * essere accettati come engine validi.
 */
export type ParticipantEngine = "gsd" | "hermes";

/**
 * Normalizza `raw` (valore grezzo dal frontmatter, già deserializzato YAML)
 * a un `ParticipantEngine` valido. Fail-safe per design:
 *   - stringa uguale a "hermes" case-insensitive (Hermes/HERMES/heRmEs) → "hermes";
 *   - qualsiasi altro valore (incluso undefined, null, "", numeri, oggetti,
 *     array, simboli, getter che lanciano) → "gsd".
 * Mai lancia: tutti gli input passano per `String(raw).toLowerCase()` e il
 * confronto è una semplice uguaglianza di stringa. Consumata da
 * `parseParticipantContent` per popolare il campo `engine` del
 * `ParticipantConfig`; può anche essere usata dai consumer (es. index.ts in
 * S02) per defaulting runtime.
 */
export function normalizeEngine(raw: unknown): ParticipantEngine {
	try {
		if (typeof raw === "string" && raw.toLowerCase() === "hermes") {
			return "hermes";
		}
	} catch {
		// typeof check + toLowerCase non lancia su stringa, ma un getter
		// malevolo sulla conversione implicita potrebbe: degradiamo a "gsd".
	}
	return "gsd";
}

/**
 * M018/S01 (R055): sottoinsieme di `ParticipantConfig` che il pattern
 * partial-override (campi `extends` + `merge` sui file
 * `participants-overrides/<role>.md`) può sovrascrivere per-campo quando
 * eredita da un base. Esattamente 7 campi:
 *
 *   - `model`, `provider`, `systemPrompt`, `tools`, `limits`, `description`, `role`
 *
 * I campi `name`, `engine`, `hermesToolsets`, `hermesSkills`,
 * `softDeadlineMs`, `source`, `filePath` sono ESPLICITAMENTE esclusi:
 * `name` resta sempre quello del file override (può coincidere o meno col
 * base) per non rompere la chiave del Map di discovery, `source`/`filePath`
 * devono restare quelli dell'override per onestà di provenienza (il
 * consumer in index.ts logga `override applied: <role> from <path>`
 * riferito al file override), `engine`/`hermesToolsets`/`hermesSkills`/
 * `softDeadlineMs` sono cablaggi runtime gestiti da S02 e non rientrano
 * nel pattern opt-in di M018. Validazione della whitelist demandata al
 * loader (`loadOverrideParticipantsFromDir`, T02): un campo fuori dai 7
 * in `merge:` lancia errore bloccante.
 */
export type ParticipantMergeableFields = Pick<
	ParticipantConfig,
	| "model"
	| "provider"
	| "systemPrompt"
	| "tools"
	| "limits"
	| "description"
	| "role"
>;

export interface ParticipantConfig {
	/** Identificativo usato per invocare il partecipante (es. "architect") */
	name: string;
	/** Ruolo/competenza mostrato nel transcript della discussion-arena */
	role: string;
	/** Descrizione breve — usata anche nel promptSnippet del tool */
	description: string;
	/** Sottoinsieme di tool concessi al partecipante durante la discussione (opzionale) */
	tools?: string[];
	/** Override modello per questo partecipante (es. "minimax-m3") */
	model?: string;
	/**
	 * Engine di esecuzione del participant (M015/S01). Default "gsd": il
	 * flusso di prompt interno dell'estensione, già funzionante per i 4
	 * partecipanti bundled. "hermes" delega il prompt a un runtime esterno
	 * che consuma systemPrompt + `hermesToolsets` + `hermesSkills`. Parsing
	 * case-insensitive via `normalizeEngine()` (raw "Hermes" / "HERMES" /
	 * "hermes" tutti mappati a "hermes"); retrocompat: un participant
	 * pre-M015 senza campo `engine` resta `undefined` e il consumer in S02
	 * decide il defaulting.
	 */
	engine?: ParticipantEngine;
	/**
	 * Provider esplicito per il participant (M015/S01). Passato raw dal
	 * frontmatter, non validato qui: il parsing/provider resolution è
	 * responsabilità del runtime engine (S02 cablaggio). Stringa libera
	 * perché i provider sono un set aperto ("anthropic", "openai",
		"minimax-m3", ...).
	 */
	provider?: string;
	/**
	 * Lista di toolsets hermes concessi al participant (M015/S01). Parsing
	 * CSV come per `tools` (split su ",", trim, filter Boolean). Consumato
	 * solo se `engine === "hermes"`; undefined per engine "gsd" o per
	 * participant che non li dichiara.
	 */
	hermesToolsets?: string[];
	/**
	 * Lista di skills hermes concesse al participant (M015/S01). Parsing CSV
	 * speculare a `hermesToolsets`. Consumato solo se `engine === "hermes"`.
	 */
	hermesSkills?: string[];
	/**
	 * Soft deadline in millisecondi per il participant (M015/S01). Limite
	 * upper-bound "morbido" sul tempo di esecuzione: oltre questa soglia il
	 * runtime può emettere un warning o preparare un graceful-shutdown,
	 * senza interrompere il flow (a differenza di `roundTimeoutMs`/`eventTimeoutMs`,
	 * che sono limiti hard a livello di round/evento). Parsato dal frontmatter
	 * snake_case `soft_deadline_ms` (vedi LIMITS_FRONTMATTER_KEYS).
	 */
	softDeadlineMs?: number;
	/**
	 * Limiti participante letti dal frontmatter (livello "frontmatter" del
	 * merge a 3 livelli tool > frontmatter > defaults, S02/M003). Campi
	 * `unknown` non ancora validati: la validazione/merge è responsabilità di
	 * `resolveParticipantLimits` (helpers.ts), consumata da
	 * `resolveParticipantLimitsForParticipant` in index.ts (S02/T02). Sempre
	 * presente (oggetto vuoto se il frontmatter non definisce alcun campo
	 * limite), così i consumer non devono gestire `undefined`.
	 */
	limits: ParticipantLimitsInput;
	/** Corpo del file .md dopo il frontmatter: il system prompt del ruolo */
	systemPrompt: string;
	source: ParticipantSource;
	filePath: string;

	// ─── M018/S01: partial-override (R055) ─────────────────────────────
	// I 3 campi seguenti abilitano il pattern opt-in `extends + merge` sui
	// file in `.gsd/discussion-arena/participants-overrides/`. Restano
	// `undefined` per i file base in `participants/` (tier project/user/
	// bundled/virtual) e per gli override D052 (sostituzione totale) —
	// vedi `loadOverrideParticipantsFromDir` per il routing. Il campo
	// `mergedFrom` è l'unico popolato dal loader (post-merge), gli altri
	// due sono deserializzati dal frontmatter via `parseParticipantContent`.

	/**
	 * M018/S01 (R055): nome del participant base da cui ereditare quando
	 * il file override applica il pattern partial-override opt-in
	 * (`participants-overrides/<role>.md` con `extends: <base>` + `merge:`).
	 * Valorizzato SOLO sui file di override che lo dichiarano; il loader
	 * `loadOverrideParticipantsFromDir` instrada gli override con
	 * `extends !== undefined` verso il path partial-override, mentre gli
	 * override senza `extends` continuano con la sostituzione totale D052
	 * (retrocompat). Non influenza `name` finale (che resta quello del
	 * file override, può coincidere o meno col base — il base `name` è
	 * la chiave del Map di discovery, l'override `name` è ciò che il
	 * consumer vede). Quando valorizzato, deve puntare a un base
	 * esistente (project ∪ user ∪ bundled ∪ virtual); un base mancante
	 * lancia errore bloccante (`override target '<role>' not found in
	 * participants/`).
	 */
	extends?: string;

	/**
	 * M018/S01 (R055): subset di campi da sovrascrivere sul base quando
	 * `extends` è valorizzato. Solo i 7 campi elencati in
	 * `ParticipantMergeableFields` sono ammessi:
	 * `model` | `provider` | `systemPrompt` | `tools` | `limits` |
	 * `description` | `role`. Un campo fuori whitelist è errore
	 * bloccante (`field '<key>' is not mergeable: <role> from <path>`).
	 * Validazione di non-vuoto: `extends` senza `merge` non-vuoto è
	 * errore bloccante (`extends without merge: <role> from <path>`) —
	 * no-op silenzioso vietato. Il parsing del blocco nested `merge:`
	 * è demandato all'helper locale `parseMergeBlock`, che gestisce
	 * la sintassi YAML-like indentation-aware (limitata al subset
	 * richiesto: scalari, array inline `[a, b]`, oggetto inline
	 * `{ key: val }`).
	 */
	merge?: Partial<ParticipantMergeableFields> & {
		/**
		 * M018/S01 (R055): chiavi raw del blocco `merge:` non in
		 * `ParticipantMergeableFields` (campo extra accumulato da
		 * `parseMergeBlock`, vedi default case del parser). Il loader
		 * T02 ispeziona questo campo per lanciare
		 * `field '<key>' is not mergeable: <role> from <path>` sulla
		 * prima chiave fuori dai 7 ammessi. Senza questo
		 * passaggio intermedio, il throw sarebbe un dead-code path:
		 * il parser scarterebbe le chiavi sconosciute PRIMA che la
		 * whitelist di T02 possa vederle. Empty array (= campo
		 * assente) = tutti i campi del merge sono mergeable, il
		 * merge può procedere.
		 */
		unknownKeys?: readonly string[];
	};

	/**
	 * M018/S01 (R055): marker osservabilità popolato post-merge dal
	 * loader `loadOverrideParticipantsFromDir` quando l'override
	 * applica il path partial-override. Contiene il nome del base
	 * ereditato (== `extends` del file override). Presente SOLO per gli
	 * override che hanno applicato un merge; `undefined` per i file
	 * base in `participants/` e per gli override D052 (sostituzione
	 * totale). Consumato dai consumer (index.ts) che loggano i marker
	 * canonicali del partial-override nel transcript della
	 * discussion-arena, speculare a `source`/`filePath` del base.
	 */
	mergedFrom?: string;
	// ───────────────────────────────────────────────────────────────────
}

export interface ParticipantDiscoveryResult {
	participants: ParticipantConfig[];
	projectParticipantsDir: string | null;
	/** Directory del tier 0 override (`.gsd/discussion-arena/participants-overrides`), null se assente. */
	overridesDir: string | null;
	/**
	 * Ruoli il cui file override non ha un corrispondente base in
	 * participants/ (project ∪ user ∪ bundled ∪ virtual). Sempre `[]` quando
	 * la chiamata restituisce: un override orfano lancia `Error` bloccante.
	 */
	orphanOverrides: readonly string[];
	/** Path del coordination file letto (S03), o null se nessuno è attivo. */
	coordinationPath: string | null;
	/**
	 * Valori di forma della discussion-arena letti dal coordination file (S03):
	 * `roundsDefault` (livello 3 della gerarchia rounds, consumato da T03) e
	 * `modelDefault` (fallback per-participant applicato ai participant senza
	 * `model` esplicito). Oggetto vuoto quando nessun coordination file è
	 * attivo o non definisce questi campi.
	 */
	coordination: { roundsDefault?: number; modelDefault?: string };
}

export interface DiscoverParticipantsOptions {
	/** Se true, esclude la discovery dei partecipanti bundled con l'estensione (utile nei test). */
	skipBundled?: boolean;
	/**
	 * Directory override esplicita (tier 0). Default: walk-up da `cwd` verso
	 * `.gsd/discussion-arena/participants-overrides` (stessa regola di
	 * `findNearestProjectParticipantsDir`). Se il path esplicito non esiste,
	 * nessun override viene applicato.
	 */
	overridesDir?: string;
	/**
	 * Path esplicito del coordination file `discussion-arena-coordination.md`
	 * (S03): popola i virtual roles (`roles_virtuals`) come participant di
	 * prima classe e i valori di forma (`rounds_default`, `model_default`).
	 * Default: walk-up da `cwd` verso
	 * `.gsd/discussion-arena/discussion-arena-coordination.md` (stessa regola
	 * del tier 0 override). Se il path esplicito non esiste, nessun virtual
	 * role viene applicato (no-op silenzioso).
	 */
	coordinationPath?: string;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

/** Chiave frontmatter snake_case -> campo camelCase di ParticipantLimitsInput. */
const LIMITS_FRONTMATTER_KEYS: ReadonlyArray<
	[keyof ParticipantLimitsInput, string]
> = [
	["roundTimeoutMs", "round_timeout_ms"],
	["eventTimeoutMs", "event_timeout_ms"],
	["outputLimitChars", "output_limit_chars"],
	["costBudgetUsd", "cost_budget_usd"],
	["termination", "termination"],
	["softDeadlineMs", "soft_deadline_ms"],
];

/**
 * Estrae i 6 campi limits dal frontmatter grezzo (snake_case) in un
 * `ParticipantLimitsInput` (camelCase) — livello "frontmatter" del merge a 3
 * livelli tool > frontmatter > defaults (S02/M003). Nessuna validazione qui:
 * i valori restano `unknown` (il parser YAML reale può restituire number,
 * string o altro a seconda dello scalare) e vengono validati a runtime da
 * `resolveParticipantLimits` (helpers.ts, consumata da
 * `resolveParticipantLimitsForParticipant` in index.ts, S02/T02). Campi
 * assenti dal frontmatter restano `undefined` nell'oggetto risultante, così
 * `resolveParticipantLimits` scende al livello successivo della catena.
 *
 * M015 aggiunge `soft_deadline_ms` come 6° campo (S01/T01): limite
 * upper-bound "morbido" sul tempo di esecuzione del participant, distinto da
 * `round_timeout_ms` / `event_timeout_ms` (limiti hard a livello round/evento).
 */
function parseLimitsFromFrontmatter(
	frontmatter: Record<string, unknown>,
): ParticipantLimitsInput {
	const limits: ParticipantLimitsInput = {};
	for (const [camelKey, snakeKey] of LIMITS_FRONTMATTER_KEYS) {
		const raw = frontmatter[snakeKey];
		if (raw !== undefined) {
			limits[camelKey] = raw;
		}
	}
	return limits;
}

/**
 * M018/S01 (R055): mini-parser indentation-aware per il blocco `merge:`
 * annidato nel frontmatter di un file di override. Il parser frontmatter
 * bundled (`@gsd/pi-coding-agent/parseFrontmatter`, e il suo stub nei
 * test `tests/fixtures/pi-coding-agent-stub.ts:54-93`) gestisce SOLO
 * valori scalari flat e array inline `[a, b]`; non gestisce blocchi
 * nested come:
 *
 * ```yaml
 * merge:
 *   model: claude-opus-5
 *   tools: [web_search, calculator]
 *   limits: { round_timeout_ms: 1000 }
 *   description: Scribe con model override
 * ```
 *
 * Questo helper è chiamato da `parseParticipantContent` SOLO quando il
 * frontmatter dichiara `extends:` (il resto del frontmatter flat resta
 * parsato da `parseFrontmatter` come prima). Limitato deliberatamente
 * al subset richiesto da R055 — non è un parser YAML generico:
 *
 *  - Riconosce `merge:` SOLO a colonna 0 (top-level del frontmatter); un
 *    eventuale `merge:` annidato dentro altri blocchi è ignorato.
 *  - Righe vuote e commenti `#` sono tollerati ovunque (anche dentro il
 *    blocco `merge:`).
 *  - Ogni campo mergeable diretto (`model`, `provider`, `systemPrompt`,
 *    `description`, `role`) accetta un valore scalare inline (stringa).
 *  - `tools` accetta array inline `[a, b, c]` (split su "," trim, filter
 *    Boolean — speculare a `frontmatter.tools` esistente).
 *  - `limits` accetta inline `{ key: val, key: val }`. I valori sono
 *    convertiti in number/bool nativo se rappresentabili come tali, le
 *    chiavi snake_case sono mappate al camelCase di `ParticipantLimitsInput`
 *    via `LIMITS_FRONTMATTER_KEYS`. Validazione di schema/range demandata
 *    al loader/runtime (T02 e index.ts) — questo helper si limita a
 *    estrarre raw.
 *  - Campi mergeable con blocchi nested o inline non riconosciuti sono
 *    lasciati `undefined` (no-op silenzioso a livello di parser; il
 *    loader T02 li intercetta se servono). La whitelist effettiva è
 *    applicata in `loadOverrideParticipantsFromDir` (T02).
 *  - Ritorna `{}` se il blocco non è presente, è vuoto o è malformato —
 *    i campi rimangono `undefined` e il chiamante decide se valorizzarli
 *    sul `ParticipantConfig` risultante (logica gated da `extends !==
 *    undefined`, vedi `parseParticipantContent`).
 *
 * Idempotente e mai-throw: input malformato degrada a campi mancanti
 * senza sollevare eccezioni. La sezione YAML passata deve essere solo
 * il frontmatter (tra i marker `---`); il body del file è ignorato
 * perché cade fuori dal blocco `merge:` quando l'override è ben formato.
 */
function parseMergeBlock(
	yaml: string,
): Partial<ParticipantMergeableFields> & { unknownKeys: string[] } {
	const result: Partial<ParticipantMergeableFields> = {};
	const unknownKeys: string[] = [];
	if (!yaml) return { ...result, unknownKeys };

	const lines = yaml.split(/\r?\n/);
	let inMergeBlock = false;
	let mergeChildIndent: number | null = null;

	for (const rawLine of lines) {
		// Tolleranza righe vuote e commenti `#` ovunque.
		const trimmed = rawLine.trim();
		if (trimmed === "" || trimmed.startsWith("#")) continue;

		if (!inMergeBlock) {
			// Top-level `merge:` header (colonna 0, nessun leading whitespace).
			// Accetta `merge:` e `merge: <inline-value>` (inline vuoto = blocco
			// vuoto).
			if (/^merge\s*:/.test(rawLine)) {
				inMergeBlock = true;
				mergeChildIndent = null;
			}
			continue;
		}

		// Dentro il blocco: usciamo quando incontriamo una riga top-level
		// (senza leading whitespace). La riga successiva di un altro campo
		// YAML segna la fine del blocco merge.
		const leadingWs = /^[ \t]*/.exec(rawLine)?.[0] ?? "";
		if (leadingWs.length === 0) {
			inMergeBlock = false;
			mergeChildIndent = null;
			continue;
		}

		// Campo mergeable: `  key: value` (indentazione >= 2).
		const fieldMatch = /^(\s+)([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/.exec(
			rawLine,
		);
		if (!fieldMatch) continue;

		const indent = fieldMatch[1] ?? "";
		const key = fieldMatch[2] ?? "";
		const value = fieldMatch[3] ?? "";

		// Solo i figli diretti del blocco merge (stesso livello di indentazione
		// del primo figlio). Eventuali blocchi nested (es. `tools:` con array
		// multilinea) sono ignorati per semplicità.
		if (mergeChildIndent === null) mergeChildIndent = indent.length;
		if (indent.length !== mergeChildIndent) continue;

		switch (key) {
			case "model":
			case "provider":
			case "systemPrompt":
			case "description":
			case "role": {
				const v = value.trim();
				if (v !== "") result[key] = v;
				break;
			}
			case "tools": {
				const v = value.trim();
				if (v.startsWith("[") && v.endsWith("]")) {
					// Inline `v.slice(1, -1)` direttamente nella catena:
					// evita lexical declaration annidata (lint hint L473).
					result.tools = v
						.slice(1, -1)
						.split(",")
						.map((s) => s.trim())
						.filter(Boolean);
				}
				break;
			}
			case "limits": {
				const v = value.trim();
				if (v.startsWith("{") && v.endsWith("}")) {
					result.limits = parseMergeLimitsInline(v.slice(1, -1));
				}
				break;
			}
			default:
				// M018/S01 (R055): campo merge non riconosciuto. Accumulo in
				// `unknownKeys` per consentire a T02 (loadOverrideParticipantsFromDir)
				// di lanciare `field '<key>' is not mergeable: <role> from <path>`.
				// Senza questo fallback intermedio, T02 non vedrebbe mai la
				// chiave perché verrebbe scartata qui e il throw di whitelist
				// resterebbe un dead-code path (loop `Object.keys` su un merge
				// block senza chiavi sconosciute). L'accumulazione esplicita
				// chiude il gap tra T01 (parser) e T02 (whitelist enforcement).
				unknownKeys.push(key);
				break;
		}
	}

	return { ...result, unknownKeys };
}

/**
 * Converte il contenuto inline `{ key: val, key: val }` di `limits:` in un
 * `ParticipantLimitsInput`. Mappa le chiavi snake_case al camelCase via
 * `LIMITS_FRONTMATTER_KEYS` (stessa convenzione del frontmatter flat).
 * Valori che sembrano numeri (`123`, `-1.5`) sono convertiti in `number`;
 * `true`/`false` in `boolean`; il resto resta stringa. Mai throw: input
 * malformato degrada a campi mancanti.
 */
function parseMergeLimitsInline(
	inner: string,
): ParticipantLimitsInput {
	const limits: ParticipantLimitsInput = {};
	if (!inner.trim()) return limits;

	for (const pairRaw of inner.split(",")) {
		const pair = pairRaw.trim();
		if (!pair) continue;
		const colonIdx = pair.indexOf(":");
		if (colonIdx === -1) continue;
		const rawKey = pair.slice(0, colonIdx).trim();
		const rawVal = pair.slice(colonIdx + 1).trim();
		if (!rawKey) continue;

		let parsedVal: unknown = rawVal;
		if (/^-?\d+$/.test(rawVal)) {
			parsedVal = Number(rawVal);
		} else if (/^-?\d+\.\d+$/.test(rawVal)) {
			parsedVal = Number(rawVal);
		} else if (rawVal === "true" || rawVal === "false") {
			parsedVal = rawVal === "true";
		}

		const mapping = LIMITS_FRONTMATTER_KEYS.find(
			([, snakeKey]) => snakeKey === rawKey,
		);
		const camelKey: keyof ParticipantLimitsInput =
			mapping?.[0] ?? (rawKey as keyof ParticipantLimitsInput);
		limits[camelKey] = parsedVal;
	}
	return limits;
}

/**
 * Parsa un singolo file participant `.md` (frontmatter flat + body) in un
 * `ParticipantConfig`. Condiviso tra la discovery base (`loadParticipantsFromDir`)
 * e il tier 0 override (`loadOverrideParticipantsFromDir`) — mai bifurcare la
 * logica di parsing tra default e override (D-round 5 dev).
 *
 * Ritorna `null` quando il contenuto è irrecuperabile: frontmatter incompleto
 * (manca name/description/role) o assente. Un file illeggibile non arriva qui
 * (il chiamante fa il read e salta).
 *
 * M015/S01/T01: legge anche i 5 nuovi campi opzionali retrocompatibili
 * (`engine`, `provider`, `hermes_toolsets`, `hermes_skills`, `soft_deadline_ms`).
 * Tutti sono popolati SOLO se il frontmatter li dichiara esplicitamente:
 * un participant pre-M015 (analyst/architect/dev/qa/scribe bundled) produce
 * un `ParticipantConfig` con engine/provider/hermesToolsets/hermesSkills/
 * softDeadlineMs tutti `undefined` — nessuna regressione.
 */
function parseParticipantContent(
	content: string,
	filePath: string,
	source: ParticipantSource,
): ParticipantConfig | null {
	const { frontmatter, body } =
		parseFrontmatter<Record<string, string>>(content);

	// name/description/role sono obbligatori: senza "role" il partecipante
	// non ha un'etichetta da mostrare nel transcript della discussion-arena.
	if (!frontmatter.name || !frontmatter.description || !frontmatter.role)
		return null;

	const tools = frontmatter.tools
		?.split(",")
		.map((t: string) => t.trim())
		.filter(Boolean);

	// M015: hermes_toolsets e hermes_skills sono liste CSV speculari a
	// `tools` (split su ",", trim, filter Boolean). Popolati solo se il
	// frontmatter li dichiara (campo undefined altrimenti → conditional
	// spread). Consumati dal runtime hermes engine in S02.
	const hermesToolsets = frontmatter.hermes_toolsets
		?.split(",")
		.map((t: string) => t.trim())
		.filter(Boolean);

	const hermesSkills = frontmatter.hermes_skills
		?.split(",")
		.map((t: string) => t.trim())
		.filter(Boolean);

	const limits = parseLimitsFromFrontmatter(frontmatter);

	// M018/S01 (R055): parsing del blocco `merge:` nested. `parseFrontmatter`
	// gestisce SOLO valori flat (scalari/array inline), non blocchi nested;
	// riusiamo quindi la sezione YAML grezza estratta con lo stesso slicing
	// di `parseFrontmatter` per coerenza (tra i marker `---` iniziale e il
	// prossimo `\n---`). Quando il frontmatter non inizia con `---`, la
	// sezione è vuota e `parseMergeBlock` ritorna `{}` (no-op silenzioso).
	const normalizedContent = content
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n");
	let yamlSection = "";
	if (normalizedContent.startsWith("---")) {
		const yamlEndIdx = normalizedContent.indexOf("\n---", 3);
		if (yamlEndIdx !== -1) {
			yamlSection = normalizedContent.slice(4, yamlEndIdx);
		}
	}
	const mergeBlock = parseMergeBlock(yamlSection);

	// M018/S01 (R055): `extends` come scalare (gestibile dal parser flat
	// esistente). Assegnazione gated da `extends !== undefined`: un override
	// pre-M018 (senza `extends`) NON deve mai esporre `merge` nel result,
	// anche se `parseMergeBlock` trovasse un blocco `merge:` spurio per
	// altri motivi (retrocompat D052). Il loader T02 controllerà poi che
	// `merge` sia non-vuoto quando `extends` è valorizzato.
	const extendsValue = frontmatter.extends;

	return {
		name: frontmatter.name,
		role: frontmatter.role,
		description: frontmatter.description,
		tools: tools && tools.length > 0 ? tools : undefined,
		model: frontmatter.model,
		// M015: engine via normalizeEngine (case-insensitive "hermes" →
		// "hermes", qualsiasi altro valore → "gsd"). Popolato SOLO se il
		// frontmatter lo dichiara: un participant pre-M015 senza `engine`
		// resta `engine: undefined` (defaulting demandato al consumer,
		// vedi T02 test #8).
		...(frontmatter.engine !== undefined
			? { engine: normalizeEngine(frontmatter.engine) }
			: {}),
		// provider raw, non validato: la provider resolution è in S02.
		...(frontmatter.provider !== undefined
			? { provider: frontmatter.provider }
			: {}),
		// hermes_toolsets/hermes_skills: array CSV solo se popolato.
		...(hermesToolsets && hermesToolsets.length > 0
			? { hermesToolsets }
			: {}),
		...(hermesSkills && hermesSkills.length > 0 ? { hermesSkills } : {}),
		// softDeadlineMs: già estratto in `limits.softDeadlineMs` come
		// `unknown` (vedi LIMITS_FRONTMATTER_KEYS); qui lo si espone anche
		// al top-level del ParticipantConfig come `number` quando il valore
		// grezzo è già un numero, per accesso diretto dai consumer senza
		// passare per `limits.softDeadlineMs`.
		...(typeof limits.softDeadlineMs === "number"
			? { softDeadlineMs: limits.softDeadlineMs }
			: {}),
		limits,
		systemPrompt: body.trim(),
		source,
		filePath,
		// M018/S01 (R055): `extends` + `merge` propagati SOLO se il
		// frontmatter li dichiara entrambi. Un override pre-M018 senza
		// `extends` continua a produrre un ParticipantConfig D052 puro
		// (extends/merge/mergedFrom tutti undefined — anti-regressione R064).
		// Un override con `extends` ma `merge:` vuoto produce comunque
		// `merge: {}` qui; il loader T02 lo intercetta con throw bloccante
		// (`extends without merge: <role> from <path>`).
		...(extendsValue !== undefined
			? {
					extends: extendsValue,
					// M018/S01 (R055): propaga `merge` (inclusi i campi
					// mergeable parsati) + `unknownKeys` (chiavi raw fuori
					// whitelist) al `ParticipantConfig` finale. Il
					// loader T02 ispeziona `participant.merge.unknownKeys`
					// per il throw di whitelist enforcement
					// (`field '<key>' is not mergeable`); senza questa
					// propagazione il throw sarebbe un dead-code path
					// (vedi parseMergeBlock default case per l'accumulo
					// raw). Omitempty su `unknownKeys` per evitare di
					// esporre `unknownKeys: []` quando il blocco merge
					// è ben formato (tutti i campi in whitelist).
					merge: {
						...mergeBlock,
						...(mergeBlock.unknownKeys.length > 0
							? { unknownKeys: mergeBlock.unknownKeys }
							: {}),
					},
				}
			: {}),
	};
}

function loadParticipantsFromDir(
	dir: string,
	source: ParticipantSource,
): ParticipantConfig[] {
	const participants: ParticipantConfig[] = [];
	if (!fs.existsSync(dir)) return participants;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return participants;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const participant = parseParticipantContent(content, filePath, source);
		if (participant) participants.push(participant);
	}

	return participants;
}

/** Log stderr con il prefisso canonico `[discussion-arena]` (trasparenza operazionale). */
function logStderr(message: string): void {
	process.stderr.write(`[discussion-arena] ${message}\n`);
}

function findNearestProjectParticipantsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(
			currentDir,
			".gsd",
			"discussion-arena",
			"participants",
		);
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

/**
 * Walk-up verso la root per il tier 0 override: `.gsd/discussion-arena/
 * participants-overrides`, simmetrico a `findNearestProjectParticipantsDir`
 * (per-progetto, non per-user). Un override è per-progetto per definizione
 * (sostituisce il file project `participants/<role>.md`), quindi la ricerca
 * parte dal cwd e risale finché non trova la directory o raggiunge la root
 * del filesystem.
 */
function findNearestOverridesDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(
			currentDir,
			".gsd",
			"discussion-arena",
			"participants-overrides",
		);
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

/**
 * Walk-up verso la root per il coordination file (S03):
 * `.gsd/discussion-arena/discussion-arena-coordination.md`, simmetrico a
 * `findNearestOverridesDir`. Cerca il FILE (non la directory): il coordination
 * file è opzionale, quindi l'assenza in un progetto non blocca la risalita
 * verso un antenato che lo definisce. L'esistenza è verificata con
 * `fs.existsSync`: un path esistente ma non leggibile arriva comunque al
 * loader, che è mai-throw e degrada a code defaults con log D053.
 */
function findNearestCoordinationFile(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(
			currentDir,
			DISCUSSION_ARENA_COORDINATION_DIR,
			DISCUSSION_ARENA_COORDINATION_FILENAME,
		);
		if (fs.existsSync(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

/**
 * Risolve il path del coordination file al livello user (S02):
 * `<agentDir>/discussion-arena/discussion-arena-coordination.md`. Tier unico,
 * non walk-up: il livello user è canonico per utente (D137 — l'agent dir è
 * già risolta da `resolveAgentDir` con override `GSD_AGENT_DIR`), non per
 * progetto, quindi non c'è un antenato da risalire. L'esistenza è verificata
 * con `fs.existsSync`: un path mancante ritorna `null` (mai throw) e
 * `discoverParticipants` degrada a `coordinationPath: null`. Questo soddifa
 * naturalmente il success criterion S02 "discoverParticipants(tmpdir vuoto)
 * → coordination null".
 *
 * `env` è parametrizzato per consentire ai test di pilotare il fallback
 * senza mutare `process.env` (inverso del pattern `getAgentDir()` in
 * pi-coding-agent).
 */
function findUserCoordinationFile(env?: NodeJS.ProcessEnv): string | null {
	const agentDir = resolveAgentDir(env ?? process.env);
	const candidate = path.join(
		agentDir,
		DISCUSSION_ARENA_USER_COORDINATION_RELATIVE_PATH,
	);
	return fs.existsSync(candidate) ? candidate : null;
}

/**
 * Carica il tier 0 override da una directory `participants-overrides/`.
 *
 * Per ogni file `<role>.md` presente:
 *  - file illeggibile → skip silenzioso (stesso comportamento dei file base);
 *  - frontmatter incompleto (manca name/description/role) → override scartato
 *    con log distinto: se il ruolo candidato (basename del file) ha una base
 *    `using default for '<role>' (override skipped: incomplete)`, altrimenti
 *    `override skipped: incomplete (<role> from <path>)`;
 *  - override valido con base mancante → orfano: log
 *    `override target '<role>' not found in participants/ …` e accumulo in
 *    `orphanRoles` (il chiamante lancia throw bloccante);
 *  - override valido con base presente → applicato (sostituzione totale) con
 *    log `override applied: <role> from <path>`.
 */
function loadOverrideParticipantsFromDir(
	dir: string,
	baseNames: ReadonlySet<string>,
	baseMap: ReadonlyMap<string, ParticipantConfig>,
): { overrides: ParticipantConfig[]; orphanRoles: string[] } {
	const overrides: ParticipantConfig[] = [];
	const orphanRoles: string[] = [];
	if (!fs.existsSync(dir)) return { overrides, orphanRoles };

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return { overrides, orphanRoles };
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		const candidateRole = entry.name.slice(0, -".md".length);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const participant = parseParticipantContent(content, filePath, "override");
		if (!participant) {
			if (baseNames.has(candidateRole)) {
				logStderr(
					`using default for '${candidateRole}' (override skipped: incomplete)`,
				);
			} else {
				logStderr(
					`override skipped: incomplete (${candidateRole} from ${filePath})`,
				);
			}
			continue;
		}

		// M018/S01 (R055): path partial-override opt-in. Instradato PRIMA
		// del check orfano D052 perché la validazione del base qui è
		// riferita al campo `extends` (non al `name` del file override):
		// un override con `extends: scribe` richiede che `scribe` esista
		// come base, indipendentemente dal nome del file override. Tre
		// throw canonici distinti per le 3 condizioni bloccanti
		// (extends senza merge, campo fuori whitelist, base inesistente).
		if (participant.extends !== undefined) {
			// 1. `merge` deve essere valorizzato. Un override con solo
			//    `extends:` (e nessun blocco `merge:` con contenuto) è
			//    un errore di configurazione — niente fallback
			//    silenzioso. "Contenuto" = almeno un campo mergeable
			//    OPPURE almeno una chiave raw in `unknownKeys` (campo
			//    merge popolato dal parser anche quando tutti i campi
			//    del merge sono fuori dai 7 ammessi, vedi
			//    parseMergeBlock default case). Il check filtra
			//    `unknownKeys` dal conteggio delle chiavi perché è un
			//    campo metadato del parser, non un campo mergeable.
			const mergeObj = participant.merge;
			const mergeContentKeys = mergeObj
				? Object.keys(mergeObj).filter((k) => k !== "unknownKeys")
				: [];
			const mergeUnknownKeys = mergeObj?.unknownKeys ?? [];
			if (
				!mergeObj ||
				(mergeContentKeys.length === 0 &&
					mergeUnknownKeys.length === 0)
			) {
				logStderr(
					`extends without merge: ${participant.name} from ${filePath}`,
				);
				throw new Error(
					`extends without merge: ${participant.name} from ${filePath}`,
				);
			}
			// 2. Whitelist enforcement: le chiavi raw fuori dai 7
			//    ammessi sono state accumulate da `parseMergeBlock`
			//    in `mergeObj.unknownKeys` (vedi default case del
			//    parser). Senza questo passaggio intermedio, il throw
			//    sarebbe un dead-code path: il parser scarterebbe le
			//    chiavi sconosciute PRIMA che T02 possa applicare la
			//    whitelist. Si segnala solo la PRIMA chiave fuori
			//    whitelist (fail-fast).
			if (mergeUnknownKeys.length > 0) {
				const unknownKey = mergeUnknownKeys[0]!;
				logStderr(
					`field '${unknownKey}' is not mergeable: ${participant.name} from ${filePath}`,
				);
				throw new Error(
					`field '${unknownKey}' is not mergeable: ${participant.name} from ${filePath}`,
				);
			}
			// 3. Il base referenziato da `extends` deve esistere (project ∪
			//    user ∪ bundled ∪ virtual); un base mancante è analogo
			//    all'orfano D052 ma riferito al campo `extends`, non al
			//    `name` del file override.
			if (!baseNames.has(participant.extends)) {
				logStderr(
					`override target '${participant.extends}' not found in participants/ — ` +
						`create participants/${participant.extends}.md or remove the override file`,
				);
				throw new Error(
					`override target '${participant.extends}' not found in participants/ — ` +
						`create participants/${participant.extends}.md or remove the override file`,
				);
			}
			// 4. Costruzione participant finale: spread base per ereditare
			//    tutti i campi non specificati, override per
			//    source/filePath/name, esplicito merge per i 7 campi
			//    ammessi, marker `mergedFrom` per osservabilità consumer
			//    (loggato da index.ts speculare a `source`/`filePath`).
			const baseParticipant = baseMap.get(participant.extends);
			const merged: ParticipantConfig = {
				...baseParticipant!,
				...participant,
				...participant.merge,
				mergedFrom: participant.extends,
			};
			logStderr(`override applied: ${participant.name} from ${filePath}`);
			overrides.push(merged);
			continue;
		}

		// Path D052 (extends undefined): sostituzione totale, retrocompat.
		// Anti-regressione R064: un override pre-M018 senza `extends`
		// continua a funzionare IDENTICAMENTE (override applicato + orfano
		// se base mancante).
		if (!baseNames.has(participant.name)) {
			logStderr(
				`override target '${participant.name}' not found in participants/ — ` +
					`create participants/${participant.name}.md or remove the override file`,
			);
			orphanRoles.push(participant.name);
			continue;
		}

		logStderr(`override applied: ${participant.name} from ${filePath}`);
		overrides.push(participant);
	}

	return { overrides, orphanRoles };
}

/**
 * Risolve il path della directory `participants/` accanto al modulo corrente.
 * Il modulo `participants.ts` (o la sua build) vive accanto al manifest
 * dell'estensione; in produzione corrisponde al percorso di installazione
 * npm (`node_modules/@efrembaraldo/gsd-pi-discussion-arena/participants/`).
 * In dev, al sorgente del progetto.
 *
 * Cache in module-scope: la directory del modulo non cambia durante la vita
 * del processo, quindi un singolo calcolo basta per tutte le chiamate.
 */
let cachedBundledDir: string | null | undefined;
function findBundledParticipantsDir(): string | null {
	if (cachedBundledDir !== undefined) return cachedBundledDir;
	try {
		const moduleFile = fileURLToPath(import.meta.url);
		const moduleDir = path.dirname(moduleFile);
		const candidate = path.join(moduleDir, "participants");
		cachedBundledDir = isDirectory(candidate) ? candidate : null;
	} catch {
		cachedBundledDir = null;
	}
	return cachedBundledDir;
}

/**
 * Scopre i partecipanti disponibili.
 *
 * Precedenza (highest wins): override > virtual > project > user > bundled
 * (D052: base < virtual < override — i virtual roles, S03, stanno tra il
 * tier base e il tier 0 override).
 * - override (`.gsd/discussion-arena/participants-overrides`, walk-up verso
 *   git root come il tier project) ha la precedenza assoluta: il file
 *   `<role>.md` sostituisce TOTALE il corrispondente base. Un override senza
 *   base (project ∪ user ∪ bundled ∪ virtual) è un orfano → `Error` bloccante
 *   con messaggio canonico; `options.overridesDir` esplicito bypassa il walk-up.
 * - project (`.gsd/discussion-arena/participants`, walk-up verso git root)
 *   sovrascrive user a parità di name.
 * - user (`~/.gsd/agent/discussion-arena/participants`)
 *   sovrascrive bundled a parità di name.
 * - bundled (`participants/` accanto al modulo installato)
 *   è la base; l'utente può sovrascriverlo in user/ o project/ senza
 *   toccare il package.
 *
 * Stessa regola project > user usata da gsd-pi per le skill. La firma è
 * backward-compat: `options` è opzionale e i campi nuovi del result
 * (`overridesDir`, `orphanOverrides`, `coordinationPath`, `coordination`)
 * sono additivi per i consumer esistenti (index.ts:443, index.ts:1073).
 *
 * Precedenza del coordination file (S02 — 3 livelli):
 *   `options.coordinationPath` esplicito > project walk-up > user level >
 *   null. Il livello user è canonico per utente (D137:
 *   `<agentDir>/discussion-arena/discussion-arena-coordination.md`, dove
 *   `agentDir` è risolta da `resolveAgentDir` con override `GSD_AGENT_DIR`,
 *   D138) e non fa walk-up perché il tier user è unico per utente, non per
 *   progetto. Quando il tier user vince (project assente + user presente)
 *   viene emesso su stderr un log one-shot
 *   `[discussion-arena] user-level coordination applied: <path>` speculare
 *   a `virtual role applied` / `override applied`. `null` letterale passato
 *   esplicitamente in `options.coordinationPath` significa "solo
 *   project/user walk-up" — il check `!== undefined` preserva il contratto.
 */
export function discoverParticipants(
	cwd: string,
	options: DiscoverParticipantsOptions = {},
): ParticipantDiscoveryResult {
	const userDir = path.join(getAgentDir(), "discussion-arena", "participants");
	const projectParticipantsDir = findNearestProjectParticipantsDir(cwd);
	const bundledDir = options.skipBundled ? null : findBundledParticipantsDir();

	const bundledParticipants = bundledDir
		? loadParticipantsFromDir(bundledDir, "bundled")
		: [];
	const userParticipants = loadParticipantsFromDir(userDir, "user");
	const projectParticipants = projectParticipantsDir
		? loadParticipantsFromDir(projectParticipantsDir, "project")
		: [];

	const map = new Map<string, ParticipantConfig>();
	for (const p of bundledParticipants) map.set(p.name, p); // lowest precedence
	for (const p of userParticipants) map.set(p.name, p); // overrides bundled
	for (const p of projectParticipants) map.set(p.name, p); // overrides user

	// Coordination file (S03): i virtual roles entrano nel map come tier
	// post-base ma PRE-override (D052: base < virtual < override), così un
	// override che punta a un ruolo virtuale non è orfano (il virtual è già
	// in baseNames quando parte la validazione orfani) e, a parità di name,
	// l'override vince sul virtual. Walk-up simmetrico a
	// findNearestOverridesDir quando `coordinationPath` non è passato; il
	// loader è mai-throw e l'assenza del file è un no-op silenzioso.
	//
	// S02 aggiunge il livello `user` come terza precedenza del coordination
	// file: `options.coordinationPath` esplicito > project walk-up >
	// user level (D137, D138) > null. Il controllo `!== undefined`
	// preserva il contratto che `coordinationPath: null` esplicito significa
	// "solo project/user walk-up" (un `null` letterale bypassa solo il
	// default esplicito, NON disabilita il walk-up — backward-compat).
	let coordinationPath: string | null;
	if (options.coordinationPath !== undefined) {
		coordinationPath = options.coordinationPath;
	} else {
		coordinationPath = findNearestCoordinationFile(cwd);
		if (coordinationPath === null) {
			const userCoordinationPath = findUserCoordinationFile();
			if (userCoordinationPath !== null) {
				coordinationPath = userCoordinationPath;
				logStderr(
					`user-level coordination applied: ${userCoordinationPath}`,
				);
			}
		}
	}

	let coordinationPathResolved: string | null = null;
	const coordination: { roundsDefault?: number; modelDefault?: string } = {};
	if (coordinationPath) {
		const loaded = loadDiscussionArenaCoordination(coordinationPath);
		coordinationPathResolved = loaded.sourcePath;
		if (loaded.sourcePath) {
			if (loaded.config.roundsDefault !== undefined)
				coordination.roundsDefault = loaded.config.roundsDefault;
			if (loaded.config.modelDefault !== undefined)
				coordination.modelDefault = loaded.config.modelDefault;

			for (const [key, virtualRole] of Object.entries(
				loaded.config.rolesVirtuals,
			)) {
				// La chiave del dict è canonica (D-round): un `name` interno
				// diverso fa saltare il singolo virtual con warning, gli altri
				// virtual restano applicati (mai throw — forward-compat).
				if (virtualRole.name !== key) {
					logStderr(
						`virtual role '${key}' name field mismatch '${virtualRole.name}' — skipped`,
					);
					continue;
				}
				map.set(key, {
					name: virtualRole.name,
					role: virtualRole.role,
					description: virtualRole.description,
					limits: {},
					systemPrompt: virtualRole.systemPrompt,
					source: "virtual",
					filePath: loaded.sourcePath,
				});
				logStderr(
					`virtual role applied: ${virtualRole.name} from ${loaded.sourcePath}`,
				);
			}
		}
	}

	// Tier 0 — override per-progetto (.gsd/discussion-arena/participants-overrides):
	// walk-up come findNearestProjectParticipantsDir, sostituzione totale del file.
	const overridesDir =
		options.overridesDir !== undefined
			? isDirectory(options.overridesDir)
				? options.overridesDir
				: null
			: findNearestOverridesDir(cwd);

	let overrides: ParticipantConfig[] = [];
	let orphanRoles: readonly string[] = [];
	if (overridesDir) {
		const loaded = loadOverrideParticipantsFromDir(
			overridesDir,
			new Set(map.keys()),
			map,
		);
		overrides = loaded.overrides;
		orphanRoles = loaded.orphanRoles;
	}

	// Validazione orfani bloccante (QA round 1 risk #1): un override senza base
	// (project ∪ user ∪ bundled ∪ virtual) è un errore di configurazione —
	// niente fallback silenzioso, l'utente deve creare participants/<role>.md
	// o rimuovere il file di override.
	if (orphanRoles.length > 0) {
		const role = orphanRoles[0]!;
		throw new Error(
			`override target '${role}' not found in participants/ — create participants/${role}.md or remove the override file`,
		);
	}

	for (const p of overrides) map.set(p.name, p); // tier 0: precedenza assoluta

	// model_default (S03, Must-Have 2): fallback per-participant applicato sul
	// participant risolto (post-override) — i participant senza `model`
	// esplicito, inclusi i virtual roles (che non hanno campo model),
	// ereditano il modello di default del coordination file.
	if (coordination.modelDefault !== undefined) {
		for (const p of map.values()) {
			if (p.model === undefined) p.model = coordination.modelDefault;
		}
	}

	return {
		participants: Array.from(map.values()),
		projectParticipantsDir,
		overridesDir,
		orphanOverrides: orphanRoles, // sempre [] qui: gli orfani lanciano throw
		coordinationPath: coordinationPathResolved,
		coordination,
	};
}

/**
 * Risolve il numero di round applicando la gerarchia a 4 livelli (S03/T03):
 *
 *   tool param (1) > frontmatter del participant (2, N/A) >
 *   coordination.rounds_default (3) > code DEFAULT_ROUNDS (4)
 *
 * Il livello 2 (frontmatter) è riservato per future estensioni: `rounds` è
 * una proprietà della discussion-arena, non del singolo participant — nessun campo
 * `rounds`/`rounds_default` esiste oggi nei `participants/*.md` — quindi il
 * livello 3 vince sul 4 quando il coordination file esiste e contiene
 * `rounds_default` (Must-Have 5 S03).
 *
 * Funzione pura, mai throw: un valore non valido a un livello degrada al
 * livello successivo (validazione speculare al loader T01: integer positivo
 * >= 1 — `rounds_default` arriva già validato dal loader, ma il resolver
 * resta difensivo per i consumatori diretti). Il clamp a `MAX_ROUNDS` NON è
 * qui: participants.ts non può importare `MAX_ROUNDS` da index.ts senza
 * dipendenza circolare (index.ts importa questo modulo). Il chiamante in
 * index.ts (execute del tool e command handler, T03) applica
 * `Math.min(risultato, MAX_ROUNDS)` come ultimo passo del cablaggio — la
 * gerarchia e il clamp restano centralizzati nel punto di consumo.
 */
export function resolveRoundsDefault(
	toolRounds: number | undefined,
	coordinationRoundsDefault: number | undefined,
	codeDefault: number,
): number {
	if (
		typeof toolRounds === "number" &&
		Number.isInteger(toolRounds) &&
		toolRounds >= 1
	) {
		return toolRounds;
	}
	if (
		typeof coordinationRoundsDefault === "number" &&
		Number.isInteger(coordinationRoundsDefault) &&
		coordinationRoundsDefault >= 1
	) {
		return coordinationRoundsDefault;
	}
	return codeDefault;
}
