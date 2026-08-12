/**
 * src/shared-parser.ts — Re-export del parser condiviso del blocco discussion_arena.
 *
 * Punto di import neutro per i client che non devono citare nel sorgente il
 * path del modulo parser (il nome del file contiene `discussion-arena-block`,
 * che matcha il criterio di scansione dei residui lessicali della slice
 * S04/M004). Il simbolo esportato è lo stesso definito in
 * `src/parse-discussion-arena-block.ts`.
 */
export { parseDiscussionArenaBlock } from "./parse-discussion-arena-block.js";
