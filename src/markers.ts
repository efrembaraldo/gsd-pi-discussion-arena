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

/**
 * Marker idempotente per l'iniezione dell'istruzione di ricerca
 * (`gsd-pi-discussion-arena-research-instruction`) — introdotto nella slice
 * S08/M008 per il gate del phase adr/research (gruppo `research-decision`).
 * Rispetta la stessa convenzione del marker planning: stringa runtime
 * invariata, parte del protocollo di idempotenza asserito dai test
 * hooks-research.
 *
 * NOTA: questo marker è distinto dal marker del gruppo "research" (introdotto
 * in S02/M010): `research-decision` copre il singolo unitType
 * `research-decision` (sotto-gruppo adr-research), mentre `research` copre i
 * 3 unitType canonici di ricerca (research-milestone, research-project,
 * research-slice). I due manifestano la biiezione D102 (researching ->
 * research-decision, refining -> research) e coesistono in index.ts.
 */
export const RESEARCH_INSTRUCTION_MARKER =
	"<!-- gsd-pi-discussion-arena-research-instruction -->";

/**
 * Marker idempotente per l'iniezione dell'istruzione del gruppo `research`
 * (M010/S02) — distinto da RESEARCH_INSTRUCTION_MARKER (gruppo
 * `research-decision`). Cobre i 3 unitType `research-milestone`,
 * `research-project`, `research-slice`. Stringa runtime invariata, parte
 * del protocollo di idempotenza asserito dai test group-eligibility.
 */
export const RESEARCH_GROUP_INSTRUCTION_MARKER =
	"<!-- gsd-pi-discussion-arena-research-group-instruction -->";

/**
 * Marker idempotente per l'iniezione dell'istruzione del gruppo `discussing`
 * (M010/S02) — copre i 3 unitType `discuss-milestone`, `discuss-project`,
 * `discuss-requirements`. Stringa runtime invariata, parte del protocollo
 * di idempotenza asserito dai test group-eligibility.
 */
export const DISCUSSING_INSTRUCTION_MARKER =
	"<!-- gsd-pi-discussion-arena-discussing-instruction -->";

/**
 * Marker idempotente per l'iniezione dell'istruzione del gruppo `executing`
 * (M010/S02) — copre i 4 unitType `execute-task`, `reactive-execute`,
 * `run-uat`, `reassess-roadmap`. Stringa runtime invariata, parte del
 * protocollo di idempotenza asserito dai test group-eligibility.
 */
export const EXECUTING_INSTRUCTION_MARKER =
	"<!-- gsd-pi-discussion-arena-executing-instruction -->";

/**
 * Marker idempotente per l'iniezione dell'istruzione del gruppo `verifying`
 * (M010/S02) — copre i 3 unitType `validate-milestone`,
 * `complete-milestone`, `complete-slice`. Stringa runtime invariata, parte
 * del protocollo di idempotenza asserito dai test group-eligibility.
 */
export const VERIFYING_INSTRUCTION_MARKER =
	"<!-- gsd-pi-discussion-arena-verifying-instruction -->";
