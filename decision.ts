/**
 * decision.ts — Helper puri per la capability additiva G5 (M018/S05, T01).
 * Stesso pattern di `branch.ts`/`replay.ts`: funzioni pure (no I/O, no
 * clock, no fs) consumate dal factory in T02 per la logica di
 * estrazione dei blocchi `\`\`\`decision` dai transcript dei
 * partecipanti.
 *
 * Espone tre export + 1 interface:
 *
 * - `ParsedDecisionBlock` (interface exported) — struttura normalizzata
 *   di un blocco decision estratto dal transcript: `rawText` (testo
 *   interno al fence), `participantId` (header round precedente),
 *   `round` (numero round), `parsed` (JSON parsed o null), `parseError`
 *   (messaggio canonico o null).
 *
 * - `parseDecisionPayload(rawJson)` — funzione PURA di parsing JSON
 *   tollerante: try/catch + JSON.parse, ritorna `{parsed: <obj>,
 *   parseError: null}` su successo, `{parsed: null, parseError:
 *   <msg>}` su fallimento (msg include la reason del catch).
 *
 * - `extractDecisionBlocks(transcript, opts?)` — funzione PURA che
 *   splitta il transcript sui blocchi fenced (default `` ```decision ``)
 *   tollerante a testo libero prima/dopo ogni blocco. Per ogni blocco:
 *   associazione automatica a participantId + round via parsing
 *   dell'header round immediatamente precedente (regex canonica +
 *   fallback permissivo per header senza parens, cfr. branch.ts).
 *
 * Vincoli (R001, R064, D004): zero dipendenze npm runtime; nessun I/O,
 * nessun accesso a clock o filesystem, nessun side-effect. Stessa
 * sequenza di input produce stesso output (no random, no Date.now). Il
 * modulo è auto-contenuto: i suoi export sono consumati dal factory T02
 * + dalla sintesi scribe-synthesis.ts, ma il modulo NON importa nulla
 * da altri moduli (a parte type-only imports se necessari). Anti-
 * regressione compile-time via named exports + typecheck.
 */

export interface ParsedDecisionBlock {
	rawText: string;
	participantId: string;
	round: number;
	parsed: unknown;
	parseError: string | null;
}

/**
 * Regex canonica dell'header round usata per associare ogni blocco
 * decision al participantId/round del turno immediatamente precedente.
 * Formato atteso: `### Round N — participantId (role)`. Costante
 * interna (no ri-export).
 */
const ROUND_HEADER_RE = /^### Round (\d+) — (.*) \((.*)\)$/m;

/**
 * Regex di fallback per transcript con header SENZA parens
 * (coerente con `replay.ts` e `branch.ts` che emettono
 * `### Round ${round} — ${participantId}`). Costante interna.
 */
const ROUND_HEADER_FALLBACK_RE = /^### Round (\d+) — (.*)$/m;

/**
 * Compila la regex di estrazione del blocco fenced per il `delimiter`
 * dato. La regex è global + non-greedy: cattura il testo INTERNO al
 * fence fino al PRIMO `` ``` `` di chiusura (gestisce correttamente
 * payload body che contengono caratteri backtick purché non siano 3
 * backtick consecutivi). I meta-char del delimiter vengono escapati per
 * consentire delimiter custom senza rompere la regex.
 */
function buildFencedBlockRegex(delimiter: string): RegExp {
	const escaped = delimiter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`${escaped}\\s*\\n([\\s\\S]*?)\\n?\\s*\`\`\``, "g");
}

/**
 * Parsing JSON tollerante per il payload di un blocco decision.
 * Funzione PURA: nessun I/O, nessun side-effect. Ritorna SEMPRE uno
 * shape stabile:
 *
 * - Successo: `{ parsed: <obj|primitive>, parseError: null }`.
 * - Fallimento (qualsiasi eccezione di `JSON.parse`): `{ parsed: null,
 *   parseError: <msg> }` con `msg = String(err.message || err)` per
 *   garantire una stringa non-vuota (`parseError !== null`).
 *
 * Casi coperti (cfr. test in decision-schema.test.ts §1):
 * - JSON valido `{"choice":"approve"}` → parsed popolato, parseError null.
 * - JSON troncato `{"choice":"appr` → parsed null + parseError non-vuoto.
 * - JSON con virgolette sbagliate `{choice: approve}` → parsed null + parseError.
 * - JSON con commenti `// comment\n{"choice":"approve"}` → parsed null + parseError.
 * - Stringa vuota `""` → parsed null + parseError "empty payload".
 *
 * @param rawJson - payload testuale da parsare (stringa).
 * @returns `{ parsed, parseError }` con uno dei due sempre null.
 */
export function parseDecisionPayload(
	rawJson: string,
): { parsed: unknown; parseError: string | null } {
	if (typeof rawJson !== "string") {
		return { parsed: null, parseError: "rawJson must be a string" };
	}
	if (rawJson === "") {
		return { parsed: null, parseError: "empty payload" };
	}
	try {
		const parsed = JSON.parse(rawJson);
		return { parsed, parseError: null };
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		return { parsed: null, parseError: message };
	}
}

/**
 * Estrae TUTTI i blocchi decision da un transcript, tollerante a testo
 * libero prima/dopo ogni blocco. Funzione PURA: nessun I/O, nessun
 * side-effect, deterministica.
 *
 * Algoritmo:
 * 1. Compila la regex di estrazione dal `opts.delimiter` (default
 *    `` ```decision ``). La regex è global + non-greedy: cattura il
 *    testo INTERNO al fence fino al PRIMO `` ``` `` di chiusura.
 * 2. Split del transcript in "round block" su `\n\n(?=### Round \d+)`
 *    (la stessa logica di `extractTranscriptPrefix` in branch.ts).
 *    Ogni round block inizia con un header `### Round N — participantId
 *    (role)` oppure è testo libero prima del primo round.
 * 3. Per ogni round block, prova l'header canonico
 *    `ROUND_HEADER_RE` (formato con parens per role). Se non matcha,
 *    prova il fallback `ROUND_HEADER_FALLBACK_RE` (formato
 *    `### Round N — participantId`, coerente con replay.ts/branch.ts).
 *    Il fallback permissivo consente di usare il decision schema anche
 *    su transcript legacy. Edge case: round block senza header
 *    matchabile (testo libero puro) → `participantId = ""`,
 *    `round = 0`, il blocco viene comunque estratto.
 * 4. Per ogni blocco estratto, tenta `parseDecisionPayload` sul testo
 *    interno del fence. Se parsing OK → `parsed = obj, parseError =
 *    null`; altrimenti `parsed = null, parseError = <msg>`.
 * 5. Ritorna l'array di `ParsedDecisionBlock` (vuoto se nessun blocco
 *    trovato nel transcript).
 *
 * NOTA: il `rawText` ritornato è il testo INTERNO al fence (senza i
 * backtick di apertura/chiusura e senza la riga di intestazione del
 * delimiter, ma con eventuali newline interne al body del blocco). Edge
 * case: se il fence di chiusura non viene trovato (blocco troncato),
 * il blocco viene SCARTATO silenziosamente (fail-safe: nessun throw,
 * nessun blocco malformato nel risultato). Coerente con il pattern
 * fail-safe di replay.ts/branch.ts.
 *
 * @param transcript - transcript canonico con blocchi round separati da
 *   `\n\n` e header `### Round N — participantId (role)` oppure
 *   `### Round N — participantId` (fallback).
 * @param opts - opzioni di estrazione:
 *   - `delimiter` (default `` ```decision ``): stringa di apertura del
 *     fence. Usata sia come regex letterale (con escape dei meta-char)
 *     sia come marcatore di apertura del blocco.
 * @returns array di `ParsedDecisionBlock` (vuoto se nessun blocco).
 */
export function extractDecisionBlocks(
	transcript: string,
	opts?: { delimiter?: string },
): ParsedDecisionBlock[] {
	const delimiter = opts?.delimiter ?? "```decision";
	const blockRe = buildFencedBlockRegex(delimiter);

	// Split del transcript in round block. Stesso pattern di
	// extractTranscriptPrefix in branch.ts: split su \n\n prima di un
	// header `### Round N — `.
	const re = /\n\n(?=### Round \d+)/g;
	const parts: string[] = [];
	let lastIdx = 0;
	let m: RegExpExecArray | null;
	while ((m = re.exec(transcript)) !== null) {
		parts.push(transcript.slice(lastIdx, m.index));
		lastIdx = m.index + 2;
	}
	parts.push(transcript.slice(lastIdx));

	const blocks: ParsedDecisionBlock[] = [];
	for (const part of parts) {
		// Header round del block: prova prima la regex canonica
		// (con role in parens), poi il fallback permissivo (senza
		// parens). Il fallback è documentato JSDoc sopra.
		let round = 0;
		let participantId = "";
		const headerMatch = part.match(ROUND_HEADER_RE);
		if (headerMatch) {
			round = Number.parseInt(headerMatch[1] ?? "0", 10);
			participantId = (headerMatch[2] ?? "").trim();
		} else {
			const fallback = part.match(ROUND_HEADER_FALLBACK_RE);
			if (fallback) {
				round = Number.parseInt(fallback[1] ?? "0", 10);
				participantId = (fallback[2] ?? "").trim();
			}
		}

		// Cerca tutti i blocchi fenced `delimiter ... ``` nel part.
		// Resetta lastIndex perché `g` mantiene lo state cross-call.
		blockRe.lastIndex = 0;
		let bm: RegExpExecArray | null;
		while ((bm = blockRe.exec(part)) !== null) {
			const rawText = bm[1] ?? "";
			const { parsed, parseError } = parseDecisionPayload(rawText);
			blocks.push({
				rawText,
				participantId,
				round,
				parsed,
				parseError,
			});
		}
	}

	return blocks;
}
