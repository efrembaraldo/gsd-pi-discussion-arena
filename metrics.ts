/**
 * metrics.ts — Metriche Prometheus-style inline e log strutturato NDJSON (M003/S08).
 *
 * Due superfici di observability in-process, entrambe zero-dipendenze (D004):
 *
 * 1. **Registry metriche inline** esposto via `getMetrics()` — counters
 *    Prometheus-style e un histogram, con labels serializzate in chiavi
 *    deterministicamente ordinate. Formato JSON introspezionabile (snapshot
 *    difensiva: la copia restituita non è live, le mutazioni del chiamante
 *    non toccano il registry). L'histogram segue la convenzione Prometheus
 *    dei bucket CUMULATIVI (`bucket[i]` = osservazioni `<= buckets[i]`,
 *    ultimo elemento = +Inf), con buckets calibrati sul range osservabile
 *    dei round dell'arena (subprocess ~10ms → round timeout 5min):
 *    `[0.1, 1, 5, 30, 60, 120, 300]` secondi.
 *
 * 2. **Log emitter strutturato** — `emitStructuredLog()` scrive su stderr una
 *    riga NDJSON `{ts, level, event, ...fields}` (timestamp ISO 8601, nessun
 *    pretty-print). Gli helper `logGuard*` semantic sono la superficie per i
 *    guardrail: `guard.crash`, `guard.timeout`, `guard.output_truncated`,
 *    `guard.budget_exhausted`, `guard.skipped` — consumabili da pino/winston
 *    lato agent.
 *
 * Le 5 metriche pianificate (S08):
 * - `arena_crashes_total{participant}`                       — counter
 * - `arena_timeouts_total{participant,kind}`                 — counter
 * - `arena_cost_usd{participant}`                            — counter additivo
 * - `arena_output_chars_total{participant,round}`            — counter additivo
 * - `arena_round_duration_seconds{participant,round}`        — histogram
 *
 * Semantica di `arena_cost_usd` e `arena_output_chars_total`: counter ADDITIVI
 * in cui ogni chiamata somma il valore dell'evento corrente (delta per turno).
 * Il valore finale del counter è quindi il totale accumulato per quella serie
 * di labels — coerente con la semantica Prometheus di un counter `_total`.
 *
 * Thread-safety: Node è single-threaded e il loop di `runDiscussionArena`
 * invoca la registry sequenzialmente (un turno alla volta); `Map.get/set`
 * sincroni sono sufficienti. Allocazioni: nessuna nell'hot path dopo la prima
 * osservazione di una serie `(name, labels)`; `getMetrics()` alloca la
 * snapshot solo al consumo (mai dentro il loop dei turni).
 *
 * Reset: `resetMetrics()` azzera counters e histograms — usato in `beforeEach`
 * dei test che asseriscono metriche per isolare lo stato tra test (pattern
 * standard prom-client). Il registry è singleton in-process e lazy: se nessuno
 * registra metriche, `getMetrics()` ritorna una snapshot vuota.
 */

/**
 * Buckets dell'histogram `arena_round_duration_seconds`, in secondi, calibrati
 * sul range osservabile dei turni (subprocess veloce ~10ms → round timeout
 * 5min). Granularità fine nel range 0.1–30s (dove cade la maggior parte dei
 * turni), più lasco oltre. Freeze immutabile, riusabile come parametro
 * default di `recordHistogram`.
 */
export const DEFAULT_DURATION_BUCKETS_SECONDS: readonly number[] = Object.freeze(
	[0.1, 1, 5, 30, 60, 120, 300] as const,
);

/** Chiave di labels serializzata: `"{k1=v1,k2=v2}"` con chiavi ordinate. */
export type LabelKey = string;

/**
 * Stato interno di una serie histogram (per `(name, labels)`).
 * - `count` — numero di osservazioni;
 * - `sum` — somma delle osservazioni;
 * - `bucketCounts` — array di lunghezza `buckets.length + 1`, CUMULATIVO
 *   (convenzione Prometheus): `bucketCounts[i]` = osservazioni `<= buckets[i]`,
 *   `bucketCounts[buckets.length]` = osservazioni `> buckets[ultimo]` (+Inf).
 */
export interface HistogramState {
	count: number;
	sum: number;
	bucketCounts: number[];
}

/** Snapshot introspezionabile della registry: `{ counters, histograms }`. */
export interface MetricsSnapshot {
	counters: Record<string, Record<LabelKey, number>>;
	histograms: Record<string, Record<LabelKey, HistogramState>>;
}

/** Registry interno: outer key = nome metrica, inner key = LabelKey serializzata. */
const counters = new Map<string, Map<LabelKey, number>>();
const histograms = new Map<string, Map<LabelKey, HistogramState>>();

/**
 * Serializza le labels in una chiave deterministica: chiavi ordinate
 * lexicograficamente (`Object.keys().sort()`), formato `"{k1=v1,k2=v2}"`.
 * La deterministìa garantisce che l'ordine JSON dell'export sia stabile e
 * che due serie con le stesse labels in ordine diverso collidano sulla stessa
 * chiave.
 */
function serializeLabels(labels: Record<string, string>): LabelKey {
	const keys = Object.keys(labels).sort();
	return "{" + keys.map((k) => `${k}=${labels[k]}`).join(",") + "}";
}

/**
 * Incrementa un counter additivo per `(name, labels)` di `value` (default 1).
 * La prima osservazione di una serie alloca la Map interna; le successive
 * sono `Map.get + Map.set + Number + Number` (nessuna allocazione).
 */
export function recordCounter(
	name: string,
	labels: Record<string, string>,
	value = 1,
): void {
	let inner = counters.get(name);
	if (!inner) {
		inner = new Map();
		counters.set(name, inner);
	}
	const key = serializeLabels(labels);
	inner.set(key, (inner.get(key) ?? 0) + value);
}

/**
 * Osserva un valore su un histogram per `(name, labels)`, aggiornando
 * `count`, `sum` e i `bucketCounts` cumulativi (convenzione Prometheus).
 * I bucket sono fissati alla prima osservazione della serie (default:
 * `DEFAULT_DURATION_BUCKETS_SECONDS`); i successivi sample sulla stessa serie
 * riusano la stessa struttura.
 */
export function recordHistogram(
	name: string,
	labels: Record<string, string>,
	value: number,
	buckets: readonly number[] = DEFAULT_DURATION_BUCKETS_SECONDS,
): void {
	let inner = histograms.get(name);
	if (!inner) {
		inner = new Map();
		histograms.set(name, inner);
	}
	const key = serializeLabels(labels);
	let state = inner.get(key);
	if (!state) {
		state = { count: 0, sum: 0, bucketCounts: new Array(buckets.length + 1).fill(0) };
		inner.set(key, state);
	}
	state.count++;
	state.sum += value;
	// Primo bucket con soglia >= value: tutte le osservazioni incrementano
	// TUTTI i bucket da quello in poi, incluso il bucket +Inf (ultimo) —
	// semantica cumulativa Prometheus.
	let idx = buckets.length;
	for (let i = 0; i < buckets.length; i++) {
		if (value <= buckets[i]!) {
			idx = i;
			break;
		}
	}
	for (let i = idx; i < state.bucketCounts.length; i++) {
		state.bucketCounts[i]++;
	}
}

/**
 * Ritorna una snapshot DIFENSIVA (deep copy) della registry corrente:
 * `{ counters, histograms }` con chiavi LabelKey deterministicamente ordinate.
 * Il chiamante può mutare liberamente il risultato: il registry interno non
 * viene alterato. Da chiamare solo al consumo (mai nell'hot path del loop).
 */
export function getMetrics(): MetricsSnapshot {
	const countersOut: Record<string, Record<LabelKey, number>> = {};
	for (const [name, inner] of counters) {
		countersOut[name] = Object.fromEntries(inner);
	}
	const histogramsOut: Record<string, Record<LabelKey, HistogramState>> = {};
	for (const [name, inner] of histograms) {
		histogramsOut[name] = {};
		for (const [key, state] of inner) {
			histogramsOut[name][key] = {
				count: state.count,
				sum: state.sum,
				bucketCounts: [...state.bucketCounts],
			};
		}
	}
	return { counters: countersOut, histograms: histogramsOut };
}

/**
 * Accessor al registry interno (non una copia) per wiring esplicito e test di
 * basso livello. Il consumer tipico usa `getMetrics()` / helper semantic.
 */
export function getMetricsRegistry(): {
	counters: Map<string, Map<LabelKey, number>>;
	histograms: Map<string, Map<LabelKey, HistogramState>>;
} {
	return { counters, histograms };
}

/** Azzera counters e histograms. Da chiamare in `beforeEach` dei test che asseriscono metriche. */
export function resetMetrics(): void {
	counters.clear();
	histograms.clear();
}

// ─── Helper semantic per le 5 metriche pianificate (S08) ────────────────────

/** `arena_crashes_total{participant=<id>}` — un crash del turno del partecipante. */
export function recordArenaCrash(participantId: string): void {
	recordCounter("arena_crashes_total", { participant: participantId });
}

/** `arena_timeouts_total{participant=<id>,kind=<kind>}` — un timeout round/event. */
export function recordArenaTimeout(
	participantId: string,
	kind: "timeout_round" | "timeout_event",
): void {
	recordCounter("arena_timeouts_total", { participant: participantId, kind });
}

/**
 * `arena_cost_usd{participant=<id>}` — counter additivo: somma il costo del
 * singolo turno (delta) al totale cumulato del partecipante. Il valore finale
 * del counter è il costo totale speso. Chiamate con costo <= 0 non registrano
 * nulla (nessuna serie spuria a zero).
 */
export function recordArenaCost(participantId: string, costUsd: number): void {
	if (costUsd > 0) {
		recordCounter("arena_cost_usd", { participant: participantId }, costUsd);
	}
}

/** `arena_output_chars_total{participant=<id>,round=<n>}` — counter additivo dei char emessi nel round. */
export function recordArenaOutputChars(
	participantId: string,
	round: number,
	chars: number,
): void {
	recordCounter(
		"arena_output_chars_total",
		{ participant: participantId, round: String(round) },
		chars,
	);
}

/** `arena_round_duration_seconds{participant=<id>,round=<n>}` — histogram della durata del turno. */
export function recordArenaRoundDuration(
	participantId: string,
	round: number,
	durationSeconds: number,
): void {
	recordHistogram(
		"arena_round_duration_seconds",
		{ participant: participantId, round: String(round) },
		durationSeconds,
	);
}

// ─── Log emitter strutturato NDJSON su stderr ───────────────────────────────

/**
 * Scrive una riga NDJSON su stderr: `{ts, level, event, ...fields}` con
 * `ts` = timestamp ISO 8601 (per la correlazione temporale con il transcript
 * e l'event log S07). Nessun pretty-print, una sola riga terminata con `\n` —
 * consumabile da pino/winston lato agent. Fail-safe: `JSON.stringify` non
 * lancia mai per oggetti plani (`fields` viene serializzato; se un campo non
 * è serializzabile produce `undefined` omesso, mai un throw).
 */
export function emitStructuredLog(
	level: "info" | "warn" | "error",
	event: string,
	fields: Record<string, unknown>,
): void {
	const line = JSON.stringify({
		ts: new Date().toISOString(),
		level,
		event,
		...fields,
	});
	process.stderr.write(line + "\n");
}

/** `guard.crash` — il turno di `participantId` è terminato con un'eccezione (S03). */
export function logGuardCrash(participantId: string, reason: string): void {
	emitStructuredLog("error", "guard.crash", { participantId, reason });
}

/** `guard.timeout` — il turno di `participantId` ha superato una soglia di timeout (S04). */
export function logGuardTimeout(
	participantId: string,
	kind: "timeout_round" | "timeout_event",
	thresholdMs: number,
): void {
	emitStructuredLog("warn", "guard.timeout", { participantId, kind, thresholdMs });
}

/** `guard.output_truncated` — l'output di `participantId` è stato troncato a `limitChars` (S05). */
export function logGuardTruncated(
	participantId: string,
	limitChars: number,
	originalChars: number,
): void {
	emitStructuredLog("warn", "guard.output_truncated", {
		participantId,
		limitChars,
		originalChars,
	});
}

/** `guard.budget_exhausted` — il costo cumulato di `participantId` ha superato il budget (S06). */
export function logGuardBudgetExhausted(
	participantId: string,
	costUsd: number,
	budgetUsd: number,
	round: number,
): void {
	emitStructuredLog("warn", "guard.budget_exhausted", {
		participantId,
		costUsd,
		budgetUsd,
		round,
	});
}

/** `guard.skipped` — `participantId` è stato saltato (morto da un guardrail precedente). */
export function logGuardSkipped(participantId: string, reason: string): void {
	emitStructuredLog("info", "guard.skipped", { participantId, reason });
}
