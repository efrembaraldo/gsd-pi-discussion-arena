/**
 * src/log-prefix.ts — Prefisso di log stderr canonico (D053).
 *
 * Estratto in modulo dedicato dalla slice S04 (rename lessicale M004): il
 * prefisso strutturato `[discussion-arena]` resta INVARIATO a runtime (slice
 * verification S04), ma i file client non devono contenere token lessicali
 * del termine isolato nel sorgente (criterio T03/M004). Importare
 * `LOG_PREFIX` produce la stessa stringa emessa su stderr.
 */

/** Prefisso di log stderr strutturato `[discussion-arena]` (D053) — invariato. */
export const LOG_PREFIX = "[discussion-arena]";
