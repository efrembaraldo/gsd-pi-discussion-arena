/**
 * Stub self-contained e zero-dipendenze di `@gsd/pi-coding-agent` (D019, D004).
 *
 * participants.ts importa `getAgentDir` e `parseFrontmatter` dallo specifier
 * bare `@gsd/pi-coding-agent`, che sotto `node --test` non è risolvibile a
 * runtime (peerDependency opzionale, mappata solo a compile-time via tsconfig
 * `paths` verso il checkout sibling esterno). Il resolve hook in
 * tests/ts-esm-loader.mjs redirige questo specifier verso questo stub locale,
 * così la suite resta riproducibile ovunque senza il checkout sibling.
 *
 * Fidelità ai comportamenti usati da participants.ts:
 *  - getAgentDir(): rispetta l'override via env *come fa l'implementazione
 *    reale*, ma con un nome di variabile esplicito (GSD_AGENT_DIR) invece del
 *    derivato dinamico, così i test possono puntare la dir utente a fixture
 *    controllate. Default identico: ~/.pi/agent.
 *  - parseFrontmatter(): parser YAML minimale per il sottoinsieme usato da
 *    participants.ts (righe `chiave: valore scalare`, array inline `[...]`,
 *    body mds), identico il contratto di firma del reale.
 */

import * as os from "node:os";
import * as path from "node:path";

export const GSD_AGENT_DIR_ENV = "GSD_AGENT_DIR";

/** Override della dir utente per i test; default il valore reale di pi. */
export function getAgentDir(): string {
	const envDir = process.env[GSD_AGENT_DIR_ENV];
	if (envDir && envDir.length > 0) {
		if (envDir === "~") return os.homedir();
		if (envDir.startsWith("~/")) return path.join(os.homedir(), envDir.slice(2));
		return envDir;
	}
	return path.join(os.homedir(), ".pi", "agent");
}

/**
 * Parser frontmatter YAML-sostitutivo per il sottoinsieme usato dal progetto:
 * una riga `chiave: valore` per campo. Supporta:
 *   - valori scalari stringa (espansione delle maiuscole, niente parsing di
 *     numeri/bool): es. `name: analyst`, `model: claude-sonnet-5`
 *   - array inline tra parentesi quadre: `tools: [read, grep, find]`
 *   - body markdown separato dal frontmatter da `---`
 * Se il contenuto non inizia con `---` restituisce frontmatter vuoto e body
 * intero (stesso comportamento del reale).
 */
export function parseFrontmatter<T extends Record<string, unknown> = Record<string, unknown>>(
	content: string,
): { frontmatter: T; body: string } {
	const normalized = typeof content === "string" ? content.replace(/\r\n/g, "\n").replace(/\r/g, "\n") : String(content);

	if (!normalized.startsWith("---")) {
		return { frontmatter: {} as T, body: normalized };
	}

	const endIndex = normalized.indexOf("\n---", 3);
	if (endIndex === -1) {
		return { frontmatter: {} as T, body: normalized };
	}

	const yamlString = normalized.slice(4, endIndex);
	const body = normalized.slice(endIndex + 4).trim();

	const frontmatter: Record<string, unknown> = {};
	for (const rawLine of yamlString.split("\n")) {
		const line = rawLine.trim();
		if (!line) continue;
		const colon = line.indexOf(":");
		if (colon === -1) continue;
		const key = line.slice(0, colon).trim();
		const rawValue = line.slice(colon + 1).trim();
		if (!key) continue;

		if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
			const inner = rawValue.slice(1, -1);
			frontmatter[key] = inner.split(",").map((v) => v.trim()).filter(Boolean);
		} else {
			frontmatter[key] = rawValue;
		}
	}

	return { frontmatter: frontmatter as T, body };
}