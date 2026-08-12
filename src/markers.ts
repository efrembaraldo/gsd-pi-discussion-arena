/**
 * src/markers.ts — Costanti stringa condivise per l'iniezione di istruzioni.
 *
 * Estratto in modulo dedicato dalla slice S04 (rename lessicale M004): la
 * stringa marker è parte del protocollo runtime (asserita da
 * tests/hooks-planning.test.ts) e quindi INVARIATA, ma i file client non
 * devono contenere token lessicali del termine isolato nel sorgente
 * (criterio T03/M004). Importare la costante produce la stessa stringa
 * iniettata nel systemPrompt.
 */

/**
 * Marker idempotente per l'iniezione dell'istruzione di planning
 * (`gsd-pi-discussion-arena-planning-instruction`) — invariato, parte del
 * contratto di idempotenza asserito da tests/hooks-planning.test.ts.
 */
export const PLANNING_INSTRUCTION_MARKER =
	"<!-- gsd-pi-discussion-arena-planning-instruction -->";
