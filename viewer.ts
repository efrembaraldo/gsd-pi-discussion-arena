/**
 * Viewer HTML statico per la discussion-arena (M018/S06, T01 — modulo PURO).
 *
 * Renderizza l'event log (gia' letto dal caller come array di
 * `DiscussionArenaEvent`) in un documento HTML standalone:
 * - nessun asset esterno (nessun `<link>`, nessun `src=`, nessun CDN);
 * - CSS embedded inline nell'<head> con tema chiaro/scuro via
 *   `@media (prefers-color-scheme: dark)`;
 * - TUTTO il testo partecipante passa da `escapeHtml` (difesa XSS, R8);
 * - un `<article class="round">` per round del transcript ricostruito
 *   (riuso di `reconstructTranscript` da replay.ts, single source of
 *   truth per la forma `### Round N — participantId`);
 * - un `<div class="decision-box">` per round quando `extractDecisionBlocks`
 *   (decision.ts) trova blocchi fenced decision: JSON pretty ESCAPATO se
 *   il parsing riesce, messaggio `decision-error` visibile altrimenti.
 *
 * Determinismo: funzione PURA — niente Date.now, niente random, nessun
 * timestamp di generazione nell'output. Stessi eventi → stringa
 * byte-identica (idempotenza del re-run, vincolo S06).
 *
 * Gli errori NON vengono mai lanciati verso il caller: l'I/O vero (lettura
 * log, scrittura file) vive nel layer successivo (T02, `runViewer`).
 */

import * as path from "node:path";
import type { DiscussionArenaEvent } from "./helpers.js";
import { extractDecisionBlocks } from "./decision.js";
import { reconstructTranscript } from "./replay.js";

/**
 * Path canonico della view HTML di una discussion-arena:
 * `<cwd>/.gsd/discussion-arena/views/<discussionArenaId>.html`. Nessun I/O —
 * solo composizione path (pattern `discussionArenaEventLogPath` in replay.ts).
 */
export function discussionArenaViewPath(cwd: string, discussionArenaId: string): string {
	return path.join(cwd, ".gsd", "discussion-arena", "views", `${discussionArenaId}.html`);
}

/**
 * Escape HTML dei cinque caratteri pericolosi (`& < > " '`), ordine
 * canonico: `&` per primo per non ri-escapare le entita' successive.
 * Applicato a OGNI testo derivato dai dati partecipanti prima di
 * includerlo nel documento (difesa XSS R8).
 */
export function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/** Header round canonico del transcript (prima riga di ogni blocco round). */
const ROUND_HEADER_RE = /^### Round (\d+) — (.*)$/;

/** CSS embedded inline: reset minimo + system font stack + variabili colore + dark mode. */
const VIEWER_STYLE = `
	:root {
		color-scheme: light dark;
		--bg: #ffffff;
		--fg: #1a1a1a;
		--muted: #666666;
		--border: #d0d0d0;
		--accent: #0b57d0;
		--decision-bg: #f2f7ff;
		--error-bg: #fff2f2;
		--error-fg: #a4262c;
	}
	@media (prefers-color-scheme: dark) {
		:root {
			--bg: #1c1c1e;
			--fg: #e8e8e8;
			--muted: #a0a0a0;
			--border: #3a3a3c;
			--accent: #8ab4f8;
			--decision-bg: #262a33;
			--error-bg: #3a2226;
			--error-fg: #ff9aa2;
		}
	}
	* { box-sizing: border-box; margin: 0; padding: 0; }
	body {
		background: var(--bg);
		color: var(--fg);
		font-family: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
		line-height: 1.5;
		padding: 1.5rem;
	}
	main { max-width: 60rem; margin: 0 auto; }
	h1 { font-size: 1.4rem; margin-bottom: 1rem; }
	article.round {
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 1rem;
		margin-bottom: 1rem;
	}
	article.round h2 {
		font-size: 1rem;
		color: var(--muted);
		border-bottom: 1px solid var(--border);
		padding-bottom: 0.5rem;
		margin-bottom: 0.75rem;
	}
	pre.participant {
		white-space: pre-wrap;
		word-break: break-word;
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 0.85rem;
	}
	div.decision-box {
		background: var(--decision-bg);
		border-left: 4px solid var(--accent);
		border-radius: 4px;
		padding: 0.75rem;
		margin-top: 0.75rem;
	}
	div.decision-box h3 { font-size: 0.85rem; margin-bottom: 0.5rem; color: var(--accent); }
	div.decision-box pre {
		white-space: pre-wrap;
		word-break: break-word;
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 0.8rem;
	}
	p.decision-error {
		background: var(--error-bg);
		color: var(--error-fg);
		border-radius: 4px;
		padding: 0.5rem;
		margin-top: 0.5rem;
		font-size: 0.85rem;
	}
	p.empty { color: var(--muted); font-style: italic; }
`.trim();

/** Estrae il titolo dal dato (`discussionArenaId` dell'evento start), non dal clock. */
function deriveTitle(events: readonly DiscussionArenaEvent[]): string {
	for (const ev of events) {
		if (ev.type === "discussion_arena_start") {
			const id = ev.discussionArenaId;
			if (typeof id === "string" && id.length > 0) return `Discussion Arena ${id}`;
		}
	}
	return "Discussion Arena";
}

/** Splitta il transcript ricostruito nei blocchi round (header canonico incluso). */
function splitRounds(transcript: string): string[] {
	const trimmed = transcript.trim();
	if (trimmed === "") return [];
	const re = /\n\n(?=### Round \d+)/g;
	const parts: string[] = [];
	let lastIdx = 0;
	let m: RegExpExecArray | null;
	while ((m = re.exec(trimmed)) !== null) {
		parts.push(trimmed.slice(lastIdx, m.index));
		lastIdx = m.index + 2;
	}
	parts.push(trimmed.slice(lastIdx));
	return parts.filter((p) => ROUND_HEADER_RE.test(p.split("\n", 1)[0] ?? ""));
}

/** Renderizza un blocco decision: JSON pretty escaped, o errore di parsing visibile. */
function renderDecisionBox(block: ReturnType<typeof extractDecisionBlocks>[number]): string {
	const lines: string[] = [];
	lines.push('<div class="decision-box">');
	lines.push(
		`<h3>Decision — Round ${escapeHtml(String(block.round))} — ${escapeHtml(block.participantId)}</h3>`,
	);
	if (block.parseError === null) {
		lines.push(`<pre>${escapeHtml(JSON.stringify(block.parsed, null, 2))}</pre>`);
	} else {
		lines.push(`<p class="decision-error">Decision parse error: ${escapeHtml(block.parseError)}</p>`);
		lines.push(`<pre>${escapeHtml(block.rawText)}</pre>`);
	}
	lines.push("</div>");
	return lines.join("\n");
}

/** Renderizza un singolo round come `<article class="round">`. */
function renderRound(roundText: string): string {
	const firstNewline = roundText.indexOf("\n");
	const header = firstNewline === -1 ? roundText : roundText.slice(0, firstNewline);
	const body = firstNewline === -1 ? "" : roundText.slice(firstNewline + 1);

	const lines: string[] = [];
	lines.push('<article class="round">');
	lines.push(`<h2>${escapeHtml(header)}</h2>`);
	lines.push(`<pre class="participant">${escapeHtml(body)}</pre>`);
	for (const block of extractDecisionBlocks(roundText)) {
		lines.push(renderDecisionBox(block));
	}
	lines.push("</article>");
	return lines.join("\n");
}

/**
 * Renderizza l'intero documento HTML standalone dall'event log. PURA e
 * deterministica: stessi eventi in ingresso → stessa stringa in uscita,
 * byte per byte (nessun timestamp di generazione, nessun randomness).
 *
 * @param events - eventi gia' letti dal caller (nessun I/O qui)
 * @returns documento HTML completo (`<!DOCTYPE html>` ... `</html>`)
 */
export function renderViewer(events: readonly DiscussionArenaEvent[]): string {
	const title = deriveTitle(events);
	const rounds = splitRounds(reconstructTranscript(events));

	const lines: string[] = [];
	lines.push("<!DOCTYPE html>");
	lines.push('<html lang="en">');
	lines.push("<head>");
	lines.push('<meta charset="utf-8">');
	lines.push(`<title>${escapeHtml(title)}</title>`);
	lines.push(`<style>\n${VIEWER_STYLE}\n</style>`);
	lines.push("</head>");
	lines.push("<body>");
	lines.push("<main>");
	lines.push(`<h1>${escapeHtml(title)}</h1>`);
	if (rounds.length === 0) {
		lines.push('<p class="empty">No rounds recorded in this discussion arena.</p>');
	} else {
		for (const round of rounds) {
			lines.push(renderRound(round));
		}
	}
	lines.push("</main>");
	lines.push("</body>");
	lines.push("</html>");
	return lines.join("\n");
}
