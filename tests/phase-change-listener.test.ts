/**
 * Unit tests for src/hooks-unit-aware.ts — I3 listener phase_change (#1999) +
 * I5 tier transitions al confine ACTIVE_PHASES (S05/T2, M019, R066/R068/R070).
 *
 * Contratto verificato:
 *   - Registrazione INCONDIZIONATA del listener `api.on("phase_change", ...)`
 *     ONCE per api (guard WeakMap `phaseChangeListenerByApi`, pattern
 *     tool_call S02), wrapped in try/catch — MAI probe/detection (R076).
 *   - Gate semver NEL handler (`hostFeatures.phaseChangeEvent`): su host
 *     ≤ 1.20.x / env-assente il listener è un NO-OP silenzioso — nessun
 *     update di `getCurrentPhase`, nessun counter (polling snapshot
 *     invariato).
 *   - I3 (R068, event-driven lazy): ogni transizione (activate/set/clear/
 *     deactivate, incluso ritorno a null) aggiorna lo stato per-api
 *     `phaseStateByApi`; `getCurrentPhase(api)` ritorna lo stato evento
 *     quando `sawEvent === true`, altrimenti il fallback polling
 *     `getRuntimePhaseSync(api)`.
 *   - I5 (R070): `discussion_arena_phase_transitions_total{from,to}` per
 *     OGNI transizione (dominio CHIUSO via normalizePhaseLabel: 18 fasi +
 *     "none" + "unknown"); `discussion_arena_tier_transitions_total{from,to}`
 *     SOLO al confine di ACTIVE_PHASES (G→F ingresso / F→G uscita) con riga
 *     stderr `${LOG_PREFIX} tier transition G → F (phase=<X>)` (o F→G).
 *     NESSUNA mutazione di toolset/systemPrompt/isActive (nessun nuovo
 *     meccanismo di forzatura).
 *
 * Harness: Dispatcher Map+emit (pattern tests/hooks-unit-aware.test.ts,
 * stub plain `{ on }` SENZA getPhase salvo i test espliciti sul fallback
 * polling, dove lo stub è `{ on, getPhase: () => Phase }`). Ogni test
 * fingerprint-dipendente è avvolto in `withGSDVersion` (pattern
 * tests/runtime-classifier.test.ts / tests/dispatch-context.test.ts,
 * anti-leak MEM387).
 *
 * Puro, nessun I/O subprocess. `resetMetrics()` per isolare il registry
 * metrico singleton (pattern metrics.test.ts / hooks-unit-aware.test.ts).
 */

import { beforeEach, test } from "node:test";
import * as assert from "node:assert/strict";
import {
	attachUnitAwareHooks,
	getCurrentPhase,
} from "../src/hooks-unit-aware.js";
import {
	PLANNING_INSTRUCTION_MARKER,
	RESEARCH_INSTRUCTION_MARKER,
} from "../src/markers.js";
import { ACTIVE_PHASES, KNOWN_PHASES } from "../src/phase-mapping.js";
import { getMetrics, resetMetrics } from "../src/metrics.js";
import { LOG_PREFIX } from "../src/log-prefix.js";
import type { ResolveTriggerOutput } from "../trigger-resolver.js";

// Isolamento del registry metrico singleton (pattern identico a
// hooks-unit-aware.test.ts).
beforeEach(() => {
	resetMetrics();
});

/**
 * Setta `process.env.GSD_VERSION` per la durata di `fn` e ripristina il
 * valore precedente (anche se `fn` lancia). Pattern copiato da
 * tests/dispatch-context.test.ts (riferimento, non modificato) — anti-leak
 * MEM387: nessun test dipendente dal fingerprint lascia l'env sporco.
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

/** Variante sincrona di cattura stderr (pattern hooks-unit-aware.test.ts). */
function captureStderrChunksSync(fn: () => void): string[] {
	const original = process.stderr.write.bind(process.stderr);
	const chunks: string[] = [];
	process.stderr.write = ((chunk: unknown) => {
		chunks.push(String(chunk));
		return true;
	}) as unknown as typeof process.stderr.write;
	try {
		fn();
		return chunks;
	} finally {
		process.stderr.write = original;
	}
}

const FORCED: ResolveTriggerOutput = {
	decision: "forced",
	source: "env",
	warnings: [],
	parseErrors: [],
	tier: "A",
	capabilities: new Set(),
	groupEligibility: null,
};

const PLANNING_INSTRUCTION = "Usa discussion_arena prima di decidere il piano";
const RESEARCH_INSTRUCTION =
	"Usa discussion_arena prima di decidere l'approccio di ricerca";

interface PhaseDispatcher {
	handlers: Map<string, ((event: Record<string, unknown>) => unknown)[]>;
	emit: (eventName: string, payload: Record<string, unknown>) => void;
}

/** Stub di api.on() che accoda gli handler per evento (come il framework). */
function makeApi(
	handlers: PhaseDispatcher["handlers"],
): (
	eventName: string,
	handler: (event: Record<string, unknown>) => unknown,
) => unknown {
	return (
		eventName: string,
		handler: (event: Record<string, unknown>) => unknown,
	) => {
		const list = handlers.get(eventName) ?? [];
		list.push(handler);
		handlers.set(eventName, list);
		return {};
	};
}

/** Dispatcher minimale: inoltra ogni evento a TUTTI gli handler registrati. */
function createDispatcher(): PhaseDispatcher {
	const handlers = new Map<
		string,
		((event: Record<string, unknown>) => unknown)[]
	>();
	return {
		handlers,
		emit(eventName, payload) {
			for (const handler of handlers.get(eventName) ?? []) {
				handler(payload);
			}
		},
	};
}

/** Attach canonico del test: opzioni unit-aware con stderr = process.stderr
 *  così captureStderrChunksSync intercetta anche le righe di tier transition
 *  (che usano `options.stderr?.write`, non emitStructuredLog). */
function attach(api: unknown): void {
	attachUnitAwareHooks(api as never, { cwd: "/tmp/phase-change" } as never, {
		activeUnitTypes: new Set(["planning"]),
		instructionMarker: PLANNING_INSTRUCTION_MARKER,
		instructionText: PLANNING_INSTRUCTION,
		resolveTrigger: FORCED,
		stderr: process.stderr,
	});
}

// ─── I5: counter phase_transitions + tier_transitions su feature host ────────

test("feature host 1.21.0 — activate null→planning: phase counter {from=none,to=planning} + tier G→F + log", async () => {
	await withGSDVersion("1.21.0", () => {
		const d = createDispatcher();
		const api = { on: makeApi(d.handlers) };
		attach(api);

		const chunks = captureStderrChunksSync(() => {
			d.emit("phase_change", { previousPhase: null, currentPhase: "planning" });
		});

		// (a) counter phase_transitions (null → "none").
		const phase = getMetrics().counters[
			"discussion_arena_phase_transitions_total"
		] ?? {};
		assert.equal(
			phase["{from=none,to=planning}"],
			1,
			"phase_transitions_total{from=none,to=planning} = 1 dopo activate",
		);
		// (b) counter tier al confine: null (fuori) → planning (dentro) = G→F.
		const tier = getMetrics().counters[
			"discussion_arena_tier_transitions_total"
		] ?? {};
		assert.equal(
			tier["{from=G,to=F}"],
			1,
			"tier_transitions_total{from=G,to=F} = 1 dopo ingresso in fase attiva",
		);
		assert.equal(
			tier["{from=F,to=G}"],
			undefined,
			"nessuna serie F→G per un ingresso G→F",
		);
		// (c) log stderr con formato canonico G→F.
		assert.ok(
			chunks.some(
				(c) => c === `${LOG_PREFIX} tier transition G → F (phase=planning)\n`,
			),
			`riga log G→F attesa, ottenuto: ${JSON.stringify(chunks)}`,
		);
	});
});

test("feature host 1.21.0 — set planning→executing (entrambe attive): SOLO phase counter, niente tier/log", async () => {
	await withGSDVersion("1.21.0", () => {
		const d = createDispatcher();
		const api = { on: makeApi(d.handlers) };
		attach(api);

		const chunks = captureStderrChunksSync(() => {
			d.emit("phase_change", {
				previousPhase: "planning",
				currentPhase: "executing",
			});
		});

		const phase = getMetrics().counters[
			"discussion_arena_phase_transitions_total"
		] ?? {};
		assert.equal(
			phase["{from=planning,to=executing}"],
			1,
			"phase_transitions_total{from=planning,to=executing} = 1",
		);
		// Transizione F→F interna al confine: NESSUN tier counter, NESSUN log.
		assert.equal(
			getMetrics().counters["discussion_arena_tier_transitions_total"],
			undefined,
			"nessun tier_transitions per transizione planning→executing (entrambe ∈ ACTIVE_PHASES)",
		);
		assert.equal(
			chunks.filter((c) => c.includes("tier transition")).length,
			0,
			"nessuna riga 'tier transition' per transizione interna al confine",
		);
	});
});

test("feature host 1.21.0 — deactivate executing→null: tier F→G + log (phase=none)", async () => {
	await withGSDVersion("1.21.0", () => {
		const d = createDispatcher();
		const api = { on: makeApi(d.handlers) };
		attach(api);

		const chunks = captureStderrChunksSync(() => {
			d.emit("phase_change", { previousPhase: "executing", currentPhase: null });
		});

		const phase = getMetrics().counters[
			"discussion_arena_phase_transitions_total"
		] ?? {};
		assert.equal(
			phase["{from=executing,to=none}"],
			1,
			"phase_transitions_total{from=executing,to=none} = 1 (ritorno a null incluso)",
		);
		const tier = getMetrics().counters[
			"discussion_arena_tier_transitions_total"
		] ?? {};
		assert.equal(
			tier["{from=F,to=G}"],
			1,
			"tier_transitions_total{from=F,to=G} = 1 dopo uscita da fase attiva",
		);
		assert.ok(
			chunks.some(
				(c) => c === `${LOG_PREFIX} tier transition F → G (phase=none)\n`,
			),
			`riga log F→G attesa, ottenuto: ${JSON.stringify(chunks)}`,
		);
	});
});

test("feature host 1.21.0 — deactivate executing→paused (fase non attiva): tier F→G + log (phase=paused)", async () => {
	await withGSDVersion("1.21.0", () => {
		const d = createDispatcher();
		const api = { on: makeApi(d.handlers) };
		attach(api);

		const chunks = captureStderrChunksSync(() => {
			d.emit("phase_change", {
				previousPhase: "executing",
				currentPhase: "paused",
			});
		});

		const phase = getMetrics().counters[
			"discussion_arena_phase_transitions_total"
		] ?? {};
		assert.equal(
			phase["{from=executing,to=paused}"],
			1,
			"phase_transitions_total{from=executing,to=paused} = 1",
		);
		const tier = getMetrics().counters[
			"discussion_arena_tier_transitions_total"
		] ?? {};
		assert.equal(
			tier["{from=F,to=G}"],
			1,
			"tier_transitions_total{from=F,to=G} = 1 (paused ∉ ACTIVE_PHASES)",
		);
		assert.ok(
			chunks.some(
				(c) => c === `${LOG_PREFIX} tier transition F → G (phase=paused)\n`,
			),
			`riga log F→G attesa, ottenuto: ${JSON.stringify(chunks)}`,
		);
	});
});

test("feature host 1.21.0 — stringa fase sconosciuta: coerce {to=unknown}, label 'bogus' ASSENTE dal dominio", async () => {
	await withGSDVersion("1.21.0", () => {
		const d = createDispatcher();
		const api = { on: makeApi(d.handlers) };
		attach(api);

		captureStderrChunksSync(() => {
			d.emit("phase_change", {
				previousPhase: "planning",
				currentPhase: "bogus",
			});
		});

		const phase = getMetrics().counters[
			"discussion_arena_phase_transitions_total"
		] ?? {};
		assert.equal(
			phase["{from=planning,to=unknown}"],
			1,
			"fase non canonica normalizzata a 'unknown' (dominio chiuso)",
		);
		// Chiusura: la stringa raw non compare in NESSUNA serie di NESSUNA metrica.
		const snapshot = JSON.stringify(getMetrics());
		assert.ok(
			!snapshot.includes("bogus"),
			"la label raw 'bogus' non deve apparire in getMetrics()",
		);
	});
});

test("feature host 1.21.0 — chiusura dominio: ogni from/to ∈ {18 fasi, none, unknown}", async () => {
	await withGSDVersion("1.21.0", () => {
		const d = createDispatcher();
		const api = { on: makeApi(d.handlers) };
		attach(api);

		const transitions: [string | null, string | null][] = [
			[null, "planning"],
			["planning", "executing"],
			["executing", null],
			[null, "paused"],
			["paused", "mysterious-future-phase"],
			["mysterious-future-phase", ""],
			["", "discussing"],
			["discussing", "bogus"],
		];
		captureStderrChunksSync(() => {
			for (const [from, to] of transitions) {
				d.emit("phase_change", { previousPhase: from, currentPhase: to });
			}
		});

		const series = getMetrics().counters[
			"discussion_arena_phase_transitions_total"
		] ?? {};
		const keys = Object.keys(series);
		assert.ok(keys.length > 0, "almeno una serie registrata");
		assert.equal(
			keys.reduce((sum, k) => sum + series[k]!, 0),
			transitions.length,
			"ogni transizione emessa produce esattamente un incremento",
		);
		const domain = new Set<string>([...KNOWN_PHASES, "none", "unknown"]);
		assert.equal(
			domain.size,
			20,
			"dominio chiuso: 18 fasi note + none + unknown",
		);
		for (const key of keys) {
			const match = key.match(/^\{from=([^,]*),to=([^}]*)\}$/);
			assert.ok(match, `chiave serie malformata: ${key}`);
			assert.ok(
				domain.has(match[1]!),
				`label from fuori dominio: ${match[1]}`,
			);
			assert.ok(domain.has(match[2]!), `label to fuori dominio: ${match[2]}`);
		}
	});
});

// ─── Host legacy / env-assente: listener registrato ma NO-OP silenzioso ──────

test("legacy 1.20.1 — emit phase_change: nessun update getCurrentPhase (resta polling), getMetrics SENZA i 2 counter", async () => {
	await withGSDVersion("1.20.1", () => {
		const d = createDispatcher();
		// Stub con getPhase: senza eventi il getter ricade sul polling.
		const api = { on: makeApi(d.handlers), getPhase: () => "paused" };
		attach(api);

		d.emit("phase_change", {
			previousPhase: "planning",
			currentPhase: "executing",
		});

		// getCurrentPhase NON deve aver visto l'evento: resta la fonte polling.
		assert.equal(
			getCurrentPhase(api as never),
			"paused",
			"su host legacy l'evento non aggiorna lo stato: getCurrentPhase resta sul polling",
		);
		const metrics = getMetrics();
		assert.equal(
			metrics.counters["discussion_arena_phase_transitions_total"],
			undefined,
			"nessun counter phase_transitions su host legacy",
		);
		assert.equal(
			metrics.counters["discussion_arena_tier_transitions_total"],
			undefined,
			"nessun counter tier_transitions su host legacy",
		);
	});
});

test("env-assente — emit phase_change: stesso no-op silenzioso di legacy", async () => {
	await withGSDVersion(undefined, () => {
		const d = createDispatcher();
		const api = { on: makeApi(d.handlers), getPhase: () => "planning" };
		attach(api);

		d.emit("phase_change", {
			previousPhase: null,
			currentPhase: "executing",
		});

		assert.equal(
			getCurrentPhase(api as never),
			"planning",
			"senza fingerprint l'evento non aggiorna lo stato (gate semver nel handler)",
		);
		const metrics = getMetrics();
		assert.equal(
			metrics.counters["discussion_arena_phase_transitions_total"],
			undefined,
			"nessun counter phase_transitions senza GSD_VERSION",
		);
		assert.equal(
			metrics.counters["discussion_arena_tier_transitions_total"],
			undefined,
			"nessun counter tier_transitions senza GSD_VERSION",
		);
	});
});

// ─── I3: getCurrentPhase event-driven lazy con fallback polling ──────────────

test("fallback polling — senza eventi getCurrentPhase=planning (getPhase); dopo phase_change executing → 'executing' (evento vince)", async () => {
	await withGSDVersion("1.21.0", () => {
		const d = createDispatcher();
		const api = { on: makeApi(d.handlers), getPhase: () => "planning" };
		attach(api);

		// Prima del primo evento: fallback polling (event-driven lazy R068).
		assert.equal(
			getCurrentPhase(api as never),
			"planning",
			"prima del primo evento getCurrentPhase usa il fallback polling getRuntimePhaseSync",
		);

		d.emit("phase_change", {
			previousPhase: "planning",
			currentPhase: "executing",
		});

		// Dopo il primo evento: lo stato event-driven vince sul polling.
		assert.equal(
			getCurrentPhase(api as never),
			"executing",
			"dopo il primo evento getCurrentPhase ritorna lo stato event-driven (evento vince sul polling)",
		);
	});
});

test("event-driven lazy — ritorno a null (clear/deactivate): getCurrentPhase=null anche se il polling direbbe altro", async () => {
	await withGSDVersion("1.21.0", () => {
		const d = createDispatcher();
		const api = { on: makeApi(d.handlers), getPhase: () => "planning" };
		attach(api);

		captureStderrChunksSync(() => {
			d.emit("phase_change", {
				previousPhase: "executing",
				currentPhase: null,
			});
		});

		assert.equal(
			getCurrentPhase(api as never),
			null,
			"il ritorno a null dell'evento vince sul polling 'planning' (I3 incluso clear/deactivate)",
		);
	});
});

test("getCurrentPhase su api sconosciuta (mai attach) → null, senza lanciare", () => {
	assert.equal(
		getCurrentPhase({} as never),
		null,
		"api sconosciuta: fallback polling su stub plain → null (fail-safe D019)",
	);
	assert.equal(getCurrentPhase(null as never), null);
	assert.equal(getCurrentPhase(undefined as never), null);
});

// ─── Idempotenza di registrazione (guard WeakMap per-api, pattern S02) ───────

test("idempotenza — 2 attachUnitAwareHooks (marker diversi) → esattamente 1 handler phase_change e 1 incremento per evento", async () => {
	await withGSDVersion("1.21.0", () => {
		const d = createDispatcher();
		const api = { on: makeApi(d.handlers) };
		const ctxStub = { cwd: "/tmp/phase-change" } as never;

		const first = attachUnitAwareHooks(api as never, ctxStub, {
			activeUnitTypes: new Set(["planning"]),
			instructionMarker: PLANNING_INSTRUCTION_MARKER,
			instructionText: PLANNING_INSTRUCTION,
			resolveTrigger: FORCED,
			stderr: process.stderr,
		});
		const second = attachUnitAwareHooks(api as never, ctxStub, {
			activeUnitTypes: new Set(["research-decision"]),
			instructionMarker: RESEARCH_INSTRUCTION_MARKER,
			instructionText: RESEARCH_INSTRUCTION,
			resolveTrigger: FORCED,
			stderr: process.stderr,
		});
		assert.equal(first, true, "prima registrazione: true");
		assert.equal(second, true, "marker diverso: registra anche");

		assert.equal(
			(d.handlers.get("phase_change") ?? []).length,
			1,
			"esattamente 1 handler phase_change registrato sul dispatcher (guard per-api)",
		);

		captureStderrChunksSync(() => {
			d.emit("phase_change", {
				previousPhase: null,
				currentPhase: "planning",
			});
		});
		const phase = getMetrics().counters[
			"discussion_arena_phase_transitions_total"
		] ?? {};
		assert.equal(
			phase["{from=none,to=planning}"],
			1,
			"multi-marker setup: UN solo incremento per evento (no over-count)",
		);
	});
});

test("idempotenza — ri-attach con lo stesso marker (no-op) NON duplica l'handler phase_change", async () => {
	await withGSDVersion("1.21.0", () => {
		const d = createDispatcher();
		const api = { on: makeApi(d.handlers) };
		const ctxStub = { cwd: "/tmp/phase-change" } as never;

		attachUnitAwareHooks(api as never, ctxStub, {
			activeUnitTypes: new Set(["planning"]),
			instructionMarker: PLANNING_INSTRUCTION_MARKER,
			instructionText: PLANNING_INSTRUCTION,
			resolveTrigger: FORCED,
		});
		const noop = attachUnitAwareHooks(api as never, ctxStub, {
			activeUnitTypes: new Set(["planning"]),
			instructionMarker: PLANNING_INSTRUCTION_MARKER,
			instructionText: PLANNING_INSTRUCTION,
			resolveTrigger: FORCED,
		});
		assert.equal(noop, false, "ri-registrazione stesso marker: no-op");

		assert.equal(
			(d.handlers.get("phase_change") ?? []).length,
			1,
			"no-op di registrazione non duplica il listener phase_change",
		);
	});
});

// ─── R070: il listener NON muta toolset né systemPrompt (nessun forcing) ─────

test("R070 — l'handler phase_change non muta toolset né systemPrompt (nessun nuovo meccanismo di forzatura)", async () => {
	await withGSDVersion("1.21.0", () => {
		const d = createDispatcher();
		const api = { on: makeApi(d.handlers) };
		attach(api);

		// Il payload di phase_change viaggia solo verso l'handler osservatore:
		// nessun handler registra un ritorno mutabile per questo evento.
		const results: unknown[] = [];
		captureStderrChunksSync(() => {
			for (const handler of d.handlers.get("phase_change") ?? []) {
				results.push(
					handler({ previousPhase: null, currentPhase: "planning" }),
				);
			}
		});
		assert.ok(
			results.every((r) => r === undefined),
			"l'handler phase_change ritorna undefined: nessuna mutazione di toolset/systemPrompt (R070)",
		);
	});
});

// ─── Coesistenza con i 4 hook esistenti (niente regressioni di registrazione) ─

test("coesistenza — attach registra i 4 hook esistenti + phase_change, ciascuno una volta", async () => {
	await withGSDVersion("1.21.0", () => {
		const d = createDispatcher();
		const api = { on: makeApi(d.handlers) };
		attach(api);

		assert.equal((d.handlers.get("unit_start") ?? []).length, 1);
		assert.equal((d.handlers.get("adjust_tool_set") ?? []).length, 1);
		assert.equal((d.handlers.get("before_agent_start") ?? []).length, 1);
		assert.equal((d.handlers.get("tool_call") ?? []).length, 1);
		assert.equal((d.handlers.get("phase_change") ?? []).length, 1);
	});
});

// Guardia di import: ACTIVE_PHASES è la superficie canonica del confine
// usato dall'handler (documentazione esecutiva); KNOWN_PHASES alimenta la
// chiusura del dominio nel test di dominio chiuso.
void ACTIVE_PHASES;
