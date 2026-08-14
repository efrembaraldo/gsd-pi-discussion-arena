/**
 * src/discussion-arena-research-extractor.ts — Estrattore deterministico del
 * verbalizzato di ricerca del Scribe (M008/S02).
 *
 * Input: transcript markdown della discussion_arena (output del participant
 * Scribe). Il verbalizzato canonico atteso ha tre sezioni markdown:
 *
 *   ## Ipotesi
 *   ## Decisioni
 *   ## Requisiti
 *
 * Caratteristiche contrattuali (slice 08-02):
 *   - Deterministico: stesso transcript → stesso output (nessuna aleatorietà,
 *     nessuna dipendenza da model call).
 *   - Multi-pattern: le intestazioni accettano varianti di wording oltre la
 *     forma canonica (`## Ipotesi iniziali`, `## Decisioni prese`,
 *     `## Requisiti identificati`) oltre agli equivalenti inglesi
 *     (`## Hypotheses`, `## Decisions`, `## Requirements`).
 *   - Fail-safe: mai lancia eccezioni. In caso di parsing fallito o transcript
 *     insufficiente ritorna il fallback marker
 *     {fallback: 'model-call-needed', reason} al posto di throw.
 *   - Osservabilità: log stderr strutturato
 *     `[discussion-arena] extractor: fallback model-call-needed <reason>` per
 *     ogni fallback; nessun log per i successi (riduce rumore).
 *
 * Il parser è puro/deterministico (solo string-split + regex), niente I/O al
 * di fuori dell'eventuale log stderr opzionale passato dal chiamante.
 */

import { LOG_PREFIX } from "./log-prefix.js";

/** Priorità ammesse per un requisito (contract slice 08-02). */
export type RequirementPriority = "must-have" | "should-have" | "could-have";

/** Voce di decisione estratta dal verbalizzato. */
export interface DecisionItem {
	/** Enunciato della decisione (testo del bullet di primo livello). */
	statement: string;
	/** Rationale esplicito (sub-bullet `Razionale:`/`Reason:`), opzionale. */
	rationale?: string;
	/** Dissensi/obiezioni esplicitati (sub-bullet `Dissenso:`/`Dissent:`), opzionale. */
	dissent?: string[];
}

/** Voce di requisito estratta dal verbalizzato. */
export interface RequirementItem {
	/** Identificativo opzionale del requisito (es. `R1`, `REQ-1`). */
	id?: string;
	/** Titolo del requisito. */
	title: string;
	/** Descrizione dettagliata, vuota se non fornita. */
	description: string;
	/** Priorità normalizzata. */
	priority: RequirementPriority;
}

/** Output tipizzato di un parsing riuscito del verbalizzato di ricerca. */
export interface ResearchDecisions {
	/** Ipotesi di ricerca (bullet della sezione `## Ipotesi`). */
	hypotheses: string[];
	/** Decisioni emerse dalla discussione. */
	decisions: DecisionItem[];
	/** Requisiti identificati. */
	requirements: RequirementItem[];
}

/**
 * Marcator di fallback: il parsing deterministico non è riuscito e la
 * trasformazione richiede una valutazione con model call dedicata (opzione b
 * del piano slice). Mai prodotto con eccezioni.
 */
export const RESEARCH_FALLBACK = "model-call-needed" as const;

/** Unione di ritorno di extractResearchDecisions. */
export type ExtractResult =
	| ResearchDecisions
	| { fallback: typeof RESEARCH_FALLBACK; reason: string };

/** Messaggio stabile per una sezione assente. */
const MISSING_REASON = (section: string): string =>
	`transcript insufficiente: sezione mancante (${section})`;

/** Regex multi-pattern intestazione Ipotesi (italiano + inglese). */
const HEADING_HYPOTHESES =
	/^[ \t]*#{1,6}[ \t]+(ipotesi|hypotheses|hypothesis)\b[^#]*$/i;

/** Regex multi-pattern intestazione Decisioni (italiano + inglese). */
const HEADING_DECISIONS = /^[ \t]*#{1,6}[ \t]+(decisioni|decisions?)\b[^#]*$/i;

/** Regex multi-pattern intestazione Requisiti (italiano + inglese). */
const HEADING_REQUIREMENTS = /^[ \t]*#{1,6}[ \t]+(requisiti|requirements?)\b[^#]*$/i;

/** Regex dei bullet markdown (bullet di primo livello o indentato). */
const BULLET_RE = /^([ \t]*)[-*+][ \t]+(.*)$/;

/** Regex label per il rational di una decisione. */
const RATIONALE_RE = /^(razional\w*|reason|rationale)\s*:\s*(.*)$/i;

/** Regex label per il dissenso di una decisione. */
const DISSENT_RE =
	/^(dissens\w*|dissent\w*|obiezione|objection|cont)[^ \t:]*\s*:\s*(.*)$/i;

/** Regex label per la descrizione multilinea di un requisito. */
const DESC_RE = /^(descrizione|description|desc)\s*:\s*(.*)$/i;

/** Regex label per la priorità multilinea di un requisito. */
const PRIORITY_RE = /^(priorit[aà]|priority)\s*:\s*(.*)$/i;

/** Regex priorità inline tra parentesi. */
const PRIORITY_INLINE_RE = /\(\s*(must-have|should-have|could-have)\s*\)/gi;

/** Regex per un eventuale identificativo iniziale (bold `**R1**` o bare). */
const ID_LEAD_RE =
	/^(?:\*\*)?([A-Za-z0-9][A-Za-z0-9_.-]{0,24})(?:\*\*)?\s*[—–\-:]\s*/;

/** Normalizza una priorità in RequirementPriority (undefined se non valida). */
function normalizePriority(
	raw: string | undefined,
): RequirementPriority | undefined {
	if (!raw) return undefined;
	const v = raw.trim().toLowerCase();
	if (v === "must-have" || v === "should-have" || v === "could-have") return v;
	return undefined;
}

/** Pulisce un fraseggio: rimuove bold markdown esterno e normalizza spazi. */
function cleanPhrase(text: string): string {
	return text.replace(/^\*\*|\*\*$/g, "").replace(/\s+/g, " ").trim();
}

/** Una singola entry di primo livello con i suoi sub-bullet indentati. */
interface BulletEntry {
	indent: number;
	text: string;
	sub: BulletEntry[];
}

/**
 * Spezza una lista di righe in bullet di primo livello con i relativi
 * sub-bullet indentati. Righe non-bullet (prosa, vuote) sono ignorate per
 * estrazione: il contratto slice richiede bullet strutturati. Pura.
 */
function collectBullets(lines: string[]): BulletEntry[] {
	const entries: BulletEntry[] = [];
	let current: BulletEntry | null = null;
	for (const line of lines) {
		const m = line.match(BULLET_RE);
		if (!m) continue; // prosa/vuote ignorate
		const indent = m[1].length;
		const text = m[2].trim();
		if (current === null || indent <= current.indent) {
			current = { indent, text, sub: [] };
			entries.push(current);
		} else {
			current.sub.push({ indent, text, sub: [] });
		}
	}
	return entries;
}

/** Cerca l'indice della prima riga che matcha la regex intestazione. */
function findHeadingIndex(lines: string[], regex: RegExp): number | undefined {
	for (let i = 0; i < lines.length; i++) {
		if (regex.test(lines[i])) return i;
	}
	return undefined;
}

/**
 * Estrae la slice [start,end) di una sezione fino alla prossima intestazione
 * (tra le tre riconosciute) o fino a fine transcript.
 */
function sectionSlice(
	lines: string[],
	start: number,
	allHeadings: number[],
): { start: number; end: number } {
	let end = lines.length;
	for (const h of allHeadings) {
		if (h > start && h < end) end = h;
	}
	return { start, end };
}

/** Ritorna le righe [start,end) della slice. */
function sliceLines(
	lines: string[],
	slice: { start: number; end: number },
): string[] {
	return lines.slice(slice.start, slice.end);
}

/** Bullet di primo livello della slice di una sezione. */
function sectionBullets(
	lines: string[],
	slice: { start: number; end: number },
): BulletEntry[] {
	return collectBullets(sliceLines(lines, slice));
}

/**
 * Estrattore deterministico del verbalizzato di ricerca del Scribe.
 *
 * @param transcript Testo markdown completo del transcript della discussione.
 * @param stderr Sink log dove scrive il log stderr strutturato (default
 *        `process.stderr`). Nessun output su successo.
 * @returns `ResearchDecisions` se il parsing è riuscito (tutte e tre le
 *          sezioni presenti e almeno una voce estratta), altrimenti il
 *          fallback marker.
 */
export function extractResearchDecisions(
	transcript: string,
	stderr: NodeJS.WritableStream = process.stderr,
): ExtractResult {
	const fallbackReason = tryParse(transcript);
	if (fallbackReason !== undefined) {
		writeFallbackLog(stderr, fallbackReason);
		return { fallback: RESEARCH_FALLBACK, reason: fallbackReason };
	}
	return run(transcript, stderr);
}

/** Log stderr strutturato per un fallback (mai fallisce la chiamata). */
function writeFallbackLog(stderr: NodeJS.WritableStream, reason: string): void {
	const line = `${LOG_PREFIX} extractor: fallback model-call-needed ${reason}`;
	try {
		stderr.write(line + "\n");
	} catch {
		/* ignora errori di logging */
	}
}

/** Sincronizza le righe del transcript in un array ("" se vuoto). */
function splitLines(transcript: string): string[] {
	if (typeof transcript !== "string" || transcript.trim() === "") {
		return [];
	}
	return transcript.split(/\r?\n/);
}

/**
 * Verifica che il transcript sia parsabile: restituisce il reason di fallback
 * se tale, undefined se tutte e tre le sezioni sono presenti.
 */
function tryParse(transcript: string): string | undefined {
	const lines = splitLines(transcript);
	const hyp = findHeadingIndex(lines, HEADING_HYPOTHESES);
	const dec = findHeadingIndex(lines, HEADING_DECISIONS);
	const req = findHeadingIndex(lines, HEADING_REQUIREMENTS);
	if (hyp === undefined && dec === undefined && req === undefined) {
		return "transcript vuoto o senza struttura markdown riconoscibile";
	}
	const missing: string[] = [];
	for (const [name, idx] of [
		["ipotesi", hyp],
		["decisioni", dec],
		["requisiti", req],
	] as const) {
		if (idx === undefined) missing.push(name);
	}
	if (missing.length > 0) return MISSING_REASON(missing.join(", "));
	return undefined;
}

/** Parsing deterministico quando tutte le sezioni sono presenti. */
function run(transcript: string, stderr: NodeJS.WritableStream): ExtractResult {
	const lines = splitLines(transcript);
	const hyp = findHeadingIndex(lines, HEADING_HYPOTHESES)!;
	const dec = findHeadingIndex(lines, HEADING_DECISIONS)!;
	const req = findHeadingIndex(lines, HEADING_REQUIREMENTS)!;

	const headings = [hyp, dec, req];
	const hypSlice = sectionSlice(lines, hyp, headings);
	const decSlice = sectionSlice(lines, dec, headings);
	const reqSlice = sectionSlice(lines, req, headings);

	const hypotheses = sectionBullets(lines, hypSlice).map((b) =>
		cleanPhrase(b.text),
	);
	const decisions = sectionBullets(lines, decSlice).map(parseDecision);
	const requirements = sectionBullets(lines, reqSlice).map(parseRequirement);

	// Guardia di sufficienza: verbalizzato con tutte le sezioni ma nessuna
	// voce strutturata → considerato insufficiente → fallback.
	const total = hypotheses.length + decisions.length + requirements.length;
	if (total === 0) {
		const reason = "sezioni presenti ma nessuna voce estratta";
		writeFallbackLog(stderr, reason);
		return { fallback: RESEARCH_FALLBACK, reason };
	}

	return { hypotheses, decisions, requirements };
}

/** Parsa un bullet di decisione (incluse le eventuali label di dettaglio). */
function parseDecision(entry: BulletEntry): DecisionItem {
	const statement = cleanPhrase(entry.text);
	let rationale: string | undefined;
	const dissent: string[] = [];
	for (const sub of entry.sub) {
		const r = labeledText(RATIONALE_RE, sub.text);
		const d = labeledText(DISSENT_RE, sub.text);
		if (r !== undefined) rationale = r;
		else if (d !== undefined) dissent.push(d);
	}
	const result: DecisionItem = { statement };
	if (rationale !== undefined) result.rationale = rationale;
	if (dissent.length > 0) result.dissent = dissent;
	return result;
}

/** Estrae il testo di una label (Razionale/Dissenso/Descrizione/Priorità). */
function labeledText(regex: RegExp, text: string): string | undefined {
	const m = text.match(regex);
	return m ? m[2].trim() : undefined;
}

/** Parsa un bullet di voce requisito (inline e/o sottoproprietà). */
function parseRequirement(entry: BulletEntry): RequirementItem {
	let text = cleanPhrase(entry.text);
	let priority: RequirementPriority | undefined;
	let description = "";

	// Priorità inline tra parentesi: `(...)`.
	const prioInline = text.match(PRIORITY_INLINE_RE);
	if (prioInline) {
		const p = normalizePriority(prioInline[0]);
		if (p) priority = p;
		text = text.replace(PRIORITY_INLINE_RE, " ").trim();
	}

	// Identificativo iniziale: `**R1** — Titolo ...` oppure `R1: Titolo ...`.
	let id: string | undefined;
	const idMatch = text.match(ID_LEAD_RE);
	if (idMatch) {
		id = idMatch[1];
		text = text.slice(idMatch[0].length).trim();
	}

	// Descrizione inline separata da due punti (`Titolo: descrizione`).
	const colon = text.indexOf(":");
	if (colon >= 0) {
		const after = text.slice(colon + 1).trim();
		if (after.length > 0) {
			description = after;
		}
		text = colon === 0 ? after : text.slice(0, colon).trim();
	}

	// Proprietà multilinea (sub-bullet): Descrizione/Priorità.
	for (const sub of entry.sub) {
		const d = labeledText(DESC_RE, sub.text);
		const p = labeledText(PRIORITY_RE, sub.text);
		if (d !== undefined) description = d;
		if (p !== undefined) {
			const np = normalizePriority(p);
			if (np) priority = np;
		}
	}

	return {
		id,
		title: text,
		description: description ?? "",
		priority: priority || "must-have",
	};
}