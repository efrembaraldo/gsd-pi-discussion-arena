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
import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { LOG_PREFIX } from "./log-prefix.js";
import type { ResearchDecisions } from "./discussion-arena-research-extractor.js";
import { DISCUSSION_ARENA_COORDINATION_DIR } from "./discussion-arena-coordination.js";

/** Directory dei file pending-research dentro `<cwd>/.gsd/` (stessa directory
 * del coordination file del tier 0 override). */
export const PENDING_RESEARCH_DIR = DISCUSSION_ARENA_COORDINATION_DIR;

/** TTL dei file pending-research: oltre questa età vengono rimossi dal
 * fallback su unit_start come garanzia (24h), anche se l'evento milestone_end
 * non è mai arrivato (crash, shutdown, hook mancato). */
export const PENDING_RESEARCH_TTL_MS = 24 * 60 * 60 * 1000;

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

/**
 * Rimuove i file pending-research con mtime più vecchio del TTL configurato
 * (default 24h). Fallback di garanzia per il caso in cui l'evento
 * `milestone_end` non sia mai arrivato (crash di mezzo, hook mancato): nessun
 * file pending-research "stale" sopravvive al prossimo `unit_start`.
 * Idempotente e fail-safe: ENOENT ignorato, file "freschi" lasciati intatti.
 *
 * Log stderr strutturato solo quando rimuove qualcosa:
 * `pending-research: ttl-cleanup count=<n> paths=<...>`.
 *
 * @param cwd Root del progetto.
 * @param stderr Sink opzionale per il log (default `process.stderr`).
 * @param maxAgeMs Soglia di età (default `PENDING_RESEARCH_TTL_MS` = 24h).
 */
export async function cleanupStalePendingResearch(
	cwd: string,
	stderr: NodeJS.WritableStream = process.stderr,
	maxAgeMs: number = PENDING_RESEARCH_TTL_MS,
): Promise<{ removed: string[] }> {
	const { jsonPath, markdownPath } = pendingResearchPaths(cwd);
	const targets = [jsonPath, markdownPath];
	const removed: string[] = [];
	const now = Date.now();
	for (const p of targets) {
		let mtimeMs: number;
		try {
			const s = await stat(p);
			mtimeMs = s.mtimeMs;
		} catch (err) {
			if (isEnoent(err)) continue;
			throw err;
		}
		if (now - mtimeMs > maxAgeMs) {
			await unlink(p);
			removed.push(p);
		}
	}
	if (removed.length > 0) {
		log(
			stderr,
			`pending-research: ttl-cleanup count=${removed.length} paths=${removed.join(",")}`,
		);
	}
	return { removed };
}

/**
 * Handler per l'evento `milestone_end` (T02/M008/S03): rimozione completa dei
 * file pending-research del progetto. L'evento trasporta `cwd`; il cleanup è
 * fire-and-forget ma con catch che logga un errore strutturato su stderr.
 */
export async function handlePendingResearchMilestoneEnd(
	cwd: string,
	stderr: NodeJS.WritableStream = process.stderr,
): Promise<{ removed: string[] }> {
	return cleanupPendingResearch(cwd, stderr);
}

/**
 * Handler per l'evento `unit_start` (T02/M008/S03): fallback TTL — rimuove i
 * file pending-research scaduti oltre il TTL (default 24h).
 */
export async function handlePendingResearchUnitStart(
	cwd: string,
	stderr: NodeJS.WritableStream = process.stderr,
): Promise<{ removed: string[] }> {
	return cleanupStalePendingResearch(cwd, stderr);
}

// Registro di idempotenza di registrazione (stesso pattern di attachUnitAwareHooks).
const cleanupRegistriesByApi = new WeakMap<ExtensionAPI, boolean>();

/**
 * Registra gli hook di auto-cleanup dei file pending-research (T02):
 *
 *   - `milestone_end`  → rimuove entrambi (cleanupPendingResearch) al
 *                        termine del milestone, in qualunque esito
 *                        (completed/failed/cancelled).
 *   - `unit_start`      → fallback TTL: i file più vecchi di 24h vengono
 *                        rimossi se il milestone_end non è mai arrivato.
 *
 * Idempotente sull'ExtensionAPI (WeakMap). Ritorna `true` se gli hook sono
 * (ri)registrati, `false` su chiamate duplicate per la stessa `api`.
 *
 * @param api ExtensionAPI da activate(api)
 * @param stderr Sink opzionale per il log strutturato (default process.stderr)
 */
export function attachPendingResearchCleanupHooks(
	api: ExtensionAPI,
	stderr: NodeJS.WritableStream = process.stderr,
): boolean {
	if (cleanupRegistriesByApi.get(api)) return false;
	cleanupRegistriesByApi.set(api, true);

	// Guardia difensiva sul `cwd` dell'evento: gli eventi reali del runtime
	// trasportano sempre `cwd` (schema SDK), ma se per qualsiasi motivo arriva
	// un evento senza path valido il cleanup viene saltato silenziosamente —
	// non ha senso log compagnare path non target e non c'è nulla da ripulire.
	const hasCwd = (
		event: { type: string; cwd?: string },
	): event is { type: string; cwd: string } =>
		typeof event.cwd === "string" && event.cwd.length > 0;

	api.on("milestone_end", (event: {
		type: "milestone_end";
		cwd: string;
		status: "completed" | "failed" | "cancelled";
	}) => {
		if (!hasCwd(event)) return;
		handlePendingResearchMilestoneEnd(event.cwd, stderr).catch(
			(err: unknown) =>
				log(
					stderr,
					`pending-research: milestone_end cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
				),
		);
	});

	api.on("unit_start", (event: { type: "unit_start"; cwd?: string; unitType: string }) => {
		if (!hasCwd(event)) return;
		handlePendingResearchUnitStart(event.cwd, stderr).catch(
			(err: unknown) =>
				log(
					stderr,
					`pending-research: ttl cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
				),
		);
	});

	return true;
}