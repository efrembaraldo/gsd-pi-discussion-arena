/**
 * src/runtime-profiles.ts — Tabella dichiarativa dei 6 profili runtime × 6 fasi attive.
 *
 * Modulo PURO (D085): nessun side-effect, nessun I/O, nessuna lettura di
 * `process.env` se non via il solo `classifyRuntime` importato. La tabella è
 * il single source of truth per la matrice 6×6 che il job CI `e2e-real`
 * (S02/T03) e lo script `npm run e2e-real` (S02/T02) iterano per esercitare
 * il binario `gsd` reale.
 *
 * Origine della decisione:
 *   - D108 / D110: i 6 profili NON sono 6 nuovi tier. Sono 6 combinazioni
 *     `capabilities × GSD_VERSION` (fingerprint) che mappano
 *     deterministicamente a F/A/D del `runtime-classifier`. La matrice 6×6
 *     nasce quindi da 6 fasi attive × 6 profili = 36 celle, ciascuna con
 *     tier atteso e reason codes attesi.
 *
 * Algoritmo della tabella (sincrono, sub-millisecondo):
 *   1. `RUNTIME_PROFILES` è un `Readonly<Record>` di 6 voci. Ogni voce
 *      dichiara: `name`, `description`, `gsdVersion` (`null` = env
 *      unset per simulare assenza del fingerprint), `capabilities`
 *      (ReadonlySet degli hook iniettabili), `expectedTier` e
 *      `expectedReasons` (la firma attesa dal classifier).
 *   2. `ACTIVE_PHASES` è derivato da `PHASE_TO_UNIT_TYPES` filtrando le
 *      fasi il cui insieme non è vuoto. La derivazione evita di
 *      duplicare la lista in due posti.
 *   3. `SCENARIO_MATRIX` è la lista flat di 36 celle: per ogni profilo,
 *      per ogni fase attiva, una cella `{ profile, phase, expectedTier,
 *      expectedReasons }`. Il `expectedTier` e gli `expectedReasons` sono
 *      copiati dal profilo (la fase NON altera la classificazione: il
 *      classifier è funzione pura di capabilities + GSD_VERSION).
 *   4. `getScenario(profile, phase)` è un accessor lineare per le 36
 *      celle (O(N=36), accettabile per la dimensione del dataset).
 *
 * Per il T04 (smoke test integration) e i test unitari in `runtime-profiles.test.ts`,
 * `buildApiStubFromProfile` produce un mock api compatibile con il
 * `ExtensionAPI` reale: `api.on(event, noop)` ritorna `undefined` se
 * `event ∈ profile.capabilities`, lancia sincronamente altrimenti (mimica
 * del runtime che rifiuta la subscription su eventi non supportati).
 * Combinato con `withGSDVersion`, consente di asserire che la tabella
 * dichiarata sia coerente con il `classifyRuntime` di
 * `src/runtime-classifier.ts`.
 *
 * Vincoli / contratti:
 *   - Il tier dipende SOLO dal profilo (capabilities + GSD_VERSION), non
 *     dalla fase. La matrice conserva la fase per identificare la cella
 *     ma `expectedTier`/`expectedReasons` sono identici per tutte le 6
 *     celle dello stesso profilo.
 *   - L'ordine di `expectedReasons` rispetta l'ordine di push del
 *     `classifyRuntime` (`no_before_agent_start`, `no_adjust_tool_set`,
 *     `no_unit_start`, `no_GSD_VERSION`). I test asseriscono uguaglianza
 *     deep-strict.
 *   - Tutti i Set e Array sono congelati con `Object.freeze` per
 *     impedire mutazioni successive (D085, ReadonlySet / readonly array).
 */

import type {
	CapabilityName,
	RuntimeTier,
	TierReasonCode,
} from "./runtime-classifier.js";
import { PHASE_TO_UNIT_TYPES, type Phase } from "./phase-mapping.js";
import type { ExtensionAPI } from "@gsd/pi-coding-agent";

/**
 * I 6 profili runtime dichiarati (D108/D110). Ogni nome è una combinazione
 * capability + fingerprint che mappa a F/A/D, NON un nuovo tier.
 *
 *   - "full"                    → tutti i 4 hook + GSD_VERSION valido → F.
 *   - "no_unit_start"           → manca solo `unit_start` (non emesso in
 *                                  gsd-pi corrente, vedi M010-RESEARCH.md §3)
 *                                  + GSD_VERSION valido → A.
 *   - "no_before_agent_start"   → manca `before_agent_start` + GSD_VERSION
 *                                  valido → D (motivo `no_before_agent_start`).
 *   - "no_adjust_tool_set"      → manca `adjust_tool_set` + GSD_VERSION
 *                                  valido → D (motivo `no_adjust_tool_set`).
 *   - "no_GSD_VERSION"          → tutti i 4 hook ma fingerprint assente →
 *                                  D (motivo `no_GSD_VERSION`).
 *   - "partial"                 → hook minimi (`before_agent_start` +
 *                                  `tool_call`) + GSD_VERSION valido →
 *                                  D (motivi `no_adjust_tool_set`,
 *                                  `no_unit_start`).
 */
export type RuntimeProfileName =
	| "full"
	| "no_unit_start"
	| "no_before_agent_start"
	| "no_adjust_tool_set"
	| "no_GSD_VERSION"
	| "partial";

/**
 * Profilo runtime dichiarato: capability flags iniettabili + fingerprint.
 * Il `gsdVersion=null` simula assenza di `process.env.GSD_VERSION`
 * (corrispondente al pattern del classifier: `parsedSemver === null` →
 * Tier D con motivo `no_GSD_VERSION`).
 */
export interface RuntimeProfile {
	readonly name: RuntimeProfileName;
	readonly description: string;
	/** Valore di `process.env.GSD_VERSION` da impostare. `null` = unset. */
	readonly gsdVersion: string | null;
	/** Capability iniettabili: gli hook che `safeProbe` deve marcare come `true`. */
	readonly capabilities: ReadonlySet<CapabilityName>;
	/** Tier atteso dalla classificazione con questo profilo (D081). */
	readonly expectedTier: RuntimeTier;
	/** Reason codes attesi (ordine di push dal `classifyRuntime`). */
	readonly expectedReasons: readonly TierReasonCode[];
}

/** Costruisce un `ReadonlySet<CapabilityName>` congelato da lista literal. */
function freezeCaps(
	items: ReadonlyArray<CapabilityName>,
): ReadonlySet<CapabilityName> {
	return Object.freeze(
		new Set<CapabilityName>(items),
	) as ReadonlySet<CapabilityName>;
}

/** Costruisce un `readonly TierReasonCode[]` congelato da lista literal. */
function freezeReasons(
	items: ReadonlyArray<TierReasonCode>,
): readonly TierReasonCode[] {
	return Object.freeze(items.slice()) as readonly TierReasonCode[];
}

// ════════════════════════════════════════════════════════════════════════════
// I 6 profili dichiarati
// ════════════════════════════════════════════════════════════════════════════

const FULL: RuntimeProfile = Object.freeze({
	name: "full",
	description:
		"Tutti gli hook supportati + GSD_VERSION valido → Tier F (Full runtime).",
	gsdVersion: "1.15.0",
	capabilities: freezeCaps([
		"before_agent_start",
		"adjust_tool_set",
		"unit_start",
		"tool_call",
	]),
	expectedTier: "F",
	expectedReasons: freezeReasons([]),
});

const NO_UNIT_START: RuntimeProfile = Object.freeze({
	name: "no_unit_start",
	description:
		"Manca solo `unit_start` (evento non emesso in gsd-pi corrente) + GSD_VERSION valido → Tier A.",
	gsdVersion: "1.15.0",
	capabilities: freezeCaps([
		"before_agent_start",
		"adjust_tool_set",
		"tool_call",
	]),
	expectedTier: "A",
	expectedReasons: freezeReasons(["no_unit_start"]),
});

const NO_BEFORE_AGENT_START: RuntimeProfile = Object.freeze({
	name: "no_before_agent_start",
	description:
		"Manca `before_agent_start` + GSD_VERSION valido → Tier D (no_before_agent_start).",
	gsdVersion: "1.15.0",
	capabilities: freezeCaps(["adjust_tool_set", "unit_start", "tool_call"]),
	expectedTier: "D",
	expectedReasons: freezeReasons(["no_before_agent_start"]),
});

const NO_ADJUST_TOOL_SET: RuntimeProfile = Object.freeze({
	name: "no_adjust_tool_set",
	description:
		"Manca `adjust_tool_set` + GSD_VERSION valido → Tier D (no_adjust_tool_set).",
	gsdVersion: "1.15.0",
	capabilities: freezeCaps(["before_agent_start", "unit_start", "tool_call"]),
	expectedTier: "D",
	expectedReasons: freezeReasons(["no_adjust_tool_set"]),
});

const NO_GSD_VERSION: RuntimeProfile = Object.freeze({
	name: "no_GSD_VERSION",
	description:
		"Tutti gli hook supportati ma fingerprint assente → Tier D (no_GSD_VERSION).",
	gsdVersion: null,
	capabilities: freezeCaps([
		"before_agent_start",
		"adjust_tool_set",
		"unit_start",
		"tool_call",
	]),
	expectedTier: "D",
	expectedReasons: freezeReasons(["no_GSD_VERSION"]),
});

const PARTIAL: RuntimeProfile = Object.freeze({
	name: "partial",
	description:
		"Hook minimi (before_agent_start + tool_call) + GSD_VERSION valido → Tier D (no_adjust_tool_set, no_unit_start).",
	gsdVersion: "1.15.0",
	capabilities: freezeCaps(["before_agent_start", "tool_call"]),
	expectedTier: "D",
	expectedReasons: freezeReasons(["no_adjust_tool_set", "no_unit_start"]),
});

/**
 * Tabella canonica dei 6 profili (D108/D110). Esposta come
 * `Readonly<Record<...>>` per lookup O(1) per nome. L'ordine di
 * dichiarazione (Object.keys) è stabile in V8 per le chiavi non-numeric:
 * `full`, `no_unit_start`, `no_before_agent_start`, `no_adjust_tool_set`,
 * `no_GSD_VERSION`, `partial`.
 */
export const RUNTIME_PROFILES: Readonly<
	Record<RuntimeProfileName, RuntimeProfile>
> = Object.freeze({
	full: FULL,
	no_unit_start: NO_UNIT_START,
	no_before_agent_start: NO_BEFORE_AGENT_START,
	no_adjust_tool_set: NO_ADJUST_TOOL_SET,
	no_GSD_VERSION: NO_GSD_VERSION,
	partial: PARTIAL,
});

/**
 * Le 6 fasi attive della discussion arena. Derivate da
 * `PHASE_TO_UNIT_TYPES` filtrando le fasi il cui insieme non è vuoto —
 * evita duplicazione della lista. Ordine: insertion order di
 * `Object.entries(PHASE_TO_UNIT_TYPES)` (coerente con l'ordine di
 * dichiarazione della union `Phase`).
 *
 * Risultato atteso (6 fasi):
 *   researching, refining, discussing, planning, executing, verifying.
 */
export const ACTIVE_PHASES: readonly Phase[] = Object.freeze(
	(Object.entries(PHASE_TO_UNIT_TYPES) as Array<[Phase, ReadonlySet<string>]>)
		.filter(([, set]) => set.size > 0)
		.map(([phase]) => phase),
);

/**
 * Scope e2e-real di una cella della matrice:
 *  - `e2e-real-testable`: scenario genuinamente riproducibile contro il
 *    binario `gsd` reale. Il runner `scripts/e2e-real.mjs` esercita la
 *    cella e confronta tier osservato vs atteso.
 *  - `fake-gsd-only`: scenario non riproducibile contro `gsd` reale per
 *    costruzione (tipicamente perché modella un hook capability
 *    mancante, e il binario reale ha sempre tutti gli hook). Il runner
 *    la skippa con motivazione; la copertura equivalente è demandata a
 *    `tests/e2e-auto-mode.test.ts` (stub di `ExtensionAPI` controllato).
 */
export type ScenarioScope = "e2e-real-testable" | "fake-gsd-only";

/**
 * Motivo dello skip per celle `fake-gsd-only`. Stringa costante
 * importata sia dal runner sia dalla doc (evita drift tra codice e
 * deliverable).
 */
export const FAKE_GSD_ONLY_SKIP_REASON =
	"not applicable to e2e-real, covered by tests/e2e-auto-mode.test.ts (fake-gsd) instead";

/**
 * Mappa profile → scope. Dichiarazione canonica, l'unica fonte di
 * verità per la partizione e2e-real-testable / fake-gsd-only.
 *  - `full`, `no_unit_start`: genuinamente riproducibili (env var e
 *    capability flags sono controllabili esternamente; il child `gsd
 *    auto` risponde silenziosamente in pipeable mode e il runner deduce
 *    F/A dall'assenza del marker degrado).
 *  - `no_GSD_VERSION`: Tier D determinabile dal solo env var (`null`
 *    ⇒ `parsedSemver === null`). DESIGN LIMITATION: in pipeable mode
 *    `gsd auto` richiede un init `.gsd/` completo (gsd.db + STATE.md
 *    + extension manifest) prima di raggiungere `activate()`; una
 *    `.gsd/runtime/` skeleton non basta. Setuppare uno state completo
 *    è fragile (symlink `.gsd` → state canonico, rischio di side
 *    effect). Quindi anche `no_GSD_VERSION` è fake-gsd-only.
 *  - `no_before_agent_start`, `no_adjust_tool_set`, `partial`: modellano
 *    hook capability mancanti — il binario `gsd` reale ha SEMPRE tutti
 *    gli hook, per costruzione; nessuna flag/env può fargli mancare
 *    `before_agent_start` / `adjust_tool_set` / `unit_start`.
 */
const SCENARIO_SCOPE: Readonly<Record<RuntimeProfileName, ScenarioScope>> =
	Object.freeze({
		full: "e2e-real-testable",
		no_unit_start: "e2e-real-testable",
		no_before_agent_start: "fake-gsd-only",
		no_adjust_tool_set: "fake-gsd-only",
		no_GSD_VERSION: "fake-gsd-only",
		partial: "fake-gsd-only",
	});

/**
 * Cella della matrice 6×6 (profile × phase). `expectedTier` e
 * `expectedReasons` sono derivati dal profilo (la fase NON altera la
 * classificazione del runtime), ma sono dichiarati per cella per
 * uniformità con il contratto "tutte con tier atteso (F/A/D) e reason
 * atteso". `scope`/`skipReason` discriminano le celle genuinamente
 * testabili contro `gsd` reale da quelle coperte altrove.
 */
export interface ScenarioCell {
	readonly profile: RuntimeProfileName;
	readonly phase: Phase;
	readonly expectedTier: RuntimeTier;
	readonly expectedReasons: readonly TierReasonCode[];
	readonly scope: ScenarioScope;
	readonly skipReason: string | null;
}

/**
 * Matrice 6×6 = 36 celle (S02). Lista flat per consentire l'iterazione
 * sequenziale del runner `scripts/e2e-real.mjs`. Il tier atteso dipende
 * solo dal profilo. Per le celle `fake-gsd-only` (18 delle 36) il
 * runner emette una SKIP line stderr con motivazione e le esclude dal
 * conteggio pass/fail.
 */
export const SCENARIO_MATRIX: readonly ScenarioCell[] = Object.freeze(
	(Object.keys(RUNTIME_PROFILES) as RuntimeProfileName[]).flatMap(
		(profileName) => {
			const profile = RUNTIME_PROFILES[profileName];
			const scope = SCENARIO_SCOPE[profileName];
			return ACTIVE_PHASES.map(
				(phase): ScenarioCell =>
					Object.freeze({
						profile: profileName,
						phase,
						expectedTier: profile.expectedTier,
						expectedReasons: profile.expectedReasons,
						scope,
						skipReason:
							scope === "fake-gsd-only" ? FAKE_GSD_ONLY_SKIP_REASON : null,
					}) as ScenarioCell,
			);
		},
	),
);

/**
 * Lookup accessor per una cella della matrice. Lineare (N=36) ma
 * semplice e sufficiente per il dataset. Ritorna `undefined` se la
 * combinazione non esiste (es. fase non attiva o profilo sconosciuto).
 */
export function getScenario(
	profile: RuntimeProfileName,
	phase: Phase,
): ScenarioCell | undefined {
	return SCENARIO_MATRIX.find(
		(c) => c.profile === profile && c.phase === phase,
	);
}

/**
 * Stub di `ExtensionAPI` sintetico che modella i 4 hook probeati dal
 * `classifyRuntime`. `api.on(event, noop)` ritorna `undefined` se
 * `event ∈ profile.capabilities`, lancia sincronamente altrimenti
 * (catturata dal try/catch interno di `safeProbe` che degrada il
 * probe a `false`).
 *
 * Usato dai test unit (`tests/unit/runtime-profiles.test.ts`) per
 * asserire che il `classifyRuntime(apiStub)` produca esattamente il
 * tier e i reason codes dichiarati nel profilo. NON usato dal runner
 * T02 (che esercita il binario `gsd` reale), ma disponibile per il
 * smoke test T04 come fallback deterministic.
 */
export function buildApiStubFromProfile(profile: RuntimeProfile): ExtensionAPI {
	// Gli eventi che `safeProbe` vuole marcare come `false`: tutti i 4
	// PROBE_HOOKS non presenti in `profile.capabilities`. Eventi fuori
	// dai PROBE_HOOKS non vengono mai probe-ati dal classifier quindi
	// non importa cosa faccia lo stub per loro.
	const PROBE_HOOKS: readonly CapabilityName[] = Object.freeze([
		"before_agent_start",
		"adjust_tool_set",
		"unit_start",
		"tool_call",
	] as const);
	const unsupported = new Set<CapabilityName>(
		PROBE_HOOKS.filter((hook) => !profile.capabilities.has(hook)),
	);

	return {
		on(event: string, _handler: unknown): unknown {
			if (unsupported.has(event as CapabilityName)) {
				throw new Error(
					`[runtime-profiles.test stub] api.on threw for unsupported "${event}"`,
				);
			}
			return undefined;
		},
	} as unknown as ExtensionAPI;
}

/**
 * Setta `process.env.GSD_VERSION` per la durata di `fn`, ripristinando
 * sempre il valore precedente (anche su throw). Se `value` è `null`,
 * l'env var viene rimossa (simula l'assenza del fingerprint).
 */
export async function withGSDVersion<T>(
	value: string | null,
	fn: () => T | Promise<T>,
): Promise<T> {
	const prev = process.env.GSD_VERSION;
	if (value === null) delete process.env.GSD_VERSION;
	else process.env.GSD_VERSION = value;
	try {
		return await fn();
	} finally {
		if (prev === undefined) delete process.env.GSD_VERSION;
		else process.env.GSD_VERSION = prev;
	}
}
