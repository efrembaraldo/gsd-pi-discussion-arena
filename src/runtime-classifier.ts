/**
 * src/runtime-classifier.ts — Classificazione runtime deterministica (Tier F/A/D/G).
 *
 * Modulo PURO (D085, R014): nessun side-effect, nessun I/O, nessuna scrittura
 * su stderr, nessuna chiamata a `recordDegraded` / `emitStructuredLog`. Il
 * side-effect Tier D (stderr one-shot + `recordDegraded` per reason) vive
 * solo nel caller (`index.ts:activate()`); questo modulo si limita a
 * RITORNARE `{ tier, capabilities, reasons }` così è testabile in isolamento
 * senza stub di `ExtensionAPI` reale e senza osservatori stderr.
 *
 * Tier G (M014/S01): estensione backward-compatible aggiunta per classificare
 * il caso "GSDExtensionAPI presente ma `getPhase()` ritorna `null`". Il
 * classifier NON vede `GSDExtensionAPI` direttamente (continua a importare
 * solo `ExtensionAPI`); Tier G viene assegnato a livello di cablaggio nel
 * caller (hooks-unit-aware.ts in T02). Il reason code `no_get_phase` è
 * l'unico nuovo valore di `TierReasonCode` — backward-compatible con tutti
 * i consumer esistenti (no breaking change sui Tier F/A/D).
 *
 * Algoritmo (sincrono, sub-millisecondo):
 *  1. parsedSemver = parseSemver(process.env.GSD_VERSION) — fonte canonica
 *     impostata da gsd-pi/src/loader.ts:141-142. Tollerante a `v` prefix,
 *     suffix prerelease/build (`1.15.0-dev.69075e6e`, `v1.15.0`, `1.15`).
 *  2. Probe `api.on(event, noop)` su 4 hook noti
 *     (`before_agent_start`, `adjust_tool_set`, `unit_start`, `tool_call`).
 *     I probe usano un cast narrow di `api.on` perché la firma reale è un
 *     overload literal-typed per evento; il try/catch protegge da stub
 *     malformati (safe probe, mai throw).
 *  3. capabilities = ReadonlySet degli hook accettati dal runtime (i probe
 *     accettati). Il Set è congelato per impedire mutazioni successive.
 *  4. Tier:
 *     - F: parsedSemver valido + before_agent_start + adjust_tool_set
 *       + unit_start (fingerprint versione + 3 hook piatati).
 *     - A: parsedSemver valido + before_agent_start + adjust_tool_set
 *       (manca solo unit_start — verificato: `emitUnitStart` non ha call-site
 *       in gsd-pi/dist, vedi M010-RESEARCH.md §3).
 *     - D: tutto il resto (parsedSemver mancante, o hook critici mancanti).
 *  5. reasons: lista dei codici diagnostici per cui NON siamo in F. Per Tier
 *     F: `[]`. Per Tier A: solo `no_unit_start`. Per Tier D: ogni hook
 *     mancante + `no_GSD_VERSION` se il fingerprint non parsa.
 *  6. Feature detection semver (M019/S03, I4): a prescindere dal tier, se
 *     `parsedSemver !== null` e la versione e' < 1.21.0 (soglia canonica
 *     HOST_FEATURE_VERSION) vengono appesi alla fine di `reasons` i 3
 *     feature codes nell'ordine ESATTO: `no_dispatch_context`,
 *     `no_delta_toolset`, `no_phase_change_event`. Ordine finale reasons:
 *     hook reasons (`no_before_agent_start`, `no_adjust_tool_set`,
 *     `no_unit_start`) POI i 3 feature codes. Nel branch short-circuit
 *     `parsedSemver === null` NON vengono pushati feature codes (solo
 *     `no_GSD_VERSION`): senza semver non c'e' detection.
 *
 * Detection semver-only (MEM374/D157): la capability host v1.21.0 e'
 * decisa ESCLUSIVAMENTE dal fingerprint `GSD_VERSION`. Non esistono probe
 * onesti: `api.on` e' un sink Map che accetta qualunque evento senza
 * lanciare, quindi un probe non discrimina. `phase_change` NON viene mai
 * probeato (R076/anti-feature). Semantica soglia:
 *  - `1.21.0` -> feature host (true); `1.20.1`/`1.20.9` -> false.
 *  - major > 1 -> true (qualunque minor/patch).
 *  - prerelease trattato come release: `1.21.0-dev.x` -> true (il parser
 *    scarta il suffix per design D157).
 *  - patch assente (`1.21`) trattato come 0 -> true (coerenza con la
 *    tolleranza di `parseSemver`).
 *
 * Vincoli:
 * - D082: fingerprint via `process.env.GSD_VERSION` (NON `process.versions.gsd-pi`,
 *   che è inesistente). Rispettato.
 * - D084 (storico): prima di v1.21.0 `phase_change` NON era un evento
 *   registrabile su `ExtensionAPI.on` (M010 lo rimosse come inesistente).
 *   Da v1.21.0 (commit upstream `c7d1ec1d`, issue #1999) è registrabile
 *   (vendor/pi-coding-agent/dist/core/extensions/extension-upstream-types.d.ts:885)
 *   ed è consumato dal listener `phase_change` di S05 in hooks-unit-aware.ts,
 *   che registra incondizionatamente — MAI probeato: la detection resta
 *   semver-only (R076) e la union chiusa `PROBE_HOOKS` non lo enumera.
 *   `getCapabilities()` resta invece inesistente su `ExtensionAPI` e mai
 *   probeato. Dichiarazione manifest presidiata dalla guard capovolta in
 *   tests/extension-manifest.test.ts.
 * - `parseSemver` ritorna `{ major, minor, patch: number | null } | null`
 *   per tollerare `MAJOR.MINOR` senza patch (raro ma non errore).
 */

import type { ExtensionAPI, ExtensionHandler } from "@gsd/pi-coding-agent";

/**
 * Tier deterministico del runtime gsd-pi (D081).
 * - "F" (Full): tutti i hook critici accettati E fingerprint versione valido.
 * - "A" (Available): i 2 hook sincrone + fingerprint validi (manca solo
 *   `unit_start`, evento dichiarato ma non emesso a runtime in gsd-pi
 *   corrente — vedi M010-RESEARCH.md).
 * - "D" (Degraded): capability insufficienti o fingerprint mancante. Il
 *   caller emette stderr one-shot + `recordDegraded` per ogni reason.
 * - "G" (gsd-pi-aware, availability-only, M014/S01): `GSDExtensionAPI`
 *   rilevato via type guard strutturale ma `getPhase()` ritorna `null`
 *   (runtime in idle / pre-attivazione / fase fuori dal ciclo). Il
 *   classifier NON assegna Tier G direttamente — è un'etichetta che vive
 *   nel cablaggio (hooks-unit-aware.ts:isActive in T02) basata sul
 *   risultato di `isGSDExtensionAPI(api) + getRuntimePhase(api)`. Il
 *   reason code `no_get_phase` viene però definito qui perché la union
 *   `TierReasonCode` è consumata da caller che trattano anche Tier G.
 */
export type RuntimeTier = "F" | "A" | "D" | "G";

/**
 * Hook di `ExtensionAPI.on(...)` conosciuti e probeati dal classifier.
 * Enumerazione CHIUSA: un eventi non in questa union non viene probeato
 * (Tier D fail-safe per eventi runtime sconosciuti — vedi R-M010-2).
 */
export type CapabilityName =
	| "before_agent_start"
	| "adjust_tool_set"
	| "unit_start"
	| "tool_call";

/** Codici diagnostici di capability mancante / fingerprint mancante (D085). */
export type TierReasonCode =
	| "no_GSD_VERSION"
	| "no_before_agent_start"
	| "no_adjust_tool_set"
	| "no_unit_start"
	/** M014/S01: GSDExtensionAPI rilevato ma `getPhase()` ritorna null (Tier G). */
	| "no_get_phase"
	/** M019/S03: host < 1.21.0 — dispatch context (#1997) assente. */
	| "no_dispatch_context"
	/** M019/S03: host < 1.21.0 — delta toolset (#1998) assente. */
	| "no_delta_toolset"
	/** M019/S03: host < 1.21.0 — evento `phase_change` (#1999) assente. */
	| "no_phase_change_event";

/** Parsed semver `{ major, minor, patch: number | null }` (patch assente se `MAJOR.MINOR`). */
export interface ParsedSemver {
	major: number;
	minor: number;
	patch: number | null;
}

/**
 * Feature host v1.21.0 (M019/S03, I4): i tre flag sono tutti lo stesso
 * booleano semver (`isFeatureHost`); esistono distinti per comodita' dei
 * consumer (R069) che tipizzano per-capability.
 */
export interface HostFeatures {
	readonly dispatchContext: boolean;
	readonly deltaToolSet: boolean;
	readonly phaseChangeEvent: boolean;
}

/**
 * Soglia canonica della feature detection (unica fonte per S04/S05):
 * `>= 1.21.0` -> feature host.
 */
export const HOST_FEATURE_VERSION: Readonly<ParsedSemver> = Object.freeze({
	major: 1,
	minor: 21,
	patch: 0,
});

/**
 * Feature host check puro: true se `parsed` esiste ed e' >=
 * HOST_FEATURE_VERSION in confronto lessicografico (major, minor,
 * patch ?? 0). `patch: null` (`1.21`) e' trattato come 0. Prerelease e'
 * trattato come release perche' `parseSemver` scarta il suffix.
 */
export function isFeatureHost(parsed: ParsedSemver | null): boolean {
	if (parsed === null) return false;
	const pMajor = parsed.major;
	const pMinor = parsed.minor;
	const pPatch = parsed.patch ?? 0;
	const t = HOST_FEATURE_VERSION;
	if (pMajor !== t.major) return pMajor > t.major;
	if (pMinor !== t.minor) return pMinor > t.minor;
	return pPatch >= (t.patch ?? 0);
}

/**
 * Compute congelato dei flag feature host: i tre flag valgono tutti
 * `isFeatureHost(parsed)` (un unico booleano semver).
 */
export function computeHostFeatures(
	parsed: ParsedSemver | null,
): HostFeatures {
	return Object.freeze({
		dispatchContext: isFeatureHost(parsed),
		deltaToolSet: isFeatureHost(parsed),
		phaseChangeEvent: isFeatureHost(parsed),
	});
}

/**
 * Risultato della classificazione: tier deterministico + capabilities Set +
 * reason codes + feature host flags (M019/S03, campo additivo D084).
 */
export interface ClassifyRuntimeResult {
	tier: RuntimeTier;
	capabilities: ReadonlySet<CapabilityName>;
	reasons: readonly TierReasonCode[];
	hostFeatures: HostFeatures;
}

/** Lista congelata dei 4 hook probeati (ordine di registrazione deterministico). */
const PROBE_HOOKS: readonly CapabilityName[] = Object.freeze([
	"before_agent_start",
	"adjust_tool_set",
	"unit_start",
	"tool_call",
] as const);

/**
 * Parsing semver tollerante di `process.env.GSD_VERSION`. Tollerato:
 *  - `1.15.0-dev.69075e6e` (formato gsd-pi reale, prerelease + build hash)
 *  - `1.15.0` (semver puro)
 *  - `v1.15.0` (con `v` prefix)
 *  - `1.15` (senza patch, patch=null)
 * NON tollerato: `1`, `abc`, stringa vuota — ritorna `null`.
 * Non normalizza `MAJOR`/`MINOR` a 0: i numeri sono quelli del fingerprint.
 *
 * La regex è ancorata `^...$` (no substring match) e `(?:\.(\d+))?` rende la
 * patch opzionale. Il suffix `(?:[-+].*)?` cattura qualsiasi prerelease/build
 * suffix presente in `gsd-pi/dev.<hash>` senza tentare di parsarlo.
 */
export function parseSemver(raw: string | undefined): ParsedSemver | null {
	if (typeof raw !== "string" || raw.length === 0) return null;
	// Regex letterale, NON globale: serve solo `match` con anchor.
	// `v?` prefix opzionale; major+minor obbligatori; patch optional con
	// `[.+].*` suffix (prerelease/build hash) opzionale.
	const match = raw.match(/^v?(\d+)\.(\d+)(?:\.(\d+))?(?:[-+].*)?$/);
	if (!match) return null;
	const major = Number(match[1]);
	const minor = Number(match[2]);
	const patchRaw = match[3];
	const patch = patchRaw === undefined ? null : Number(patchRaw);
	if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;
	if (patch !== null && !Number.isFinite(patch)) return null;
	return { major, minor, patch };
}

/**
 * Probe narrow di `api.on(event, noop)` per un hook. La firma reale di
 * `ExtensionAPI.on(...)` è un overload literal-typed per evento
 * (extension-upstream-types.d.ts:839-890): ogni evento ha il suo tipo di
 * handler specifico. Per aggirare la strict typing (TS non accetta un
 * handler generico su un literal specifico) faccio un cast narrow a
 * `(e: string, h: unknown) => unknown`. Il try/catch protegge da stub
 * malformati: un throw del probe degrada a `false` senza propagare.
 *
 * Non probe `getCapabilities()` (INESISTENTE su ExtensionAPI — verificato):
 * il guard `typeof api.on === "function"` è ridondante in produzione
 * (l'interfaccia garantisce `on`) ma difende i test che passano uno stub
 * minimale con solo `on`.
 */
function safeProbe(api: ExtensionAPI, event: CapabilityName): boolean {
	if (typeof api?.on !== "function") return false;
	const onAny = api.on as unknown as (
		e: CapabilityName,
		h: ExtensionHandler<unknown, unknown>,
	) => unknown;
	try {
		onAny(event, (() => undefined) as unknown as ExtensionHandler<unknown, unknown>);
		return true;
	} catch {
		return false;
	}
}

/**
 * Classificazione runtime deterministica. Pura, sincrona, ~sub-ms.
 * Mai throw: ogni probe è in try/catch; `parseSemver` non lancia.
 *
 * Output immutabile: `capabilities` è un `ReadonlySet`, `reasons` è
 * `readonly TierReasonCode[]`. Il caller può passare il result in
 * `ResolveTriggerInput` (T03) senza dover copiare.
 */
export function classifyRuntime(api: ExtensionAPI): ClassifyRuntimeResult {
	const parsedSemver = parseSemver(process.env.GSD_VERSION);

	// Probe sequenziale dei 4 hook (ordine deterministico da PROBE_HOOKS):
	// le capabilities sono tutte gli hook accettati, ma il tier usa SOLO
	// i primi 3 (before_agent_start, adjust_tool_set, unit_start).
	const probes: Record<CapabilityName, boolean> = {
		before_agent_start: safeProbe(api, "before_agent_start"),
		adjust_tool_set: safeProbe(api, "adjust_tool_set"),
		unit_start: safeProbe(api, "unit_start"),
		tool_call: safeProbe(api, "tool_call"),
	};

	// Capabilities Set: solo hook accettati. Congelato per ReadonlySet.
	const caps = new Set<CapabilityName>(
		PROBE_HOOKS.filter((hook) => probes[hook]),
	);
	Object.freeze(caps);

	const reasons: TierReasonCode[] = [];

	// Tier decision: due assi (D081). Asse 1: fingerprint versione. Asse 2:
	// probe dei 3 hook critici. Se entrambi soddisfatti → F o A a seconda di
	// unit_start. Altrimenti D con reasons cumulative.
	let tier: RuntimeTier;
	let hostFeatures: HostFeatures;
	if (parsedSemver === null) {
		tier = "D";
		// Short-circuit: senza semver nessun feature code (solo no_GSD_VERSION).
		hostFeatures = computeHostFeatures(null);
		reasons.push("no_GSD_VERSION");
	} else {
		if (probes.before_agent_start && probes.adjust_tool_set) {
			if (probes.unit_start) {
				tier = "F";
			} else {
				tier = "A";
				reasons.push("no_unit_start");
			}
		} else {
			tier = "D";
			if (!probes.before_agent_start) reasons.push("no_before_agent_start");
			if (!probes.adjust_tool_set) reasons.push("no_adjust_tool_set");
			if (!probes.unit_start) reasons.push("no_unit_start");
		}
		hostFeatures = computeHostFeatures(parsedSemver);
		// Feature codes (M019/S03): appesi DOPO gli hook reasons, in ordine
		// ESATTO (contract deep-strict dei test S03/T02-T03). Push SOLO in
		// questo branch (semver valido): nel short-circuit `no_GSD_VERSION`
		// resta l'unico reason.
		if (!hostFeatures.dispatchContext) {
			reasons.push("no_dispatch_context");
			reasons.push("no_delta_toolset");
			reasons.push("no_phase_change_event");
		}
	}

	return {
		tier,
		capabilities: caps,
		reasons: Object.freeze(reasons) as readonly TierReasonCode[],
		hostFeatures,
	};
}