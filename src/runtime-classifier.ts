/**
 * src/runtime-classifier.ts — Classificazione runtime deterministica (Tier F/A/D).
 *
 * Modulo PURO (D085, R014): nessun side-effect, nessun I/O, nessuna scrittura
 * su stderr, nessuna chiamata a `recordDegraded` / `emitStructuredLog`. Il
 * side-effect Tier D (stderr one-shot + `recordDegraded` per reason) vive
 * solo nel caller (`index.ts:activate()`); questo modulo si limita a
 * RITORNARE `{ tier, capabilities, reasons }` così è testabile in isolamento
 * senza stub di `ExtensionAPI` reale e senza osservatori stderr.
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
 *
 * Vincoli:
 * - D082: fingerprint via `process.env.GSD_VERSION` (NON `process.versions.gsd-pi`,
 *   che è inesistente). Rispettato.
 * - D084: `phase_change` NON è un evento registrabile su `ExtensionAPI.on`
 *   (verificato in vendor/pi-coding-agent/dist/core/extensions/extension-upstream-types.d.ts:821-871
 *   — non compare). Non viene mai probeato. Stesso per `getCapabilities()`.
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
 */
export type RuntimeTier = "F" | "A" | "D";

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
	| "no_unit_start";

/** Parsed semver `{ major, minor, patch: number | null }` (patch assente se `MAJOR.MINOR`). */
export interface ParsedSemver {
	major: number;
	minor: number;
	patch: number | null;
}

/** Risultato della classificazione: tier deterministico + capabilities Set + reason codes. */
export interface ClassifyRuntimeResult {
	tier: RuntimeTier;
	capabilities: ReadonlySet<CapabilityName>;
	reasons: readonly TierReasonCode[];
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
 * (extension-upstream-types.d.ts:821-871): ogni evento ha il suo tipo di
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
	if (parsedSemver === null) {
		tier = "D";
		reasons.push("no_GSD_VERSION");
	} else if (probes.before_agent_start && probes.adjust_tool_set) {
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

	return {
		tier,
		capabilities: caps,
		reasons: Object.freeze(reasons) as readonly TierReasonCode[],
	};
}