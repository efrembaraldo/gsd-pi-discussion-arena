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
 * Tre sorgenti di partecipanti (precedenza highest → lowest):
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

export type ParticipantSource = "user" | "project" | "bundled";

export interface ParticipantConfig {
	/** Identificativo usato per invocare il partecipante (es. "architect") */
	name: string;
	/** Ruolo/competenza mostrato nel transcript dell'arena */
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
}

export interface DiscoverParticipantsOptions {
	/** Se true, esclude la discovery dei partecipanti bundled con l'estensione (utile nei test). */
	skipBundled?: boolean;
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

		const { frontmatter, body } =
			parseFrontmatter<Record<string, string>>(content);

		// name/description/role sono obbligatori: senza "role" il partecipante
		// non ha un'etichetta da mostrare nel transcript dell'arena.
		if (!frontmatter.name || !frontmatter.description || !frontmatter.role)
			continue;

		const tools = frontmatter.tools
			?.split(",")
			.map((t: string) => t.trim())
			.filter(Boolean);

		participants.push({
			name: frontmatter.name,
			role: frontmatter.role,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: frontmatter.model,
			limits: parseLimitsFromFrontmatter(frontmatter),
			systemPrompt: body.trim(),
			source,
			filePath,
		});
	}

	return participants;
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
 * Precedenza (highest wins): project > user > bundled.
 * - project (`.gsd/discussion-arena/participants`, walk-up verso git root)
 *   sovrascrive user a parità di name.
 * - user (`~/.gsd/agent/discussion-arena/participants`)
 *   sovrascrive bundled a parità di name.
 * - bundled (`participants/` accanto al modulo installato)
 *   è la base; l'utente può sovrascriverlo in user/ o project/ senza
 *   toccare il package.
 *
 * Stessa regola project > user usata da gsd-pi per le skill.
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
	for (const p of projectParticipants) map.set(p.name, p); // highest precedence

	return { participants: Array.from(map.values()), projectParticipantsDir };
}
