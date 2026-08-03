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
 * di progetto punta a `.gsd/arena/participants` (non `.pi/agents`), perché
 * questo file non passa dal seam vendoring di ADR-010 — è codice originale
 * scritto per gsd-pi, non codice pi vendorizzato.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@gsd/pi-coding-agent";

export type ParticipantSource = "user" | "project";

export interface ParticipantConfig {
	/** Identificativo usato per invocare il partecipante (es. "architect") */
	name: string;
	/** Ruolo/competenza mostrato nel transcript dell'arena */
	role: string;
	/** Descrizione breve — usata anche nel promptSnippet del tool */
	description: string;
	/** Sottoinsieme di tool concessi al partecipante durante la discussione (opzionale) */
	tools?: string[];
	/** Override modello per questo partecipante (es. "claude-opus-4-8") */
	model?: string;
	/** Corpo del file .md dopo il frontmatter: il system prompt del ruolo */
	systemPrompt: string;
	source: ParticipantSource;
	filePath: string;
}

export interface ParticipantDiscoveryResult {
	participants: ParticipantConfig[];
	projectParticipantsDir: string | null;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function loadParticipantsFromDir(dir: string, source: ParticipantSource): ParticipantConfig[] {
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

		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);

		// name/description/role sono obbligatori: senza "role" il partecipante
		// non ha un'etichetta da mostrare nel transcript dell'arena.
		if (!frontmatter.name || !frontmatter.description || !frontmatter.role) continue;

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
		const candidate = path.join(currentDir, ".gsd", "arena", "participants");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

/**
 * Scopre i partecipanti disponibili.
 *
 * Precedenza: project (.gsd/arena/participants, walk fino alla root git)
 * sovrascrive user (~/.gsd/agent/arena/participants) a parità di `name` —
 * stessa regola di precedenza usata da gsd-pi per le skill (progetto vince
 * su utente).
 */
export function discoverParticipants(cwd: string): ParticipantDiscoveryResult {
	const userDir = path.join(getAgentDir(), "arena", "participants");
	const projectParticipantsDir = findNearestProjectParticipantsDir(cwd);

	const userParticipants = loadParticipantsFromDir(userDir, "user");
	const projectParticipants = projectParticipantsDir
		? loadParticipantsFromDir(projectParticipantsDir, "project")
		: [];

	const map = new Map<string, ParticipantConfig>();
	for (const p of userParticipants) map.set(p.name, p);
	for (const p of projectParticipants) map.set(p.name, p); // il progetto vince

	return { participants: Array.from(map.values()), projectParticipantsDir };
}
