/**
 * src/discussion-arena-pending-research.ts — Writer atomico dei file
 * "pending-research" dentro `<cwd>/.gsd/discussion-arena/` (M008/S03/T01).
 *
 * Dopo che la discussion arena viene lanciata nella fase research-decision, la decisione
 * strutturata estratta dal verbalizzato (ResearchDecisions) viene persistita
 * in due file destinati all'ingest da parte di S04:
 *   - `pending-research.json` — typed JSON della struttura estratta
 *     (wrapper stabile `{ version: 1, structured: ResearchDecisions }`);
 *   - `pending-research.md` — transcript markdown human-readable.
 *
 * Modalità di scrittura atomica (write-then-rename), stessa shape di
 * `writeFileAtomic` in src/preferences-writer.ts: temp file nella stessa
 * directory -> fsync -> rename -> dir fsync (best-effort). Mai un file
 * parzialmente scritto visibile, anche in caso di kill mid-write.
 *
 * Proprietà contrattuali:
 *   - mkdir recursive della directory se assente.
 *   - Idempotente: scrivere lo stesso payload due volte produce contenuto
 *     identico su disco (serializzazione deterministica + skip del write se
 *     i byte sono invariati).
 *   - cleanupPendingResearch rimuove i due file se presenti (ENOENT ignorato).
 *   - Osservabilità: log stderr strutturato per write e cleanup con metadata
 *     path, size e mtime (LOG_PREFIX condiviso).
 *
 * Zero nuove dipendenze runtime: solo node:fs/promises e node:path.
 */

import { open, rename, mkdir, readFile, stat, unlink } from "node:fs/promises";
import * as path from "node:path";
import { LOG_PREFIX } from "./log-prefix.js";
import type { ResearchDecisions } from "./discussion-arena-research-extractor.js";
import { DISCUSSION_ARENA_COORDINATION_DIR } from "./discussion-arena-coordination.js";

/** Directory dei file pending-research dentro `<cwd>/.gsd/` (stessa directory
 * del coordination file del tier 0 override). */
export const PENDING_RESEARCH_DIR = DISCUSSION_ARENA_COORDINATION_DIR;

/** Nome del file JSON pending-research (structured tipizzata). */
export const PENDING_RESEARCH_JSON_FILENAME = "pending-research.json";

/** Nome del file markdown pending-research (transcript human-readable). */
export const PENDING_RESEARCH_MD_FILENAME = "pending-research.md";

/** Attributi di errore POSIX usati per distinguere ENOENT. */
function isEnoent(err: unknown): boolean {
	return err instanceof Error && "code" in err && err.code === "ENOENT";
}

/** Schema stabile del file JSON pending-research. */
export interface PendingResearchJson {
	version: 1;
	structured: ResearchDecisions;
}

/** Risultato di una scrittura pending-research (metadata per il log). */
export interface PendingResearchWriteResult {
	/** Path assoluto del file .json scritto. */
	jsonPath: string;
	/** Path assoluto del file .md scritto. */
	markdownPath: string;
	/** Byte del file .json risultante. */
	jsonBytes: number;
	/** Byte del file .md risultante. */
	markdownBytes: number;
	/** mtime (ms da epoch) del file .json risultante. */
	mtimeMs: number;
	/** true se almeno un file è stato (ri)scritto, false se già identico. */
	changed: boolean;
}

/** Costruisce i due path assoluti dei file pending-research sotto `<cwd>`. */
export function pendingResearchPaths(cwd: string): {
	jsonPath: string;
	markdownPath: string;
} {
	const dir = path.join(cwd, PENDING_RESEARCH_DIR);
	return {
		jsonPath: path.join(dir, PENDING_RESEARCH_JSON_FILENAME),
		markdownPath: path.join(dir, PENDING_RESEARCH_MD_FILENAME),
	};
}

/**
 * Rendering deterministico del JSON pending-research a partire dalla
 * struttura estratta. Nessun timestamp interno: la serializzazione è pura
 * funzione dell'input, per cui ripetere la scrittura dello stesso payload
 * produce identici byte (idempotenza).
 */
export function renderPendingResearchJson(pending: PendingResearchJson): string {
	return JSON.stringify(pending, null, 2) + "\n";
}

/**
 * Rendering del markdown pending-research: il transcript fornito, con un
 * unico newline terminale (normalizzazione deterministica). Deterministico
 * rispetto all'input: scrivere due volte lo stesso transcript produce lo
 * stesso contenuto.
 */
export function renderPendingResearchMarkdown(transcriptMarkdown: string): string {
	const t = typeof transcriptMarkdown === "string" ? transcriptMarkdown : "";
	return t.endsWith("\n") ? t : t + "\n";
}

/**
 * Scrittura atomica (write-then-rename). Temp file nella stessa directory ->
 * fsync -> rename -> fsync della directory (best-effort, fallisce in silenzio
 * su filesystem che non lo supportano). Stessa shape di `writeFileAtomic` in
 * src/preferences-writer.ts, con prefisso temp dedicato a pending-research.
 */
export async function writeFileAtomicPending(
	filePath: string,
	content: string,
): Promise<void> {
	const dir = path.dirname(filePath);
	await mkdir(dir, { recursive: true });
	const tmp = path.join(
		dir,
		`.pending-research.${process.pid}.${Date.now()}.${Math.random()
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
	// Best-effort dir fsync.
	let dh: Awaited<ReturnType<typeof open>> | undefined;
	try {
		dh = await open(dir, "r");
		await dh.sync();
	} catch {
		/* ignora — rename già durevole sulla maggior parte dei filesystem */
	} finally {
		await dh?.close().catch(() => {});
	}
}

/** Legge il contenuto di un file o ritorna `null` se assente (ENOENT). */
async function readIfPresent(filePath: string): Promise<string | null> {
	try {
		return await readFile(filePath, "utf-8");
	} catch (err) {
		if (isEnoent(err)) return null;
		throw err;
	}
}

/** Log stderr strutturato best-effort (non propaga errori di logging). */
function log(stderr: NodeJS.WritableStream, message: string): void {
	try {
		stderr.write(`${LOG_PREFIX} ${message}\n`);
	} catch {
		/* ignora errori di logging */
	}
}

/**
 * Scrive atomicamente i due file pending-research sotto `<cwd>`. Se la
 * directory `.gsd/discussion-arena/` non esiste viene creata ricorsivamente.
 * Idempotente: payload già identico su disco -> nessuna riscrittura
 * (changed=false), contenuto sui file invariato.
 *
 * Log stderr strutturato per ogni file effettivamente scritto:
 * `pending-research: write <path> size=<bytes> mtime=<iso>`.
 *
 * @param cwd Root del progetto in cui insediare `.gsd/discussion-arena/`.
 * @param structured Struttura tipizzata delle decisioni estratte dal Scribe.
 * @param transcriptMarkdown Transcript markdown, human-readable, da rendere nel file .md.
 * @param stderr Sink di log (default `process.stderr`).
 */
export async function writePendingResearch(
	cwd: string,
	structured: ResearchDecisions,
	transcriptMarkdown: string,
	stderr: NodeJS.WritableStream = process.stderr,
): Promise<PendingResearchWriteResult> {
	const { jsonPath, markdownPath } = pendingResearchPaths(cwd);

	const jsonContent = renderPendingResearchJson({
		version: 1,
		structured,
	});
	const markdownContent = renderPendingResearchMarkdown(transcriptMarkdown);

	let changed = false;

	const existingJson = await readIfPresent(jsonPath);
	if (existingJson !== jsonContent) {
		await writeFileAtomicPending(jsonPath, jsonContent);
		changed = true;
	}

	const existingMd = await readIfPresent(markdownPath);
	if (existingMd !== markdownContent) {
		await writeFileAtomicPending(markdownPath, markdownContent);
		changed = true;
	}

	const jsonStat = await stat(jsonPath);
	const mdStat = await stat(markdownPath);

	if (changed) {
		log(stderr, `pending-research: write ${jsonPath} size=${jsonStat.size} mtime=${new Date(jsonStat.mtimeMs).toISOString()}`);
		log(stderr, `pending-research: write ${markdownPath} size=${mdStat.size} mtime=${new Date(mdStat.mtimeMs).toISOString()}`);
	}

	return {
		jsonPath,
		markdownPath,
		jsonBytes: jsonStat.size,
		markdownBytes: mdStat.size,
		mtimeMs: jsonStat.mtimeMs,
		changed,
	};
}

/**
 * Rimuove i due file pending-research se presenti (ENOENT ignorato). Log
 * stderr strutturato con count e path rimossi:
 * `pending-research: cleanup count=<n> paths=<...>`.
 *
 * @param cwd Root del progetto.
 * @param stderr Sink opzionale per il log (default `process.stderr`).
 */
export async function cleanupPendingResearch(
	cwd: string,
	stderr: NodeJS.WritableStream = process.stderr,
): Promise<{ removed: string[] }> {
	const { jsonPath, markdownPath } = pendingResearchPaths(cwd);
	const targets = [jsonPath, markdownPath];
	const removed: string[] = [];
	for (const p of targets) {
		try {
			await unlink(p);
			removed.push(p);
		} catch (err) {
			if (isEnoent(err)) continue;
			throw err;
		}
	}
	log(
		stderr,
		`pending-research: cleanup count=${removed.length} paths=${removed.join(",")}`,
	);
	return { removed };
}