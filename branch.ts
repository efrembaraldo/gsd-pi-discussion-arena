/**
 * branch.ts — Helper puri per la capability additive `branch` del tool
 * `discussion_arena` (M018/S04, T02). Stesso pattern di `replay.ts`:
 * funzioni pure (no I/O, no clock, no fs) consumate dal factory in T03
 * per la logica di branching di sessioni.
 *
 * Espone due helper:
 *
 * - `extractTranscriptPrefix(transcript, afterRound)` — funzione PURA che
 *   splitta un transcript antenato in blocchi `### Round N — ...` (usando
 *   la stessa regex di `truncateTranscriptForPrompt` in index.ts riga 240)
 *   e ritorna il prefisso che include TUTTI i round fino ad `afterRound`
 *   INCLUSO. Edge case `afterRound === 0` → stringa vuota; `afterRound >
 *   roundsDelParent` → lancia `RangeError`.
 *
 * - `validateBranchRequest(request, parentRounds, parentExists,
 *   newTopicExists)` — funzione PURA che concentra TUTTE le validazioni
 *   D058 del branch request in un solo check point. Ritorna
 *   `{ valid: true }` o `{ valid: false; error: string }` con messaggi
 *   stabili (per test riproducibili e documentazione).
 *
 * Vincoli (R001, R064, D004): zero dipendenze npm runtime; nessun I/O,
 * nessun accesso a clock o filesystem, nessun side-effect. Stessa sequenza
 * di input produce stesso output (no random, no Date.now). Il modulo è
 * auto-contenuto: i suoi export sono consumati dal factory T03 ma il modulo
 * NON importa nulla da altri moduli (a parte type-only imports se
 * necessari). Anti-regressione compile-time via named exports + typecheck.
 */

export interface BranchRequest {
	fromSessionId: string;
	fromTopicSlug: string;
	afterRound: number;
	newTopic: string;
}

export type BranchValidationResult =
	| { valid: true }
	| { valid: false; error: string };

/**
 * Ritorna il prefisso del transcript che include TUTTI i round fino ad
 * `afterRound` INCLUSO. Funzione PURA: nessun I/O, nessun side-effect.
 *
 * Algoritmo:
 * 1. `afterRound === 0` → ritorna `""` (nessun round incluso, nessun header).
 * 2. Split del transcript per la regex `/\n\n(?=### Round \d+)/g` — la
 *    stessa usata da `truncateTranscriptForPrompt` (index.ts riga 240). Lo
 *    split produce un array di blocchi separati dai `\n\n` che precedono
 *    un header `### Round N`. Il PRIMO blocco può essere un header
 *    (testo arbitrario prima del primo round) OPPURE il primo round.
 * 3. Conteggio round: `parts.length - 1` se il primo blocco è un header
 *    (non inizia con `### Round N`), altrimenti `parts.length`.
 * 4. Se `afterRound > roundsDelParent` → `RangeError` con messaggio
 *    chiaro (include `afterRound` e i rounds effettivamente presenti).
 * 5. Ritorna i primi `afterRound` round, ripristinando il join con `\n\n`
 *    (slice(0, afterRound+1) con header, slice(0, afterRound) senza).
 *
 * Edge cases:
 * - `afterRound === 0` → stringa vuota (branch da zero round del parent).
 * - `afterRound > roundsDelParent` → `RangeError` chiaro.
 * - Transcript vuoto o senza round → 0 round, dopoRound >= 1 lancia.
 *
 * @param transcript - transcript antenato (formato canonico con blocchi
 *   `### Round N — participantId` separati da `\n\n`).
 * @param afterRound - 1-based: numero di round del parent da includere nel
 *   prefisso. `0` = nessun round; valori > roundsDelParent sono invalidi.
 * @returns prefisso del transcript (stringa) che include tutti i round
 *   fino ad `afterRound` INCLUSO, con eventuale header del parent
 *   preservato in testa.
 * @throws {RangeError} se `afterRound > roundsDelParent` o se
 *   `afterRound < 0` o non è un intero finito.
 */
export function extractTranscriptPrefix(
	transcript: string,
	afterRound: number,
): string {
	if (afterRound === 0) return "";
	if (
		!Number.isInteger(afterRound) ||
		afterRound < 0
	) {
		throw new RangeError(
			`extractTranscriptPrefix: afterRound must be a non-negative integer, got ${afterRound}`,
		);
	}

	// Stessa regex di truncateTranscriptForPrompt (index.ts riga 240):
	// split su `\n\n` prima di un header `### Round N`.
	const re = /\n\n(?=### Round \d+)/g;
	const parts: string[] = [];
	let lastIdx = 0;
	let m: RegExpExecArray | null;
	while ((m = re.exec(transcript)) !== null) {
		parts.push(transcript.slice(lastIdx, m.index));
		lastIdx = m.index + 2;
	}
	parts.push(transcript.slice(lastIdx));

	// Conteggio round: dipende se il primo blocco è un header o il round 1.
	const firstBlock = parts[0];
	const firstBlockIsRound =
		firstBlock !== undefined && /^### Round \d+/.test(firstBlock);
	const totalRounds = firstBlockIsRound ? parts.length : parts.length - 1;

	if (afterRound > totalRounds) {
		throw new RangeError(
			`extractTranscriptPrefix: afterRound=${afterRound} exceeds rounds in transcript (${totalRounds})`,
		);
	}

	// Slice: include header (se presente) + primi `afterRound` round.
	const sliceLength = firstBlockIsRound ? afterRound : afterRound + 1;
	return parts.slice(0, sliceLength).join("\n\n");
}

/**
 * Validatore centralizzato per un branch request (M018/S04, D058).
 * Funzione PURA: nessun I/O, nessun side-effect, deterministica.
 *
 * Concentra TUTTE le check del branch request in un solo punto per evitare
 * scattering della logica di validazione tra factory e short-circuit. Il
 * factory T03 chiama questa funzione PRIMA di qualsiasi I/O e decide se
 * procedere con la creazione della sessione figlia o short-circuitare con
 * errore.
 *
 * Check (ordine di valutazione; i messaggi di errore sono STABILI perché
 * usati nei test):
 * 1. `request.fromSessionId` non vuoto.
 * 2. `request.fromTopicSlug` non vuoto.
 * 3. `request.newTopic` non vuoto.
 * 4. `request.afterRound` è un intero >= 1 (almeno 1 round dal parent).
 * 5. `request.afterRound <= parentRounds` (no branch oltre la fine del parent).
 * 6. `parentExists === true` (la sessione antenata deve esistere su disco).
 * 7. `newTopicExists === false` (la sessione figlia NON deve pre-esistere;
 *    niente overwrite).
 *
 * @param request - branch request con fromSessionId, fromTopicSlug,
 *   afterRound, newTopic.
 * @param parentRounds - numero di round effettivamente presenti nella
 *   sessione antenata (per la check dopoRound <= parentRounds).
 * @param parentExists - `true` se la sessione antenata esiste su disco.
 * @param newTopicExists - `true` se esiste già una sessione per `newTopic`
 *   (protezione no-overwrite, D058).
 * @returns `{ valid: true }` se tutti i check passano; altrimenti
 *   `{ valid: false, error }` con messaggio canonico che identifica la
 *   causa del rifiuto.
 */
export function validateBranchRequest(
	request: BranchRequest,
	parentRounds: number,
	parentExists: boolean,
	newTopicExists: boolean,
): BranchValidationResult {
	if (request.fromSessionId === "" || request.fromSessionId === undefined) {
		return { valid: false, error: "fromSessionId must be non-empty" };
	}
	if (request.fromTopicSlug === "" || request.fromTopicSlug === undefined) {
		return { valid: false, error: "fromTopicSlug must be non-empty" };
	}
	if (request.newTopic === "" || request.newTopic === undefined) {
		return { valid: false, error: "newTopic must be non-empty" };
	}
	if (
		!Number.isInteger(request.afterRound) ||
		request.afterRound < 1
	) {
		return {
			valid: false,
			error: `afterRound must be integer >= 1, got ${request.afterRound}`,
		};
	}
	if (request.afterRound > parentRounds) {
		return {
			valid: false,
			error: `afterRound out of range: ${request.afterRound} > parentRounds=${parentRounds}`,
		};
	}
	if (!parentExists) {
		return {
			valid: false,
			error: `parent session not found: ${request.fromTopicSlug}`,
		};
	}
	if (newTopicExists) {
		return {
			valid: false,
			error: `newTopic already exists: ${request.newTopic}`,
		};
	}
	return { valid: true };
}