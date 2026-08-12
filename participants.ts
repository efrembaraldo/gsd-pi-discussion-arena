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

export type ParticipantSource =
	| "override"
	| "virtual"
	| "user"
	| "project"
	| "bundled";

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
];

/**
 * Estrae i 5 campi limits dal frontmatter grezzo (snake_case) in un
 * `ParticipantLimitsInput` (camelCase) — livello "frontmatter" del merge a 3
 * livelli tool > frontmatter > defaults (S02/M003). Nessuna validazione qui:
 * i valori restano `unknown` (il parser YAML reale può restituire number,
 * string o altro a seconda dello scalare) e vengono validati a runtime da
 * `resolveParticipantLimits` (helpers.ts, consumata da
 * `resolveParticipantLimitsForParticipant` in index.ts, S02/T02). Campi
 * assenti dal frontmatter restano `undefined` nell'oggetto risultante, così
 * `resolveParticipantLimits` scende al livello successivo della catena.
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
 * Parsa un singolo file participant `.md` (frontmatter flat + body) in un
 * `ParticipantConfig`. Condiviso tra la discovery base (`loadParticipantsFromDir`)
 * e il tier 0 override (`loadOverrideParticipantsFromDir`) — mai bifurcare la
 * logica di parsing tra default e override (D-round 5 dev).
 *
 * Ritorna `null` quando il contenuto è irrecuperabile: frontmatter incompleto
 * (manca name/description/role) o assente. Un file illeggibile non arriva qui
 * (il chiamante fa il read e salta).
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

	return {
		name: frontmatter.name,
		role: frontmatter.role,
		description: frontmatter.description,
		tools: tools && tools.length > 0 ? tools : undefined,
		model: frontmatter.model,
		limits: parseLimitsFromFrontmatter(frontmatter),
		systemPrompt: body.trim(),
		source,
		filePath,
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
	const coordinationPath =
		options.coordinationPath !== undefined
			? options.coordinationPath
			: findNearestCoordinationFile(cwd);

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
