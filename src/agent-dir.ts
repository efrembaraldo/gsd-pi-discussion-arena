/**
 * src/agent-dir.ts — canonical TS source of truth per la risoluzione
 * dell'agent dir e per il path relativo del coordination file user-level.
 *
 * Decisioni di riferimento:
 *   - D137 (canonical default): l'agent dir è `$HOME/.gsd/agent`, con
 *     override onorato tramite `env.GSD_AGENT_DIR` se settato e non vuoto.
 *   - D138 (source of truth TS): questa è la copia canonica riusata dal
 *     codice TypeScript del progetto. Lo script CLI
 *     `scripts/copy-template.mjs` mantiene una copia locale di 5 righe
 *     (Node ESM puro, non passa per TS) per il postinstall — il rischio di
 *     drift tra le due implementazioni è mitigato dal test di parity
 *     `tests/agent-dir-parity.test.ts` (parità 1:1 su ogni combinazione di
 *     env).
 *
 * Riuso:
 *   - S02 (Coordination lookup al livello user): `participants.ts` importa
 *     `resolveAgentDir` + `DISCUSSION_ARENA_USER_COORDINATION_RELATIVE_PATH`
 *     per aggiungere il terzo livello di precedenza (project > user > null).
 *   - S03 (init command): riusa `resolveAgentDir` per localizzare la
 *     home dell'agent e creare il file di coordination user-level.
 *
 * Vincoli di implementazione:
 *   - Zero dipendenze npm runtime: solo `node:os` e `node:path` (D004).
 *   - Foglia dell'albero delle dipendenze: NON importa da `participants.ts`
 *     né da `scripts/copy-template.mjs`. È participants.ts e copy-template.mjs
 *     che lo importano (in copy-template.mjs il riuso è intenzionalmente
 *     omesso — la copia locale resta il single source per il CLI).
 *   - Non allarga `tsconfig.json` `include`: `src/agent-dir.ts` è già
 *     coperto dal glob esistente `"src/*.ts"`.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Risolve l'agent dir canonico.
 *
 * Semantica (identica a `scripts/copy-template.mjs`):
 *   - Se `env.GSD_AGENT_DIR` è una stringa non vuota, ritorna verbatim
 *     (override esplicito).
 *   - Altrimenti ritorna `<homedir>/.gsd/agent` (default D137).
 *
 * @param env - ambiente da leggere; default `process.env`. Parametrizzato
 *              per consentire ai test di pilotare il fallback senza
 *              mutare lo stato globale.
 * @returns percorso assoluto dell'agent dir.
 */
export function resolveAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	const raw = env.GSD_AGENT_DIR;
	if (typeof raw === "string" && raw.length > 0) {
		return raw;
	}
	return join(homedir(), ".gsd", "agent");
}

/**
 * Path relativo (sotto `<agentDir>`) del coordination file user-level.
 *
 * Coerente con `destPathFor(agentDir).file` di `scripts/copy-template.mjs`
 * (riga 97-101) ma in forma RELATIVA — il caller fornisce l'agentDir e
 * compone il path assoluto con `path.join`. Questa separazione:
 *   - mantiene la costante riusabile sia per S02 (coordination lookup) sia
 *     per S03 (init command) senza legare il modulo al filesystem state;
 *   - consente di cambiare l'agentDir senza toccare la soglia del tier
 *     user (la "gerarchia" user-level è sempre `<agentDir>/discussion-arena/...`).
 *
 * Snapshot canonico: `"discussion-arena/discussion-arena-coordination.md"`.
 */
export const DISCUSSION_ARENA_USER_COORDINATION_RELATIVE_PATH =
	"discussion-arena/discussion-arena-coordination.md";
