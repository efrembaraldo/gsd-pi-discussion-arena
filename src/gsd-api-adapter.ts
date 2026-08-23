/**
 * src/gsd-api-adapter.ts — Adapter per `GSDExtensionAPI.getPhase()` di gsd-pi
 * (audit #5 — gsd-pi HEAD 0216d746).
 *
 * Adottato in S01 (M014) come fonte canonica della phase runtime. Il modulo
 * isola il check "questo api è una GSDExtensionAPI?" dietro un type guard
 * strutturale, così i call site (hooks-unit-aware.ts in T02) possono
 * disambiguare tra stub plain `ExtensionAPI` (test/fixtures/pi-coding-agent-stub)
 * e api reali con `getPhase()` iniettato dal loader di gsd-pi.
 *
 * Scope del modulo:
 *   - `GSDExtensionAPI` interface locale (estende `ExtensionAPI` con
 *     `getPhase(): Phase | null`). Dichiarata LOCALMENTE perché il peer dep
 *     opzionale @gsd/pi-coding-agent (vendor/pi-coding-agent/dist/index.d.ts)
 *     NON espone GSDExtensionAPI — verif. su `rg GSDExtensionAPI
 *     vendor/pi-coding-agent/dist/index.d.ts` non produce match.
 *   - `isGSDExtensionAPI(api)` — type guard strutturale `typeof getPhase
 *     === "function"`. Evita falsi positivi su stub plain ExtensionAPI.
 *   - `getRuntimePhase(api)` — wrapper async. Restituisce `Phase | null`.
 *     Se !isGSDExtensionAPI → null (no throw). Se `getPhase()` lancia
 *     → `emitStructuredLog("warn", "guard.skipped", { adapter, reason:
 *     "getPhase_threw", error })` + return null (D019 fail-loud ma non
 *     throw).
 *   - `getRuntimePhaseSync(api)` — variante sync riusata dal cablaggio in
 *     hooks-unit-aware.ts:isActive() (T02). Stessa semantica del async
 *     ma sincrona: try { return api.getPhase(); } catch → emit log + null.
 *
 * Decisione di design: Tier G NON vive in questo modulo. La etichetta
 * "G" è puramente convenzionale e viene assegnata nel CABLAGGIO (T02) in
 * base al risultato di `isGSDExtensionAPI` + `getRuntimePhase()`. Il
 * classifier (src/runtime-classifier.ts) resta PURO (D085) — vede solo
 * `ExtensionAPI` plain, niente GSDExtensionAPI.
 *
 * Failure modes (D019):
 *   - `api === null/undefined` → isGSDExtensionAPI ritorna false (typeof
 *     null/undefined non è "function").
 *   - `api.getPhase` non è una funzione → type guard false.
 *   - `api.getPhase()` lancia → log structured warn + return null. Mai
 *     propagazione al call site.
 *   - `api.getPhase()` ritorna un valore non-Phase (es. undefined per
 *     stub malformati) → ritorna null (assegnazione a `Phase | null`
 *     accetta solo Phase; in runtime il cast `as Phase | null` gestisce
 *     esplicitamente).
 *
 * Performance: nessuna allocazione nel hot path. I type guard sono O(1).
 * `emitStructuredLog` è chiamato solo nel caso failure (throw) — path
 * eccezionale, non hot path.
 */

import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import type { Phase } from "./phase-mapping.js";
import { emitStructuredLog } from "./metrics.js";

/** Identificativo del modulo, incluso nei log structured per debug. */
const ADAPTER_ID = "gsd-api-adapter";

/**
 * Interfaccia locale che estende `ExtensionAPI` con `getPhase()`. Dichiarata
 * qui perché il peer dep opzionale `@gsd/pi-coding-agent` non espone
 * `GSDExtensionAPI` nei suoi .d.ts. Quando gsd-pi aggiungerà la interfaccia
 * canonica al suo public type surface, potremo rimuovere la dichiarazione
 * locale e re-exportare (D085 zero-breakage sui consumer).
 *
 * Contratto di `getPhase()`: ritorna la phase corrente del ciclo GSD
 * (`"discussing"` | `"researching"` | ... | `"blocked"`) oppure `null` se
 * il runtime non è in una phase nota (es. pre-attivazione, idle).
 */
export interface GSDExtensionAPI extends ExtensionAPI {
	getPhase(): Phase | null;
}

/**
 * Type guard strutturale: ritorna true SOLO se `api.getPhase` è una funzione.
 * Narrowing: dopo `if (isGSDExtensionAPI(api)) { ... }`, TS sa che
 * `api.getPhase()` esiste e ritorna `Phase | null`.
 *
 * Robusto contro:
 *   - `api === null/undefined` → `typeof null === "object"`, l'accesso a
 *     `.getPhase` lancia ma il cast `as Partial<...>` non protegge — il
 *     test difende con `api?.getPhase` (optional chaining) e il typeof
 *     check interno cattura anche `undefined`.
 *   - `api` plain ExtensionAPI senza getPhase → typeof ritorna
 *     `"undefined"` → false.
 *   - Stub con `getPhase: "not-a-function"` → typeof `"string"` → false.
 */
export function isGSDExtensionAPI(api: ExtensionAPI): api is GSDExtensionAPI {
	if (api === null || api === undefined) return false;
	return typeof (api as Partial<GSDExtensionAPI>).getPhase === "function";
}

/**
 * Wrapper async per ottenere la phase runtime corrente. Ritorna `Phase | null`:
 *   - Se `api` non è una `GSDExtensionAPI` (stub plain) → null.
 *   - Se `api.getPhase()` lancia un'eccezione → `emitStructuredLog("warn",
 *     "guard.skipped", { adapter, reason: "getPhase_threw", error })` +
 *     return null. NON propaga al call site (D019 fail-loud ma non throw).
 *   - Se `api.getPhase()` ritorna `null` → null (la fase non è in un
 *     momento noto del ciclo).
 *   - Altrimenti → la `Phase` ritornata.
 *
 * La firma è async anche se `getPhase` è sync, per consentire al call site
 * di usare `await` uniforme in tutti i rami del conditional forcing (T02).
 * Non c'è overhead reale: il `async` su una funzione che non ha await interni
 * si risolve in un microtask.
 */
export async function getRuntimePhase(api: ExtensionAPI): Promise<Phase | null> {
	if (!isGSDExtensionAPI(api)) return null;
	try {
		const result = api.getPhase();
		return result ?? null;
	} catch (error) {
		emitStructuredLog("warn", "guard.skipped", {
			adapter: ADAPTER_ID,
			reason: "getPhase_threw",
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

/**
 * Variante sincrona di `getRuntimePhase(api)`. Stessa semantica ma senza
 * `async`/`await`. Usata dal cablaggio in hooks-unit-aware.ts:isActive() (T02)
 * dove il flusso di controllo è già sincrono e non serve una Promise.
 *
 * Failure mode analogo: se `getPhase()` lancia, emette log structured e
 * ritorna null. Non propaga mai al call site.
 */
export function getRuntimePhaseSync(api: ExtensionAPI): Phase | null {
	if (!isGSDExtensionAPI(api)) return null;
	try {
		const result = api.getPhase();
		return result ?? null;
	} catch (error) {
		emitStructuredLog("warn", "guard.skipped", {
			adapter: ADAPTER_ID,
			reason: "getPhase_threw",
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}
