/**
 * scribe-synthesis.ts — Helper puri per la sintesi finale del Scribe
 * (M018/S05, T01). Stesso pattern di `decision.ts`/`branch.ts`:
 * funzione pura (no I/O, no clock, no fs) consumata dal factory in
 * T02 per popolare `details.finalDecision` quando l'utente passa
 * `decisionSchema` al tool `discussion_arena`.
 *
 * Espone un export + 1 interface:
 *
 * - `FinalDecisionBlock` (interface exported) — struttura normalizzata
 *   del blocco `\`\`\`final-decision` estratto dall'ULTIMO turno del
 *   participant con role scribe. Stessi campi utili di
 *   `ParsedDecisionBlock` ma SENZA `participantId`/`round` (il contesto
 *   di appartenenza è il Scribe stesso per definizione — l'informazione
 *   round è disponibile nell'header del turno se necessario ma non
 *   viene serializzata qui per minimizzare l'envelope `details`).
 *
 * - `synthesizeFinalDecision(transcript, opts?)` — funzione PURA che
 *   identifica l'ULTIMO turno del participant con `role === scribeRole`
 *   (default "Scribe"), estrae l'ULTIMO blocco `\`\`\`final-decision ...
 *   \`\`\`` nel body di quel turno, e tenta il parsing JSON tramite
 *   `parseDecisionPayload` (riuso da `decision.ts`).
 *
 * Vincoli (R001, R064, D004): zero dipendenze npm runtime; nessun I/O,
 * nessun accesso a clock o filesystem, nessun side-effect. Il modulo
 * riusa `parseDecisionPayload` da `decision.ts` per garantire lo stesso
 * shape `parsed`/`parseError` su entrambi i canali decisionali (uno
 * per-turno + uno finale). Auto-contenuto per test in isolamento.
 */

import { parseDecisionPayload } from "./decision.js";

export interface FinalDecisionBlock {
	rawText: string;
	parsed: unknown;
	parseError: string | null;
}

/**
 * Regex canonica dell'header round usata per identificare il turno del
 * Scribe. Formato atteso: `### Round N — participantId (role)`. Il
 * gruppo 3 (role) viene matchato case-sensitively vs `opts.scribeRole`
 * (default "Scribe", coerente con `scribe.example.md` che ha
 * `role: Scribe`). Costante interna (no ri-export).
 */
const ROUND_HEADER_RE = /^### Round (\d+) — (.*) \((.*)\)$/m;

/**
 * Regex di fallback per transcript con header SENZA parens (coerente
 * con `replay.ts` e `branch.ts`). In questo caso, il fallback NON può
 * distinguere il role del participant (manca il campo role in parens),
 * quindi NON matcha il pattern scribe — questa regex esiste solo per
 * consistenza con `decision.ts` e non viene usata per filtrare il
 * scribe. Costante interna (no ri-export).
 */
const ROUND_HEADER_FALLBACK_RE = /^### Round (\d+) — (.*)$/m;

/**
 * Compila la regex di estrazione del blocco fenced per il `delimiter`
 * dato. Vedi `decision.ts` per i dettagli (global + non-greedy + escape
 * dei meta-char).
 */
function buildFencedBlockRegex(delimiter: string): RegExp {
	const escaped = delimiter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`${escaped}\\s*\\n([\\s\\S]*?)\\n?\\s*\`\`\``, "g");
}

/**
 * Sintetizza il blocco `\`\`\`final-decision` emesso dall'ULTIMO turno
 * del Scribe. Funzione PURA: nessun I/O, nessun side-effect.
 *
 * Algoritmo:
 * 1. Split del transcript in round block (stesso pattern di
 *    `extractDecisionBlocks` in decision.ts: split su
 *    `\n\n(?=### Round \d+)`).
 * 2. Per ogni round block, parsifica l'header
 *    `### Round N — participantId (role)` con `ROUND_HEADER_RE`.
 *    Tiene solo i block il cui `role` (gruppo 3) matcha esattamente
 *    `opts.scribeRole` (default "Scribe"). Tra questi, tiene SOLO
 *    l'ULTIMO (il blocco più recente del Scribe wins).
 * 3. Se nessun turno scribe → ritorna `null` (no Scribe in questo
 *    transcript).
 * 4. Se scribe presente ma senza blocco `final-decision` → ritorna
 *    `null` (Scribe non ha ancora emesso la sintesi decisionale).
 * 5. Se scribe presente CON blocco, estrae l'ULTIMO match e ritorna:
 *    - `{ rawText, parsed: <obj>, parseError: null }` su JSON valido.
 *    - `{ rawText, parsed: null, parseError: <msg> }` su JSON malformato
 *      (NON null — l'utente vuole sapere che il blocco esiste ma è
 *      rotto; differente dal caso "no blocco" che è null).
 *
 * NOTA: il round block del scribe può contenere testo libero + 1+
 * blocchi `final-decision`. La regex è global + non-greedy → cattura
 * TUTTI i blocchi; noi teniamo solo l'ULTIMO (ultimo write vince,
 * coerente con il pattern append-only di replay.ts).
 *
 * NOTA: la detection scribe è case-sensitive. Se l'utente vuole
 * case-insensitive, può passare `opts.scribeRole` esplicitamente. Il
 * default "Scribe" è canonico (coerente con `scribe.example.md:2` che
 * ha `role: Scribe`).
 *
 * NOTA: il fallback `ROUND_HEADER_FALLBACK_RE` NON viene usato per
 * filtrare il scribe (il fallback perde l'informazione role). Se il
 * transcript ha solo header senza parens, la detection scribe ritorna
 * `null` (coerente: senza role non possiamo identificare il Scribe).
 *
 * @param transcript - transcript canonico con blocchi round separati da
 *   `\n\n` e header `### Round N — participantId (role)`.
 * @param opts - opzioni di sintesi:
 *   - `scribeRole` (default "Scribe"): stringa del role esatto del
 *     participant il cui ultimo turno contiene il blocco finale.
 *   - `delimiter` (default `` ```final-decision ``): stringa di
 *     apertura del fence finale.
 * @returns `null` se nessun Scribe o nessun blocco; altrimenti
 *   `FinalDecisionBlock` con parsed OR parseError popolato.
 */
export function synthesizeFinalDecision(
	transcript: string,
	opts?: { scribeRole?: string; delimiter?: string },
): FinalDecisionBlock | null {
	const scribeRole = opts?.scribeRole ?? "Scribe";
	const delimiter = opts?.delimiter ?? "```final-decision";
	const blockRe = buildFencedBlockRegex(delimiter);

	// Split del transcript in round block (pattern riusato da decision.ts).
	const re = /\n\n(?=### Round \d+)/g;
	const parts: string[] = [];
	let lastIdx = 0;
	let m: RegExpExecArray | null;
	while ((m = re.exec(transcript)) !== null) {
		parts.push(transcript.slice(lastIdx, m.index));
		lastIdx = m.index + 2;
	}
	parts.push(transcript.slice(lastIdx));

	// Trova l'ULTIMO round block il cui role === scribeRole. La regex
	// canonica richiede il role in parens; il fallback NON contiene il
	// role e quindi NON matcha (decisionale: senza role esplicito non
	// filtriamo il Scribe).
	let lastScribeBlock: string | null = null;
	for (const part of parts) {
		const headerMatch = part.match(ROUND_HEADER_RE);
		if (headerMatch && headerMatch[3] === scribeRole) {
			lastScribeBlock = part;
		}
	}
	if (lastScribeBlock === null) {
		return null;
	}

	// Estrai l'ULTIMO blocco `final-decision` dal block del Scribe.
	// Resetta lastIndex perché `g` mantiene lo state cross-call.
	blockRe.lastIndex = 0;
	let lastMatch: RegExpExecArray | null = null;
	let bm: RegExpExecArray | null;
	while ((bm = blockRe.exec(lastScribeBlock)) !== null) {
		lastMatch = bm;
	}
	if (lastMatch === null) {
		return null;
	}

	const rawText = lastMatch[1] ?? "";
	const { parsed, parseError } = parseDecisionPayload(rawText);
	return { rawText, parsed, parseError };
}

// Sopprime il warning "unused" se il fallback non viene usato in futuro.
// Mantenuto come documentazione del pattern di branch.ts.
void ROUND_HEADER_FALLBACK_RE;
