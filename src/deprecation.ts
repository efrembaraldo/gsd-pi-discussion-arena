/**
 * src/deprecation.ts — Utility condivisa per il deprecation warning "one-shot"
 * della sezione `discussion_arena:` in PREFERENCES.md (Tier 2-bis deprecato,
 * S03/M007).
 *
 * Il warning viene emesso su stderr al MASSIMO una volta per processo (dedup
 * a chiave stabile su Set modulo-scope), così non spamma ogni call di
 * `resolveTrigger` o ogni scrittura di `writeDiscussionArenaPreference` per
 * uno stesso progetto. La stringa esatta è parte della slice verification S03
 * («Warning one-shot stderr»), quindi è centralizzata qui una sola volta e
 * riusata da trigger-resolver.ts e src/preferences-writer.ts.
 *
 * Zero dipendenze npm (D004); il prefisso `[discussion-arena]` proviene da
 * LOG_PREFIX (D053) così il token lessicale non è duplicato nei client.
 */

import { LOG_PREFIX } from "./log-prefix.js";

/**
 * Messaggio di deprecazione della sezione `discussion_arena:` in PREFERENCES.md.
 * Stringa esatta del gate di verifica S03 (slice verification one-shot stderr):
 *   `[discussion-arena] DEPRECATION: discussion_arena: section in PREFERENCES.md
 *    is deprecated — move to .gsd/discussion-arena/discussion-arena-coordination.md
 *    under activation:.`
 * Il terminatore di riga viene aggiunto da `emitDeprecationWarningOnce` al
 * momento della scrittura, non fa parte del messaggio.
 */
export const DEPRECATION_PREFERENCES_MESSAGE: string =
	`${LOG_PREFIX} DEPRECATION: discussion_arena: section in PREFERENCES.md is ` +
	`deprecated — move to .gsd/discussion-arena/` +
	`discussion-arena-coordination.md under activation:.`;

/**
 * Emette `message` su `stderr` (default `process.stderr`) solo la prima volta
 * per una data `key` in questo processo.
 *
 * @returns true se il messaggio è stato emesso (prima volta), false se già
 *   emesso per la stessa key (dedup one-shot).
 */
export function emitDeprecationWarningOnce(
	key: string,
	message: string,
	stderr?: NodeJS.WritableStream,
): boolean {
	if (emittedOnceKeys.has(key)) {
		return false;
	}
	emittedOnceKeys.add(key);
	const target = stderr ?? process.stderr;
	target.write(message + "\n");
	return true;
}

/** Set modulo-scope delle chiavi già notificato (one-shot per processo). */
const emittedOnceKeys: Set<string> = new Set();