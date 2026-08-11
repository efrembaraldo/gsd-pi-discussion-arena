/**
 * helpers.ts — Helper puri della discussion arena (M003/S01).
 *
 * Estrazione additiva (D020) di 6 helper puri (7 funzioni contando
 * `appendEvent` + `readEvents`) con firme contrattuali dal CONTEXT/RESEARCH
 * M003. Nessuna nuova logica di business: ogni funzione è testabile in
 * isolamento (tests/helpers.test.ts) e viene consumata dai guardrail S02-S09.
 *
 * Contratti:
 * - `accumulateCost`  — estrae `usage.cost` (number | {total} | string) e lo
 *   somma a `current`, clamp a >= 0 (fix §4.1 del RESEARCH M003).
 * - `truncateOutput`  — tronca testo con marker di coda; `RangeError` se
 *   `limit < marker.length` (config invalida).
 * - `formatFailureMarker` — produce i 6 marker strutturati (5 kind di failure
 *   + skipped) ascii-safe, length-bounded, regex-matchabili.
 * - `resolveParticipantLimits` — merge 3 livelli (defaults < frontmatter <
 *   toolParams); valori invalidi -> fallback al default con warning su stderr.
 * - `shouldSkipParticipant` — consulta lo stato arena (morti) e decide se un
 *   partecipante deve essere saltato, con reason opzionale (FailureKind).
 * - `appendEvent` / `readEvents` — event log JSONL append-only, fail-safe per
 *   riga (skip silenzioso su righe malformate).
 *
 * Vincoli (D004): zero dipendenze npm runtime; solo `node:fs/promises`.
 */

import * as fs from "node:fs/promises";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Kind di failure/abbandono di un partecipante o di un turno. */
export type FailureKind =
  | "failed"
  | "skipped"
  | "timeout_round"
  | "timeout_event"
  | "budget_exhausted"
  | "output_truncated";

/** Modalità di terminazione al superamento di una soglia. */
export type TerminationMode = "soft" | "hard";

/** Limiti risolti di un partecipante (merge defaults < frontmatter < toolParams). */
export interface ResolvedLimits {
  roundTimeoutMs: number;
  eventTimeoutMs: number;
  outputLimitChars: number;
  costBudgetUsd: number;
  termination: TerminationMode;
}

/**
 * Input parziale dei limiti (toolParams / frontmatter). I campi sono `unknown`
 * perché i valori arrivano da TypeBox toolParams o YAML frontmatter e vanno
 * validati a runtime da `resolveParticipantLimits`.
 */
export interface ParticipantLimitsInput {
  roundTimeoutMs?: unknown;
  eventTimeoutMs?: unknown;
  outputLimitChars?: unknown;
  costBudgetUsd?: unknown;
  termination?: unknown;
}

/**
 * Stato arena minimale per S01 (D043): l'insieme dei partecipanti "morti"
 * (eliminati/abbandonati). S03 lo estenderà con costByParticipant, etc.
 * `morti` accetta `Map<id, FailureKind>` (reason specifica), `Set<id>` o
 * array di id (reason default `"failed"`). Tipi concreti `Map`/`Set` per
 * consentire il narrowing via `instanceof` nel consumer.
 */
export interface ArenaState {
  morti: Map<string, FailureKind> | Set<string> | readonly string[];
}

/** Evento dell'event log JSONL. `ts` ISO 8601, `type` discrimina il tipo. */
export interface ArenaEvent {
  ts: string;
  type: string;
  [key: string]: unknown;
}

/** Default dei limiti partecipante (dal CONTEXT M003). */
export const DEFAULT_PARTICIPANT_LIMITS: ResolvedLimits = {
  roundTimeoutMs: 300_000,
  eventTimeoutMs: 60_000,
  outputLimitChars: 16_000,
  costBudgetUsd: 1.0,
  termination: "soft",
};

// ---------------------------------------------------------------------------
// accumulateCost
// ---------------------------------------------------------------------------

/**
 * Estrae il valore di costo da un usage, gestendo i formati:
 * `usage.cost` number | string, oppure `usage.cost.total` number | string,
 * `null`/`undefined`/assente -> 0. Clamp a >= 0.
 */
function extractCost(usage: unknown): number {
  if (usage === null || usage === undefined || typeof usage !== "object") {
    return 0;
  }
  const cost = (usage as Record<string, unknown>).cost;
  if (typeof cost === "number" && Number.isFinite(cost)) {
    return Math.max(0, cost);
  }
  if (typeof cost === "string") {
    const n = Number(cost);
    return Number.isFinite(n) ? Math.max(0, n) : 0;
  }
  if (cost !== null && typeof cost === "object") {
    const total = (cost as Record<string, unknown>).total;
    if (typeof total === "number" && Number.isFinite(total)) {
      return Math.max(0, total);
    }
    if (typeof total === "string") {
      const n = Number(total);
      return Number.isFinite(n) ? Math.max(0, n) : 0;
    }
    return 0;
  }
  return 0;
}

/**
 * Somma il costo estratto da `usage` al totale corrente.
 * Ritorna `current` invariato se `current` non è un numero finito.
 */
export function accumulateCost(usage: unknown, current: number): number {
  if (!Number.isFinite(current)) {
    return current;
  }
  return current + extractCost(usage);
}

// ---------------------------------------------------------------------------
// truncateOutput
// ---------------------------------------------------------------------------

/**
 * Tronca `text` a `limit` caratteri appendendo `marker` (default:
 * `[OUTPUT TRUNCATED at <limit> chars]`). Se il testo sta nei limiti ritorna
 * il testo integro con `truncated: false` e nessun marker. Se `limit` è
 * minore della lunghezza del marker, lancia `RangeError` (config invalida —
 * guard a monte nei consumer).
 */
export function truncateOutput(
  text: string,
  limit: number,
  marker?: string,
): { text: string; truncated: boolean } {
  const defaultMarker = `[OUTPUT TRUNCATED at ${limit} chars]`;
  const effectiveMarker = marker === undefined || marker === "" ? defaultMarker : marker;
  if (text.length <= limit) {
    return { text, truncated: false };
  }
  if (limit < effectiveMarker.length) {
    throw new RangeError(
      `truncateOutput: limit (${limit}) < marker length (${effectiveMarker.length}) — config non valida`,
    );
  }
  const cut = limit - effectiveMarker.length;
  return { text: text.slice(0, cut) + effectiveMarker, truncated: true };
}

// ---------------------------------------------------------------------------
// formatFailureMarker
// ---------------------------------------------------------------------------

/** Caratteri non ammessi nei marker (regex-safe: niente `\`, `[`, `]`). */
const MARKER_SANITIZE_RE = /[\\[\]\r\n\t]/g;

/**
 * Sanitizza un componente del marker: sostituisce i caratteri che romperebbero
 * il matching regex / la struttura a parentesi e limita la lunghezza (il
 * marker totale resta <= ~200 char).
 */
function sanitizeMarkerPart(value: string, maxLen = 64): string {
  return value.replace(MARKER_SANITIZE_RE, "_").slice(0, maxLen);
}

/** Unisce i componenti del marker ignorando `undefined`. */
function bracketMarker(parts: Array<string | undefined>): string {
  return `[${parts.filter((p): p is string => p !== undefined).join(" ")}]`;
}

/**
 * Produce il failure marker strutturato per il kind dato.
 *
 * Formati canonici (RESEARCH M003/S01 §5.3):
 * - `failed`           -> `[PARTICIPANT FAILED: <id> <reason> <ts>]`
 * - `skipped`          -> `[PARTICIPANT SKIPPED: <id>]` (reason opzionale)
 * - `timeout_round`    -> `[TIMEOUT: <id> round_timeout <ts>]`
 * - `timeout_event`    -> `[TIMEOUT: <id> event_watchdog <ts>]`
 * - `budget_exhausted` -> `[BUDGET EXHAUSTED: <id> at round <N>]` (reason = `at round N`)
 * - `output_truncated` -> `[OUTPUT TRUNCATED at <N> chars]` (senza participant id)
 *
 * Kind non riconosciuto -> `Error` esplicito (no fallback silenzioso).
 */
export function formatFailureMarker(
  kind: FailureKind,
  participantId: string,
  reason?: string,
  timestamp?: string,
): string {
  const id = sanitizeMarkerPart(participantId);
  switch (kind) {
    case "failed":
      return bracketMarker(["PARTICIPANT FAILED:", id, reason && sanitizeMarkerPart(reason), timestamp]);
    case "skipped":
      return bracketMarker(["PARTICIPANT SKIPPED:", id, reason && sanitizeMarkerPart(reason)]);
    case "timeout_round":
      return bracketMarker(["TIMEOUT:", id, "round_timeout", timestamp]);
    case "timeout_event":
      return bracketMarker(["TIMEOUT:", id, "event_watchdog", timestamp]);
    case "budget_exhausted":
      return bracketMarker(["BUDGET EXHAUSTED:", id, reason && sanitizeMarkerPart(reason), timestamp]);
    case "output_truncated": {
      const detail = reason === undefined ? "limit" : sanitizeMarkerPart(reason, 100);
      const suffix = /chars$/i.test(detail) ? "" : " chars";
      return `[OUTPUT TRUNCATED at ${detail}${suffix}]`;
    }
    default:
      throw new Error(`formatFailureMarker: kind sconosciuto: ${String(kind)}`);
  }
}

// ---------------------------------------------------------------------------
// resolveParticipantLimits
// ---------------------------------------------------------------------------

/** Warning su stderr per fallback/clamp (canale di osservabilità del CLI). */
function warnLimits(field: string, raw: unknown, action: string): void {
  process.stderr.write(
    `[discussion-arena] warning: resolveParticipantLimits: ${field}=${JSON.stringify(raw)} -> ${action}\n`,
  );
}

/**
 * Risolve un campo numerico lungo la catena toolParams -> frontmatter ->
 * fallback. Valori non numerici/NaN -> livello inferiore (warning). Valori
 * sotto `opts.min`: con `clamp: true` vengono clampati al minimo, altrimenti
 * passano al livello inferiore.
 */
function pickNumber(
  toolParams: unknown,
  frontmatter: unknown,
  fallback: number,
  field: string,
  opts: { min: number; clamp: boolean },
): number {
  for (const [value, source] of [
    [toolParams, "toolParams"],
    [frontmatter, "frontmatter"],
  ] as const) {
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      warnLimits(`${source}.${field}`, value, "valore invalido -> livello inferiore");
      continue;
    }
    if (value < opts.min) {
      if (opts.clamp) {
        warnLimits(`${source}.${field}`, value, `clamp a ${opts.min}`);
        return opts.min;
      }
      warnLimits(`${source}.${field}`, value, `sotto la soglia minima (${opts.min}) -> livello inferiore`);
      continue;
    }
    return value;
  }
  return fallback;
}

/** Risolve `termination` lungo la catena toolParams -> frontmatter -> fallback. */
function pickTermination(
  toolParams: unknown,
  frontmatter: unknown,
  fallback: TerminationMode,
): TerminationMode {
  for (const [value, source] of [
    [toolParams, "toolParams"],
    [frontmatter, "frontmatter"],
  ] as const) {
    if (value === undefined) continue;
    if (value === "soft" || value === "hard") return value;
    warnLimits(`${source}.termination`, value, "valore invalido -> livello inferiore");
  }
  return fallback;
}

/**
 * Merge dei limiti partecipante da 3 livelli con precedenza crescente:
 * `defaults < frontmatter < toolParams`. Ogni campo è validato a runtime;
 * valori invalidi (stringhe, NaN, sotto soglia) fanno fallback al livello
 * inferiore o al default, con warning su stderr. Non lancia mai.
 */
export function resolveParticipantLimits(
  toolParams: ParticipantLimitsInput,
  frontmatter: ParticipantLimitsInput,
  defaults: ResolvedLimits,
): ResolvedLimits {
  return {
    roundTimeoutMs: pickNumber(toolParams.roundTimeoutMs, frontmatter.roundTimeoutMs, defaults.roundTimeoutMs, "roundTimeoutMs", { min: 1, clamp: false }),
    eventTimeoutMs: pickNumber(toolParams.eventTimeoutMs, frontmatter.eventTimeoutMs, defaults.eventTimeoutMs, "eventTimeoutMs", { min: 1, clamp: false }),
    outputLimitChars: pickNumber(toolParams.outputLimitChars, frontmatter.outputLimitChars, defaults.outputLimitChars, "outputLimitChars", { min: 1, clamp: true }),
    costBudgetUsd: pickNumber(toolParams.costBudgetUsd, frontmatter.costBudgetUsd, defaults.costBudgetUsd, "costBudgetUsd", { min: 0, clamp: true }),
    termination: pickTermination(toolParams.termination, frontmatter.termination, defaults.termination),
  };
}

// ---------------------------------------------------------------------------
// shouldSkipParticipant
// ---------------------------------------------------------------------------

/**
 * Decide se il partecipante deve essere saltato: true se `participantId` è in
 * `state.morti`. Con `morti` come Map la reason specifica (FailureKind) viene
 * riportata nel risultato; con Set/array la reason è `"failed"`.
 */
export function shouldSkipParticipant(
  state: ArenaState,
  participantId: string,
): { skip: boolean; reason?: FailureKind } {
  const morti = state.morti;
  if (morti == null) return { skip: false };
  if (morti instanceof Map) {
    const reason = morti.get(participantId);
    return reason !== undefined ? { skip: true, reason } : { skip: false };
  }
  if (morti instanceof Set) {
    return morti.has(participantId) ? { skip: true, reason: "failed" } : { skip: false };
  }
  return morti.includes(participantId) ? { skip: true, reason: "failed" } : { skip: false };
}

// ---------------------------------------------------------------------------
// appendEvent / readEvents
// ---------------------------------------------------------------------------

/**
 * Appende un evento all'event log JSONL (riga `JSON.stringify(event) + "\n"`).
 * Scrittura append-only con O_APPEND: singola write < PIPE_BUF (4096 byte su
 * Linux) è atomica, quindi append concorrenti non si corrompono a vicenda.
 */
export async function appendEvent(filePath: string, event: ArenaEvent): Promise<void> {
  await fs.appendFile(filePath, `${JSON.stringify(event)}\n`, "utf-8");
}

/**
 * Legge gli eventi da un event log JSONL come async iterable. Righe malformate
 * o non conformi ad `ArenaEvent` (manca `ts`/`type`) vengono saltate in
 * silenzio (fail-safe). File inesistente -> iterable vuoto, nessun throw.
 * Gli errori I/O diversi da ENOENT vengono propagati.
 */
export async function* readEvents(filePath: string): AsyncIterable<ArenaEvent> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return;
    throw err;
  }
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof (parsed as ArenaEvent).ts === "string" &&
      typeof (parsed as ArenaEvent).type === "string"
    ) {
      yield parsed as ArenaEvent;
    }
  }
}

// ---------------------------------------------------------------------------
// Export raggruppato (per test ergonomici)
// ---------------------------------------------------------------------------

export const helpers = {
  accumulateCost,
  truncateOutput,
  formatFailureMarker,
  resolveParticipantLimits,
  shouldSkipParticipant,
  appendEvent,
  readEvents,
};

export default helpers;
