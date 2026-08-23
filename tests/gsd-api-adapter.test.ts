/**
 * Unit tests for src/gsd-api-adapter.ts (S01/T01 — M014).
 *
 * Contratto verificato:
 *   - `isGSDExtensionAPI(api)` — type guard strutturale: true SOLO se
 *     `api.getPhase` è una funzione. Narrowing corretto: stub con getPhase
 *     fn → true; stub plain ExtensionAPI → false; api null/undefined → false.
 *   - `getRuntimePhase(api)` — wrapper async. Restituisce la Phase quando
 *     getPhase la ritorna; ritorna null su stub plain (no getPhase);
 *     su getPhase() throw → null + emette NDJSON `guard.skipped` su stderr
 *     con `adapter=gsd-api-adapter`, `reason=getPhase_threw`, `error=<msg>`.
 *     Mai propagazione di eccezione al call site.
 *   - `getRuntimePhaseSync(api)` — variante sincrona con stessa semantica:
 *     coerenza con la versione async su tutti gli scenari (con phase, senza
 *     getPhase, con getPhase throw, plain).
 *
 * Failure modes coperti (Q7 negative tests):
 *   - api null/undefined → type guard false, entrambi i wrapper ritornano null.
 *   - api plain ExtensionAPI (no getPhase) → type guard false, null.
 *   - api.getPhase presente ma throws → null + log structured warn.
 *   - api.getPhase presente ma ritorna undefined → null (?? null coercizione).
 *   - api con `getPhase: "not-a-function"` → type guard false.
 *
 * Niente subprocess, niente rete, niente I/O su disco. Il modulo ha un
 * solo side-effect osservabile (emitStructuredLog su stderr) che viene
 * catturato esplicitamente nei test 3 e 5c.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import {
	getRuntimePhase,
	getRuntimePhaseSync,
	isGSDExtensionAPI,
	type GSDExtensionAPI,
} from "../src/gsd-api-adapter.js";
import { getMetrics, resetMetrics, recordGSDExtensionAPIDetected } from "../src/metrics.js";

// NOTA: NON usiamo `test.beforeEach(() => resetMetrics())` per non interferire
// con il registry globale delle metriche in esecuzioni parallele di `npm test`
// (il reset azzera la Map globale usata anche da altri test file come
// pending-research-lock). Il reset è effettuato SOLO localmente nei test
// che asseriscono lo stato di `getMetrics()`.

// ─── Helper: cattura stderr sincrona (adattata da runtime-classifier.test) ──────

/**
 * Cattura le write su `process.stderr` durante l'esecuzione di `fn()`,
 * ripristinando sempre `process.stderr.write` originale. Usato per asserire
 * che `getRuntimePhase`/`getRuntimePhaseSync` emettano ESATTAMENTE il log
 * NDJSON `guard.skipped` quando `getPhase()` throws. Stesso pattern di
 * `captureStderrSync` in runtime-classifier.test.ts — qui esportato come
 * `captureStderr` (no `Sync` suffix perché il pattern è già uniforme).
 */
function captureStderr<T>(fn: () => T): { result: T; lines: string[] } {
	const lines: string[] = [];
	const original = process.stderr.write.bind(process.stderr);
	process.stderr.write = ((chunk: unknown) => {
		lines.push(typeof chunk === "string" ? chunk : String(chunk));
		return true;
	}) as typeof process.stderr.write;
	try {
		return { result: fn(), lines };
	} finally {
		process.stderr.write = original;
	}
}

// ─── Helper: stub sintetico di `GSDExtensionAPI` per i test ─────────────

/**
 * Stub minimale di `GSDExtensionAPI`: solo `getPhase()` con il valore
 * iniettato. Usato dai test 1 (phase valida) e 5a (sync con phase).
 */
function createGSDApiStub(getPhaseValue: unknown): GSDExtensionAPI {
	return {
		getPhase: () => getPhaseValue,
	} as unknown as GSDExtensionAPI;
}

/**
 * Stub plain `ExtensionAPI` (senza `getPhase`) che modella il caso reale di
 * test/fixtures/pi-coding-agent-stub.ts: solo `on` è presente, niente
 * `getPhase`. Usato dai test 2, 5b, e dal sub-test "plain" del test 4.
 */
function createPlainApiStub(): ExtensionAPI {
	return {
		on(_event: string, _handler: unknown): unknown {
			return undefined;
		},
	} as unknown as ExtensionAPI;
}

// Reset metriche: SOLO locale, nei test che asseriscono lo stato di
// `getMetrics()`. NON usiamo `test.beforeEach` per non interferire con il
// registry globale delle metriche in esecuzioni parallele.


// ════════════════════════════════════════════════════════════════════════════
// SEZIONE 1 — isGSDExtensionAPI: type guard strutturale
// ════════════════════════════════════════════════════════════════════════════

test("isGSDExtensionAPI: stub con getPhase fn → true (narrowing a GSDExtensionAPI)", () => {
	const api = createGSDApiStub("planning");
	assert.equal(isGSDExtensionAPI(api), true);
	// Dopo il narrowing, TS sa che `api.getPhase()` esiste. Questo è un
	// compile-time check implicito: il test esegue `api.getPhase()` e ne
	// asserisce il valore, cosa che NON compilerebbe se `api` fosse plain
	// ExtensionAPI. Se narrowing fallisse, il test sarebbe un type error.
	assert.equal(api.getPhase(), "planning");
});

test("isGSDExtensionAPI: stub plain ExtensionAPI (no getPhase) → false", () => {
	const api = createPlainApiStub();
	assert.equal(isGSDExtensionAPI(api), false);
});

test("isGSDExtensionAPI: stub con getPhase='not-a-function' → false (typeof guard)", () => {
	// getPhase presente come proprietà NON-function: il cast `as
	// Partial<GSDExtensionAPI>` non basta — serve il typeof check.
	const api = { on: () => undefined, getPhase: "bogus" } as unknown as ExtensionAPI;
	assert.equal(isGSDExtensionAPI(api), false);
});

test("isGSDExtensionAPI: narrowing — stub con getPhase fn ritorna Phase; stub plain ritorna null dal wrapper", async () => {
	// Test integrato: usa il narrowing del type guard per scegliere il
	// percorso. Con narrowing valido: stub con getPhase → phase ritornata;
	// senza narrowing: stub plain → wrapper ritorna null.
	const gsdApi: ExtensionAPI = createGSDApiStub("executing");
	const plainApi: ExtensionAPI = createPlainApiStub();

	if (isGSDExtensionAPI(gsdApi)) {
		assert.equal(gsdApi.getPhase(), "executing");
	} else {
		assert.fail("isGSDExtensionAPI doveva essere true per stub con getPhase fn");
	}

	if (isGSDExtensionAPI(plainApi)) {
		assert.fail("isGSDExtensionAPI doveva essere false per stub plain");
	} else {
		// narrowing negativo: plainApi è ExtensionAPI plain, nessun getPhase.
		assert.equal(typeof (plainApi as Partial<GSDExtensionAPI>).getPhase, "undefined");
	}
});

// ════════════════════════════════════════════════════════════════════════════
// SEZIONE 2 — getRuntimePhase (async): con phase, senza getPhase, con throw
// ════════════════════════════════════════════════════════════════════════════

test("getRuntimePhase: stub con getPhase fn → ritorna la Phase attesa", async () => {
	const api = createGSDApiStub("planning");
	const phase = await getRuntimePhase(api);
	assert.equal(phase, "planning");
});

test("getRuntimePhase: stub plain ExtensionAPI (no getPhase) → null", async () => {
	const api = createPlainApiStub();
	const phase = await getRuntimePhase(api);
	assert.equal(phase, null);
});

test("getRuntimePhase: stub con getPhase() che throws → null + log NDJSON guard.skipped", async () => {
	// Reset metrics per isolare lo stato prima dell'osservazione.
	resetMetrics();
	const api = {
		getPhase: (): never => {
			throw new Error("boom");
		},
	} as unknown as ExtensionAPI;

	const { result, lines } = captureStderr(() => getRuntimePhase(api));
	const phase = await result;

	assert.equal(phase, null, "getRuntimePhase deve ritornare null su getPhase throw");
	assert.equal(lines.length, 1, "esattamente UNA riga NDJSON su stderr");
	const line = lines[0]!.trim();
	const parsed = JSON.parse(line) as Record<string, unknown>;
	assert.equal(parsed["level"], "warn", "level deve essere warn");
	assert.equal(parsed["event"], "guard.skipped", "event deve essere guard.skipped");
	assert.equal(parsed["adapter"], "gsd-api-adapter", "adapter identifica il modulo");
	assert.equal(parsed["reason"], "getPhase_threw", "reason deve essere getPhase_threw");
	assert.equal(parsed["error"], "boom", "error deve contenere il messaggio originale");
	assert.ok(typeof parsed["ts"] === "string" && parsed["ts"].length > 0, "ts presente (ISO 8601)");
});

test("getRuntimePhase: stub con getPhase() che ritorna null → null (no log, no errore)", async () => {
	// getPhase() ritorna null legittimamente (runtime idle / pre-attivazione):
	// il wrapper non deve loggare nulla, deve solo propagare null.
	const api = createGSDApiStub(null);
	const phase = await getRuntimePhase(api);
	assert.equal(phase, null);
});

test("getRuntimePhase: stub con getPhase() che ritorna undefined → null (?? null coercizione)", async () => {
	// Difesa contro stub malformati che ritornano undefined invece di null.
	// Comportamento atteso: ritorna null silenziosamente (nessun log warn
	// perché non c'è stato un throw).
	const api = createGSDApiStub(undefined);
	const phase = await getRuntimePhase(api);
	assert.equal(phase, null);
});

// ════════════════════════════════════════════════════════════════════════════
// SEZIONE 3 — getRuntimePhaseSync (sync): 4 sub-test coerenti con async
// ════════════════════════════════════════════════════════════════════════════

test("getRuntimePhaseSync (a): stub con getPhase fn → ritorna la Phase attesa (sync)", () => {
	const api = createGSDApiStub("verifying");
	const phase = getRuntimePhaseSync(api);
	assert.equal(phase, "verifying");
});

test("getRuntimePhaseSync (b): stub plain ExtensionAPI (no getPhase) → null", () => {
	const api = createPlainApiStub();
	const phase = getRuntimePhaseSync(api);
	assert.equal(phase, null);
});

test("getRuntimePhaseSync (c): stub con getPhase() che throws → null + log NDJSON guard.skipped", () => {
	resetMetrics();
	const api = {
		getPhase: (): never => {
			throw new Error("sync-boom");
		},
	} as unknown as ExtensionAPI;

	const { result, lines } = captureStderr(() => getRuntimePhaseSync(api));

	assert.equal(result, null, "getRuntimePhaseSync deve ritornare null su getPhase throw");
	assert.equal(lines.length, 1, "esattamente UNA riga NDJSON su stderr (sync path)");
	const parsed = JSON.parse(lines[0]!.trim()) as Record<string, unknown>;
	assert.equal(parsed["level"], "warn");
	assert.equal(parsed["event"], "guard.skipped");
	assert.equal(parsed["adapter"], "gsd-api-adapter");
	assert.equal(parsed["reason"], "getPhase_threw");
	assert.equal(parsed["error"], "sync-boom");
});

test("getRuntimePhaseSync (d): stub plain ExtensionAPI con `getPhase` non-function → null (nessun log)", () => {
	// getPhase presente come proprietà non-function: type guard false, null
	// silenzioso (nessun log perché non c'è throw).
	const api = { on: () => undefined, getPhase: "not-a-function" } as unknown as ExtensionAPI;
	const phase = getRuntimePhaseSync(api);
	assert.equal(phase, null);
});

// ════════════════════════════════════════════════════════════════════════════
// SEZIONE 4 — Invarianti di osservabilità e coerenza async/sync
// ════════════════════════════════════════════════════════════════════════════

test("Coerenza: async e sync ritornano lo stesso valore sugli stessi input (matrice 4 scenari)", async () => {
	// Verifica che `getRuntimePhase` e `getRuntimePhaseSync` siano coerenti
	// su tutti i 4 scenari del contratto. Costruisce una matrice di coppie
	// (input, expected) e asserisce per ogni coppia che async e sync
	// ritornino lo stesso valore.
	interface Case {
		name: string;
		api: ExtensionAPI;
		expected: unknown;
	}

	const cases: Case[] = [
		{
			name: "getPhase returns 'planning'",
			api: createGSDApiStub("planning"),
			expected: "planning",
		},
		{
			name: "plain API (no getPhase)",
			api: createPlainApiStub(),
			expected: null,
		},
		{
			name: "getPhase returns null",
			api: createGSDApiStub(null),
			expected: null,
		},
		{
			name: "getPhase present but not a function",
			api: { on: () => undefined, getPhase: "bogus" } as unknown as ExtensionAPI,
			expected: null,
		},
	];

	for (const c of cases) {
		const syncResult = getRuntimePhaseSync(c.api);
		const asyncResult = await getRuntimePhase(c.api);
		assert.equal(
			syncResult,
			c.expected,
			`sync path: scenario "${c.name}" — atteso ${String(c.expected)}, ottenuto ${String(syncResult)}`,
		);
		assert.equal(
			asyncResult,
			c.expected,
			`async path: scenario "${c.name}" — atteso ${String(c.expected)}, ottenuto ${String(asyncResult)}`,
		);
		assert.equal(
			syncResult,
			asyncResult,
			`coerenza: scenario "${c.name}" — sync e async devono ritornare lo stesso valore`,
		);
	}
});

test("Osservabilità: getRuntimePhase non emette log NDJSON in nessun caso di successo (no getPhase, no throw)", async () => {
	// Su tutti i path di successo (getPhase ritorna Phase valida o null, o
	// stub plain senza getPhase), il wrapper NON deve loggare nulla. Solo
	// il path `getPhase()` throws emette log warn.
	const cases: ExtensionAPI[] = [
		createGSDApiStub("planning"),
		createGSDApiStub(null),
		createGSDApiStub(undefined),
		createPlainApiStub(),
	];

	for (const api of cases) {
		const { lines } = captureStderr(async () => await getRuntimePhase(api));
		assert.equal(
			lines.length,
			0,
			"nessun NDJSON emesso su path di successo (no throw, no warn spurio)",
		);
	}

	// Sanity: getMetrics() non è stato chiamato dal wrapper (l'helper
	// recordGSDExtensionAPIDetected è definito in metrics.ts ma NON è
	// chiamato dall'adapter — è solo il cablaggio in T02 a chiamarlo).
	const snap = getMetrics();
	assert.equal(
		snap.counters["gsd_extension_api_detected_total"],
		undefined,
		"adapter NON deve chiamare recordGSDExtensionAPIDetected (owner è hooks-unit-aware in T02)",
	);
});

// ══════════════════════════════════════════════════════════════════════════════
// SEZIONE 5 — Counter `gsd_extension_api_detected_total`: cardinalità label 2
// ══════════════════════════════════════════════════════════════════════════════

test("Counter gsd_extension_api_detected_total: cardinalità label outcome = 2 (detected|not_detected)", () => {
	// Il piano T01 richiede esplicitamente: getMetrics() includes
	// `counters["gsd_extension_api_detected_total"]` con cardinalità label 2.
	// Il literal type TypeScript `outcome: "detected" | "not_detected"`
	// garantisce a compile-time che non vengano accettati altri valori;
	// questo test verifica a runtime che:
	//   (a) l'helper recordGSDExtensionAPIDetected è esportato e callable;
	//   (b) la snapshot di getMetrics() contiene il counter con esattamente
	//       2 chiavi LabelKey (una per ciascun valore del label);
	//   (c) ogni LabelKey corrisponde a una delle 2 forme canoniche attese.
	// Reset locale: il counter helper T01 è l'unico autore del counter (T02
	// lo userà runtime). Qui lo chiamiamo direttamente per verificare la
	// shape della snapshot.
	resetMetrics();

	recordGSDExtensionAPIDetected("detected");
	recordGSDExtensionAPIDetected("not_detected");
	recordGSDExtensionAPIDetected("detected"); // doppia chiamata: stessa label key, counter additivo

	const snap = getMetrics();
	const counter = snap.counters["gsd_extension_api_detected_total"];
	assert.ok(
		counter !== undefined,
		"counter `gsd_extension_api_detected_total` deve essere presente in getMetrics() dopo recordGSDExtensionAPIDetected",
	);
	const labelKeys = Object.keys(counter!);
	assert.equal(
		labelKeys.length,
		2,
		`cardinalità label deve essere ESATTAMENTE 2 (una per detected, una per not_detected); trovate: ${labelKeys.join(", ")}`,
	);
	assert.ok(
		labelKeys.includes("{outcome=detected}"),
		"label key per 'detected' deve essere presente (serializeLabels formato canonico)",
	);
	assert.ok(
		labelKeys.includes("{outcome=not_detected}"),
		"label key per 'not_detected' deve essere presente (serializeLabels formato canonico)",
	);
	// Counter additivo: doppia chiamata su 'detected' → 2, singola su
	// 'not_detected' → 1.
	assert.equal(counter!["{outcome=detected}"], 2, "counter additivo: 'detected' incrementato 2 volte");
	assert.equal(counter!["{outcome=not_detected}"], 1, "counter additivo: 'not_detected' incrementato 1 volta");
});