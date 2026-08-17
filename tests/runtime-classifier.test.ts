/**
 * Unit tests for src/runtime-classifier.ts (S01/T02 — M010).
 *
 * Contratto verificato:
 *   - `parseSemver` riconosce i formati reali di `process.env.GSD_VERSION`
 *     emesso da gsd-pi (`1.15.0-dev.69075e6e`, prefisso `v`, forma MAJOR.MINOR
 *     senza patch) e rifiuta input malformati senza lanciare.
 *   - `classifyRuntime(api)` è una funzione PURA, sincrona e deterministica.
 *     I 3 mock F/A/D sono i tre scenari canonici del fingerprint:
 *       * F — fingerprint versione valido + before_agent_start + adjust_tool_set
 *             + unit_start (Full runtime).
 *       * A — fingerprint versione valido + before_agent_start + adjust_tool_set
 *             (manca solo unit_start, evento dichiarato ma non emesso a
 *             runtime in gsd-pi corrente — M010-RESEARCH.md §3).
 *       * D — capability insufficienti o fingerprint mancante. Le reason
 *             sono cumulative (più codici diagnostici in un solo result).
 *   - Edge cases coperti:
 *       * GSD_VERSION mancante (`process.env.GSD_VERSION` undefined).
 *       * `api.on(event, noop)` che lancia un'eccezione — `safeProbe` non
 *         propaga e degrada il probe a `false` (niente throw esterno).
 *       * Stub di `ExtensionAPI` senza `on` (typeof guard, nessuna registrazione).
 *       * Doppia chiamata deterministica: stesso input ⇒ stesso result.
 *       * Modulo puro: `classifyRuntime` NON scrive nulla su `process.stderr`
 *         (il side-effect Tier D one-shot vive nel caller `index.ts:activate()`
 *         — D085, R014).
 *
 * Niente subprocess, niente rete, niente I/O su disco. Il modulo è puro →
 * i test non hanno bisogno di stub stderr/subprocess né reset globale dello
 * stderr (catturato solo per asserire ASSENZA di side-effect).
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import {
	classifyRuntime,
	parseSemver,
	type CapabilityName,
} from "../src/runtime-classifier.js";

/**
 * Stub sintetico di `ExtensionAPI` che modella i 3 modi in cui `safeProbe`
 * può comportarsi su un hook:
 *   - `accept` → `api.on(event, noop)` ritorna senza lanciare → probe true.
 *   - `throw`  → `api.on(event, noop)` lancia un'eccezione → probe false
 *                (gestita dal try/catch interno a `safeProbe`).
 *   - non menzionato → trattato come `accept` (default: successo).
 *
 * Per modellare "tutti i probe falliscono" basta passare `omitOn: true`,
 * così `typeof api.on !== "function"` ritorna `false` per ogni hook (guard
 * documentato in `safeProbe`).
 */
interface ApiStubOpts {
	throwOn?: ReadonlyArray<CapabilityName>;
	omitOn?: boolean;
}

function createApiStub(opts: ApiStubOpts = {}): ExtensionAPI {
	const throwing = new Set<string>(opts.throwOn ?? []);
	if (opts.omitOn) {
		// `api.on` non è una funzione → `typeof api?.on === "function"` fallisce
		// in safeProbe per ogni hook → tutti i probe → false.
		return { on: undefined } as unknown as ExtensionAPI;
	}
	return {
		on(event: string, _handler: unknown): unknown {
			if (throwing.has(event)) {
				throw new Error(`[test-stub] api.on threw for "${event}"`);
			}
			// Nessuna registrazione effettiva: il solo fatto che `on` ritorni
			// senza lanciare basta a `safeProbe` per considerare il probe ok.
			return undefined;
		},
	} as unknown as ExtensionAPI;
}

/**
 * Setta `process.env.GSD_VERSION` per la durata di `fn` e ripristina il
 * valore precedente (anche se `fn` lancia). Salva lo stato anche se
 * `GSD_VERSION` non era definita all'ingresso.
 */
async function withGSDVersion<T>(
	value: string | undefined,
	fn: () => T | Promise<T>,
): Promise<T> {
	const prev = process.env.GSD_VERSION;
	if (value === undefined) delete process.env.GSD_VERSION;
	else process.env.GSD_VERSION = value;
	try {
		return await fn();
	} finally {
		if (prev === undefined) delete process.env.GSD_VERSION;
		else process.env.GSD_VERSION = prev;
	}
}

/**
 * Cattura le write su `process.stderr` durante l'esecuzione di `fn()`,
 * ripristinando sempre `process.stderr.write` originale. Usato per asserire
 * che `classifyRuntime` NON scriva nulla su stderr (modulo puro).
 */
function captureStderrSync<T>(fn: () => T): { result: T; lines: string[] } {
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

// ════════════════════════════════════════════════════════════════════════════
// SEZIONE 1 — parseSemver: formati reali, edge cases, malformed
// ════════════════════════════════════════════════════════════════════════════

test("parseSemver: gsd-pi formato reale `1.15.0-dev.69075e6e`", () => {
	assert.deepEqual(parseSemver("1.15.0-dev.69075e6e"), {
		major: 1,
		minor: 15,
		patch: 0,
	});
});

test("parseSemver: prefisso `v` (`v1.15.0`)", () => {
	assert.deepEqual(parseSemver("v1.15.0"), { major: 1, minor: 15, patch: 0 });
});

test("parseSemver: semver puro `1.15.0`", () => {
	assert.deepEqual(parseSemver("1.15.0"), { major: 1, minor: 15, patch: 0 });
});

test("parseSemver: senza patch (`1.15`) → patch=null", () => {
	assert.deepEqual(parseSemver("1.15"), { major: 1, minor: 15, patch: null });
});

test("parseSemver: prefisso `v` senza patch (`v1.15`) → patch=null", () => {
	assert.deepEqual(parseSemver("v1.15"), { major: 1, minor: 15, patch: null });
});

test("parseSemver: suffisso `+build` (`1.15.0+build.123`) preservato come patch=0", () => {
	assert.deepEqual(parseSemver("1.15.0+build.123"), {
		major: 1,
		minor: 15,
		patch: 0,
	});
});

test("parseSemver: prerelease-only (`1.15.0-rc.1`) preservato", () => {
	assert.deepEqual(parseSemver("1.15.0-rc.1"), { major: 1, minor: 15, patch: 0 });
});

test("parseSemver: `undefined` → null (no throw)", () => {
	assert.equal(parseSemver(undefined), null);
});

test("parseSemver: stringa vuota → null (no throw)", () => {
	assert.equal(parseSemver(""), null);
});

test("parseSemver: input non semver (`abc`, `1`, `1.15.0.1`, `v`) → null", () => {
	assert.equal(parseSemver("abc"), null);
	assert.equal(parseSemver("1"), null, "MAJOR only — minor obbligatorio");
	assert.equal(parseSemver("1.15.0.1"), null, "4-component non è semver canonico");
	assert.equal(parseSemver("v"), null, "solo prefisso `v` senza numeri");
	assert.equal(parseSemver("1.x.0"), null, "minor non numerico");
});

test("parseSemver: anchor `^...$` — substring match non deve passare", () => {
	// Se la regex non fosse ancorata, queste stringhe passerebbero per
	// substring match dentro "1.15.0-something". Verifica della robustezza.
	assert.equal(parseSemver("not-1.15.0-here"), null);
	assert.equal(parseSemver("a1.15.0"), null);
	assert.equal(parseSemver("1.15.0bad"), null);
});

// ════════════════════════════════════════════════════════════════════════════
// SEZIONE 2 — classifyRuntime: 3 mock canonici F / A / D
// ════════════════════════════════════════════════════════════════════════════

test("Tier F: GSD_VERSION valido + tutti i 3 hook critici → tier F, reasons vuote, 4 capabilities", async () => {
	await withGSDVersion("1.15.0-dev.69075e6e", () => {
		const api = createApiStub(); // tutti i probe accettati
		const result = classifyRuntime(api);

		assert.equal(result.tier, "F");
		assert.deepEqual([...result.reasons], []);
		assert.equal(result.capabilities.size, 4, "tutti e 4 i hook probeati sono accettati");
		assert.ok(result.capabilities.has("before_agent_start"));
		assert.ok(result.capabilities.has("adjust_tool_set"));
		assert.ok(result.capabilities.has("unit_start"));
		assert.ok(result.capabilities.has("tool_call"));
	});
});

test("Tier A: GSD_VERSION valido + before_agent_start + adjust_tool_set (manca unit_start) → tier A, reasons=[no_unit_start]", async () => {
	await withGSDVersion("1.15.0", () => {
		// simulate: unit_start viene emesso dal runtime ma non onora probe → throw
		// (l'unico modo per `safeProbe` di restituire false è se `api.on` lancia).
		const api = createApiStub({ throwOn: ["unit_start"] });
		const result = classifyRuntime(api);

		assert.equal(result.tier, "A");
		assert.deepEqual([...result.reasons], ["no_unit_start"]);
		// capabilities: solo i 3 hook NON lancianti. tool_call è una capability
		// "laterale" (non usata per il tier) ma viene sempre probeata e accettata.
		assert.equal(result.capabilities.size, 3);
		assert.ok(!result.capabilities.has("unit_start"));
		assert.ok(result.capabilities.has("before_agent_start"));
		assert.ok(result.capabilities.has("adjust_tool_set"));
		assert.ok(result.capabilities.has("tool_call"));
	});
});

test("Tier D (no_GSD_VERSION): env mancante + tutti i 3 hook accettati → tier D, reasons=[no_GSD_VERSION]", async () => {
	// Verifica anche il path specifico in cui il fingerprint è assente ma le
	// capability sono integre: il fingerprint è un ASSE ortogonale (D081) — può
	// degradare a D anche se gli hook sono tutti accettati.
	await withGSDVersion(undefined, () => {
		const api = createApiStub();
		const result = classifyRuntime(api);

		assert.equal(result.tier, "D");
		assert.deepEqual([...result.reasons], ["no_GSD_VERSION"]);
		// Capabilities: integre, ma il tier è D perché il fingerprint manca.
		assert.equal(result.capabilities.size, 4);
	});
});

test("Tier D cumulativo: env valido + tutti i 3 hook probe falliti → D, reasons=[no_before_agent_start, no_adjust_tool_set, no_unit_start]", async () => {
	await withGSDVersion("1.15.0", () => {
		const api = createApiStub({
			throwOn: ["before_agent_start", "adjust_tool_set", "unit_start"],
		});
		const result = classifyRuntime(api);

		assert.equal(result.tier, "D");
		assert.deepEqual([...result.reasons], [
			"no_before_agent_start",
			"no_adjust_tool_set",
			"no_unit_start",
		]);
		// tool_call non lancia → è una capability laterale (non influenza il tier).
		assert.ok(result.capabilities.has("tool_call"));
	});
});

// ════════════════════════════════════════════════════════════════════════════
// SEZIONE 3 — Edge cases
// ════════════════════════════════════════════════════════════════════════════

test("Edge: D + no_GSD_VERSION + hook falliti → reasons=[no_GSD_VERSION] (env gate ha priorità sulle hook reasons)", async () => {
	// Decisione di design del modulo (T01): il check `parsedSemver === null`
	// è il PRIMO gate del tier decision. Quando il fingerprint non parsa,
	// reasons contiene SOLO `no_GSD_VERSION`: l'env mancante è un singolo
	// root-cause diagnostico, non viene cumulato con le hook reasons perché
	// l'utente non può "riparare" missing-env aggiungendo hook. Le hook
	// reasons entrano invece nel branch `else` (parsedSemver valido ma
	// capability insufficienti).
	await withGSDVersion(undefined, () => {
		const api = createApiStub({
			throwOn: ["before_agent_start", "adjust_tool_set", "unit_start"],
		});
		const result = classifyRuntime(api);

		assert.equal(result.tier, "D");
		assert.deepEqual(
			[...result.reasons],
			["no_GSD_VERSION"],
			"env gate omette le hook reasons — single root-cause per missing fingerprint",
		);
		// Capabilities: il safeProbe è comunque eseguito su tutti gli hook
		// (effetto osservabile dell'algloritmo, non influenza il tier perché
		// lo short-circuit sul env gate lo precede). tool_call non è lanciato
		// ed è una capability "laterale" → entra nelle capabilities.
		assert.equal(result.capabilities.size, 1, "solo tool_call accettato");
		assert.ok(result.capabilities.has("tool_call"));
	});
});

test("Edge: solo before_agent_start mancante (altri 2 hook + GSD_VERSION ok) → D, reasons=[no_before_agent_start]", async () => {
	// Caso chirurgico: tutti gli hook tranne uno sono accettati → D ma con
	// solo una reason specifica, non cumulativa. Verifica che il branch
	// `else` di `classifyRuntime` aggiunga reasons granulari.
	await withGSDVersion("1.15.0", () => {
		const api = createApiStub({ throwOn: ["before_agent_start"] });
		const result = classifyRuntime(api);

		assert.equal(result.tier, "D");
		assert.deepEqual([...result.reasons], ["no_before_agent_start"]);
		// Gli altri 3 hook sono accettati (adjust_tool_set, unit_start, tool_call).
		assert.equal(result.capabilities.size, 3);
		assert.ok(!result.capabilities.has("before_agent_start"));
	});
});

test("Edge: solo adjust_tool_set mancante (before_agent_start + unit_start + GSD_VERSION ok) → D, reasons=[no_adjust_tool_set]", async () => {
	await withGSDVersion("1.15.0", () => {
		const api = createApiStub({ throwOn: ["adjust_tool_set"] });
		const result = classifyRuntime(api);

		assert.equal(result.tier, "D");
		assert.deepEqual([...result.reasons], ["no_adjust_tool_set"]);
	});
});

test("Edge: stub senza `api.on` (typeof guard) → tutti i probe false, tier D cumulativo", async () => {
	await withGSDVersion("1.15.0", () => {
		const api = createApiStub({ omitOn: true });
		const result = classifyRuntime(api);

		assert.equal(result.tier, "D");
		assert.deepEqual([...result.reasons], [
			"no_before_agent_start",
			"no_adjust_tool_set",
			"no_unit_start",
		]);
		assert.equal(result.capabilities.size, 0, "nessun hook probeabile senza `on`");
	});
});

test("Edge: safeProbe non propaga throw da `api.on` (niente eccezione esterna)", async () => {
	// Se `safeProbe` propagasse il throw, `classifyRuntime` lancerebbe — il
	// test semplicemente sarebbe fallito per TypeError invece che per asserzione.
	// Questo test difende esplicitamente la proprietà di "mai throw".
	await withGSDVersion("1.15.0", () => {
		const api = createApiStub({ throwOn: ["before_agent_start"] });

		let thrown: unknown = null;
		try {
			classifyRuntime(api);
		} catch (e) {
			thrown = e;
		}

		assert.equal(thrown, null, "classifyRuntime non deve propagare throw di api.on");
	});
});

test("Edge: doppia chiamata sullo stesso input → result identico (determinismo)", async () => {
	await withGSDVersion("1.15.0-dev.69075e6e", () => {
		const api = createApiStub(); // Tier F setup

		const first = classifyRuntime(api);
		const second = classifyRuntime(api);

		assert.equal(first.tier, second.tier);
		assert.deepEqual([...first.reasons], [...second.reasons]);
		assert.deepEqual([...first.capabilities], [...second.capabilities]);
		// Capabilities è un Set — due result distinti non devono essere la
		// stessa identità di Set, ma devono contenere gli stessi elementi.
		assert.notStrictEqual(first.capabilities, second.capabilities);
	});
});

test("Edge: doppia chiamata in Tier A con GSD_VERSION malformato → determinismo", async () => {
	await withGSDVersion("not-a-version", () => {
		// GSD_VERSION malformato → parsedSemver null → D con no_GSD_VERSION;
		// doppia chiamata deve restare identica (no caching, no side-effect).
		const api = createApiStub(); // tutti i 3 hook critici accettati
		const first = classifyRuntime(api);
		const second = classifyRuntime(api);

		assert.equal(first.tier, "D");
		assert.equal(second.tier, "D");
		assert.deepEqual([...first.reasons], [...second.reasons]);
		assert.deepEqual(
			[...first.reasons],
			["no_GSD_VERSION"],
			"env malformato è indistinguibile da env mancante: entrambi danno D + no_GSD_VERSION",
		);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// SEZIONE 4 — Invarianti di shape (immutabilità, purezza, no side-effect)
// ════════════════════════════════════════════════════════════════════════════

test("Shape: result.capabilities è congelato a livello JS (Object.isFrozen === true)", async () => {
	// L'implementazione chiama `Object.freeze(caps)` esplicitamente
	// (src/runtime-classifier.ts). La difesa type-level `ReadonlySet<CapabilityName>`
	// vieta `.add(...)` a compile-time; a runtime V8 il `Object.freeze` su un
	// Set è strutturale (impedisce nuove own-property) ma NON impedisce
	// l'inner-slot `[[SetData]]` da mutare via `.add()`. Quel secondo livello
	// è demandato al `ReadonlySet` type-contract (il chiamante non può
	// chiedere `.add` perché TS rifiuta la firma). Qui blindiamo la parte
	// che il modulo PUÒ garantire: il valore è un Set frozen come oggetto JS.
	await withGSDVersion("1.15.0", () => {
		const api = createApiStub();
		const { capabilities } = classifyRuntime(api);

		assert.ok(capabilities instanceof Set, "è un Set");
		assert.equal(Object.isFrozen(capabilities), true, "Object.freeze applicato");
		// Nota: la firma `.add()` è vietata a compile-time dal tipo
		// `ReadonlySet<CapabilityName>` (type-level guard); non asseriamo
		// `size` invariato a runtime perché V8 consente la mutazione interna
		// di un Set congelato (Object.freeze è strutturale, non previene
		// inner-slot mutation) — sarebbe un test flaky.
	});
});

test("Shape: result.reasons è array `readonly` congelato", async () => {
	await withGSDVersion("1.15.0", () => {
		const api = createApiStub();
		const { reasons } = classifyRuntime(api);

		assert.ok(Array.isArray(reasons));
		assert.equal(Object.isFrozen(reasons), true);
	});
});

test("Purity: classifyRuntime NON scrive su process.stderr", async () => {
	// Il modulo è dichiarato PURO in D085/R014: nessuno stderr, nessun
	// recordDegraded, nessun emitStructuredLog. Il side-effect Tier D vive
	// solo nel caller `index.ts:activate()`. Questo test difende
	// esplicitamente la proprietà al livello del classificatore: se in futuro
	// qualcuno aggiungesse un `process.stderr.write(...)` qui, il test
	// fallirà.
	await withGSDVersion(undefined, () => {
		const api = createApiStub({
			throwOn: ["before_agent_start", "adjust_tool_set", "unit_start"],
		});

		const { lines } = captureStderrSync(() => classifyRuntime(api));

		assert.deepEqual(
			lines,
			[],
			"classifyRuntime (modulo puro) non deve scrivere nulla su stderr",
		);
	});
});

test("Purity: classifyRuntime è sincrono (nessuna promise restituita)", () => {
	// Nessun await, nessuna promise. Verifica che la firma non cambi
	// inavvertitamente in futuro (es. per qualche side-effect iniettato).
	const api = createApiStub();
	const result = classifyRuntime(api);
	assert.equal(typeof (result as unknown), "object");
	// Se la firma cambiasse a `Promise<ClassifyRuntimeResult>`, `result` qui
	// sarebbe un thenable. Type-check difende la firma; questo test difende
	// la property runtime per coerenza.
	assert.equal(typeof (result as { then?: unknown }).then, "undefined");
});

test("Sanity: tolleranza di `GSD_VERSION` con suffissi varî preserva i numeri canonici", async () => {
	// Tabella dei formati reali osservati in M010-RESEARCH.md §3: la logica
	// del tier dipende SOLO dai numeri major/minor/patch. Suffissi prerelease
	// e build non alterano il fingerprint.
	await withGSDVersion("1.15.0-dev.69075e6e+exp.sha.5114f85", () => {
		const api = createApiStub();
		const result = classifyRuntime(api);
		assert.equal(result.tier, "F");
		assert.deepEqual([...result.reasons], []);
	});
});
