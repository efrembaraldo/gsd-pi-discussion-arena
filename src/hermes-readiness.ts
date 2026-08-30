/**
 * Hermes CLI readiness probe (M015/S02/R039).
 *
 * Gate per la degradazione deterministica a `gsd` quando il binario `hermes`
 * non è nel PATH (decisione D129): il flusso M015/S02 instrada per default i
 * participant con `engine === "hermes"` su `hermes -z <prompt>`, ma se il
 * runtime esterno non è disponibile vogliamo cadere nel runner `gsd` esistente
 * in modo deterministico e segnalato a stderr — non crashare il turno
 * con `ENOENT` o finire in un hang senza feedback all'utente.
 *
 * TTL cache (decisione R039): la probe `hermes --version` non è gratis (fork
 * del processo), e i call site (selection engine S04, fake-hermes-fallback
 * detector) chiamano `isHermesAvailable()` spesso durante la discovery e la
 * preparazione del run. Cache module-scope di 30s per ridurre probe ripetuti
 * ed evitare spam stderr (la stderr-warning su probe fallito è una volta per
 * cache miss, non una volta per call). 30s è breve abbastanza da reagire
 * a un'installazione tardiva dell'utente e lungo abbastanza da non notare
 * il costo di probe per-run in CI. Override: il test integration
 * (tests/hermes-participant.test.ts S02/T03) preferisce comunque spawn
 * diretto della fixture e non usa questa funzione, quindi il TTL non
 * interferisce con la CI deterministica.
 */

import { execFileSync } from "node:child_process";

/**
 * TTL cache in millisecondi: 30 secondi. Trascorso, la prossima call
 * riesegue il probe. Modificabile solo a fini di test tramite resetCache().
 */
const HERMES_PROBE_TTL_MS = 30_000;

interface HermesProbeCache {
	/** Ultimo valore probeato (true = binario disponibile, false = probe fallito). */
	value: boolean;
	/** Timestamp in millisecondi dell'ultimo probe (Date.now()). */
	at: number;
}

let probeCache: HermesProbeCache | null = null;

/**
 * Probe `hermes --version` con cache module-scope TTL 30s.
 *
 * Comportamento:
 * - Cache hit (probe entro 30s) -> ritorna il valore cachato, nessuna stderr;
 * - Cache miss o scaduta -> esegue `execFileSync("hermes", ["--version"])`.
 *   - exit 0 -> cache true, ritorna true;
 *   - exit non-zero o throw (ENOENT, EACCES) -> cache false per 30s, ritorna
 *     false. Nessuna stderr emessa da questa funzione: lo stderr-warning
 *     separato (decisionale) è responsabilità del call site (vedi
 *     `logProbeFailureOnce` di seguito, usato da T02/S02 quando si sceglie
 *     il fallback). Mantenere la funzione pura permette ai test unit e al
 *     probe pre-run di chiamarla senza inquinare l'output.
 *
 * Nota sync: la probe `hermes --version` è nell'ordine dei millisecondi su
 * un binario locale; non vale la pena renderla async per il call pattern
 * attuale (decisione gateway R039). Se in futuro la probe diventa lenta
 * (es. container remoto), convertire in async e considerare una cache LRU.
 */
export function isHermesAvailable(): boolean {
	const now = Date.now();
	if (probeCache && now - probeCache.at < HERMES_PROBE_TTL_MS) {
		return probeCache.value;
	}
	let value = false;
	try {
		execFileSync("hermes", ["--version"], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		value = true;
	} catch {
		// ENOENT, EACCES, o exit non-zero: tutti equivalenti a "non disponibile".
		// Non rilanciamo: il call site (decisione D129) deciderà se degradare.
		value = false;
	}
	probeCache = { value, at: now };
	return value;
}

/**
 * Reset cache per test (M015/S02/T03). Visibile solo come esportazione
 * interna; non parte della superficie pubblica di R039. I test unit della
 * hermes-readiness possono chiamarla per simulare scenari cache hit/miss
 * senza toccare process.env.PATH o l'eseguibile.
 */
export function resetHermesProbeCache(): void {
	probeCache = null;
}
