/**
 * Agent Discussion Arena — Session persistence
 *
 * Salva/carica il transcript cumulativo della discussion-arena su disco, in
 * modo che invocazioni successive del comando `/discussion-arena "tema"
 * --continue` possano appendere round partendo dal transcript precedente (con
 * round numbering continuo: 1, 2 → 3, 4 → 5, ...).
 *
 * Storage project-relative: `<cwd>/.gsd/discussion-arena/transcripts/<cwdHash>-<topic-slug>.md`.
 * Vantaggi: visibile nel repo, condivisibile col team, persistente attraverso
 * reset di ~/.gsd/agent/. Trade-off: il transcript finisce in git working tree
 * (l'utente deve aggiungere `.gsd/` a .gitignore del proprio progetto se non
 * vuole commitare i transcript).
 *
 * Frontmatter YAML minimale (topic, participants, startedAt, lastUpdatedAt,
 * rounds) + body markdown. Nessuna dipendenza esterna oltre Node stdlib.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";

export interface DiscussionArenaSession {
	topic: string;
	participants: string[];
	startedAt: string;
	lastUpdatedAt: string;
	rounds: number;
	transcript: string;
}

/** Slugify di un topic per il filename: lowercase, alfanumerici+dash, max 50 char. */
export function topicSlug(topic: string): string {
	const slug = topic
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 50);
	return slug || "untitled";
}

/** Hash breve del cwd per evitare collisioni topic fra progetti. SHA-256 (non MD5)
 * anche se l'uso è solo per disambiguazione filename (non security-sensitive):
 * costo identico, evita falsi positivi dai linter su primitive deboli. */
export function cwdHashShort(cwd: string): string {
	return crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 8);
}

/** Path della session file: <cwd>/.gsd/discussion-arena/transcripts/<cwdHash>-<slug>.md */
export function getSessionFilePath(cwd: string, topic: string): string {
	return path.join(
		cwd,
		".gsd",
		"discussion-arena",
		"transcripts",
		`${cwdHashShort(cwd)}-${topicSlug(topic)}.md`,
	);
}

/** Carica una sessione esistente, o null se non c'è o è corrotta. */
export async function loadSession(filePath: string): Promise<DiscussionArenaSession | null> {
	let content: string;
	try {
		content = await fs.readFile(filePath, "utf-8");
	} catch {
		return null;
	}
	try {
		return parseSession(content);
	} catch {
		return null;
	}
}

/** Salva una sessione, creando la directory se manca. */
export async function saveSession(filePath: string, session: DiscussionArenaSession): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	const content =
		`---\n` +
		`topic: ${session.topic}\n` +
		`participants: ${session.participants.join(", ")}\n` +
		`startedAt: ${session.startedAt}\n` +
		`lastUpdatedAt: ${session.lastUpdatedAt}\n` +
		`rounds: ${session.rounds}\n` +
		`---\n\n` +
		`${session.transcript}\n`;
	await fs.writeFile(filePath, content, "utf-8");
}

/** Parser del formato sessione. Lancia se il file non è nel formato atteso. */
function parseSession(content: string): DiscussionArenaSession {
	const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
	if (!match) throw new Error("session file without frontmatter");
	const [, front, body] = match;
	const fields: Record<string, string> = {};
	for (const line of front.split("\n")) {
		const m = line.match(/^(\w+):\s*(.*)$/);
		if (m) fields[m[1]] = m[2];
	}
	return {
		topic: fields.topic ?? "",
		participants: (fields.participants ?? "")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
		startedAt: fields.startedAt ?? "",
		lastUpdatedAt: fields.lastUpdatedAt ?? "",
		rounds: Number.parseInt(fields.rounds ?? "0", 10) || 0,
		transcript: body.trim(),
	};
}
