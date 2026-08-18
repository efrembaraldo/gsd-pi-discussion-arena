/**
 * Test unitario per `getCurrentUnitType(api)` (S01/M011, T01).
 *
 * Contratto locale del getter (definito in src/hooks-unit-aware.ts):
 *   - Pura, idempotente, zero side-effect.
 *   - Restituisce il unitType osservato dall'ultimo `unit_start` emesso
 *     sull'api (via singleton per-API `currentUnitTypeByApi`).
 *   - Fail-safe: api mai visto → "unknown"; nessun `unit_start` ancora
 *     arrivato → "unknown"; questo è il sentinella che la pipeline di
 *     index.ts (S01/T03) usa per NON scrivere pending-research spuria
 *     in Tier D o in test isolation.
 *
 * Source contract:
 *   src/hooks-unit-aware.ts (vedi export getCurrentUnitType).
 *   Slice S01/M011 — il getter è la detection layer che rende possibile
 *   cablare `discussion_arena.execute` alla pipeline research-decision.
 *
 * Test cases (5, in linea con research §T01 e gates Q7 negative tests):
 *   1. default "unknown" per api mai visto da `attachUnitAwareHooks`;
 *   2. lettura del valore dopo `unit_start` event simulato;
 *   3. idempotenza del getter (chiamate ripetute stesso valore);
 *   4. state machine: il getter riflette l'ULTIMO `unit_start`, non lo
 *      storico (transiziona: unknown → research-decision → planning);
 *   5. isolamento per-api: due api distinte hanno stato indipendente.
 *
 * Puro, nessun I/O subprocess. Usa lo stesso stub di ExtensionAPI di
 * tests/hooks-unit-aware.test.ts: dispatcher che invia ogni evento a
 * TUTTI gli handler come fa il framework reale.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
	attachUnitAwareHooks,
	getCurrentUnitType,
} from "../../src/hooks-unit-aware.js";
import {
	PLANNING_INSTRUCTION_MARKER,
	RESEARCH_INSTRUCTION_MARKER,
} from "../../src/markers.js";
import type { ResolveTriggerOutput } from "../../trigger-resolver.js";

const FORCED: ResolveTriggerOutput = {
	decision: "forced",
	source: "env",
	warnings: [],
	parseErrors: [],
	// v2 defaults (S01/M010): tier/capabilities/groupEligibility neutri.
	tier: "A",
	capabilities: new Set(),
	groupEligibility: null,
};

interface Dispatcher {
	handlers: Map<string, ((event: Record<string, unknown>) => unknown)[]>;
	emit: (eventName: string, payload: Record<string, unknown>) => void;
}

/** Stub di api.on() che accoda gli handler per evento (come il framework). */
function makeApi(
	handlers: Dispatcher["handlers"],
): (eventName: string, handler: (event: Record<string, unknown>) => unknown) => unknown {
	return (eventName: string, handler: (event: Record<string, unknown>) => unknown) => {
		const list = handlers.get(eventName) ?? [];
		list.push(handler);
		handlers.set(eventName, list);
		return {};
	};
}

/** Crea un dispatcher che inoltra ogni evento a tutti gli handler registrati. */
function createDispatcher(): Dispatcher {
	const handlers = new Map<
		string,
		((event: Record<string, unknown>) => unknown)[]
	>();
	function emit(eventName: string, payload: Record<string, unknown>): void {
		for (const handler of handlers.get(eventName) ?? []) {
			handler(payload);
		}
	}
	return { handlers, emit };
}

const ctxStub = { cwd: "/tmp/unit-aware-getter" } as never;

test("getCurrentUnitType: default 'unknown' per api mai visto (no attachUnitAwareHooks)", () => {
	// Oggetto fresco: la WeakMap `currentUnitTypeByApi` non lo contiene.
	const api = { on: makeApi(new Map()) };
	assert.equal(
		getCurrentUnitType(api as never),
		"unknown",
		"api senza attach deve esporre 'unknown' come fail-safe",
	);
});

test("getCurrentUnitType: legge il valore dopo unit_start simulato (research-decision)", () => {
	const d = createDispatcher();
	const api = { on: makeApi(d.handlers) };

	// Dopo attach, il singleton esiste ma vale ancora 'unknown' (nessun
	// unit_start ancora emesso).
	attachUnitAwareHooks(api as never, ctxStub, {
		activeUnitTypes: new Set(["research-decision"]),
		instructionMarker: RESEARCH_INSTRUCTION_MARKER,
		instructionText: "research instruction",
		resolveTrigger: FORCED,
	});
	assert.equal(
		getCurrentUnitType(api as never),
		"unknown",
		"dopo attach ma prima di unit_start, il valore è ancora 'unknown'",
	);

	// Emette unit_start — lo stateRef viene aggiornato dal listener.
	d.emit("unit_start", { unitType: "research-decision" });
	assert.equal(
		getCurrentUnitType(api as never),
		"research-decision",
		"getter deve riflettere l'unit_start più recente",
	);
});

test("getCurrentUnitType: idempotente — chiamate ripetute ritornano lo stesso valore", () => {
	const d = createDispatcher();
	const api = { on: makeApi(d.handlers) };
	attachUnitAwareHooks(api as never, ctxStub, {
		activeUnitTypes: new Set(["planning"]),
		instructionMarker: PLANNING_INSTRUCTION_MARKER,
		instructionText: "planning instruction",
		resolveTrigger: FORCED,
	});
	d.emit("unit_start", { unitType: "planning" });

	// 5 letture consecutive: tutte devono restituire 'planning' (no drift).
	const values = Array.from({ length: 5 }, () => getCurrentUnitType(api as never));
	assert.deepEqual(
		values,
		["planning", "planning", "planning", "planning", "planning"],
		"getter è una pura lettura, nessuna mutazione di stato",
	);
});

test("getCurrentUnitType: state machine — riflette l'ULTIMO unit_start, transizioni Osservate", () => {
	const d = createDispatcher();
	const api = { on: makeApi(d.handlers) };
	attachUnitAwareHooks(api as never, ctxStub, {
		activeUnitTypes: new Set(["research-decision"]),
		instructionMarker: RESEARCH_INSTRUCTION_MARKER,
		instructionText: "research instruction",
		resolveTrigger: FORCED,
	});

	// Sequenza: unknown → research-decision → planning → executing.
	// L'ultimo `unit_start` vince e il getter deve restituire SOLO quello.
	assert.equal(getCurrentUnitType(api as never), "unknown", "stato iniziale");

	d.emit("unit_start", { unitType: "research-decision" });
	assert.equal(
		getCurrentUnitType(api as never),
		"research-decision",
		"dopo research-decision, getter la riflette",
	);

	d.emit("unit_start", { unitType: "planning" });
	assert.equal(
		getCurrentUnitType(api as never),
		"planning",
		"transizione a planning: getter sovrascrive, no stack",
	);

	d.emit("unit_start", { unitType: "executing" });
	assert.equal(
		getCurrentUnitType(api as never),
		"executing",
		"transizione a executing: getter riflette l'ultimo unit_start",
	);
});

test("getCurrentUnitType: isolamento per-api — due api distinte hanno stato indipendente", () => {
	const dA = createDispatcher();
	const dB = createDispatcher();
	const apiA = { on: makeApi(dA.handlers) };
	const apiB = { on: makeApi(dB.handlers) };

	// Attach solo su apiA.
	attachUnitAwareHooks(apiA as never, ctxStub, {
		activeUnitTypes: new Set(["research-decision"]),
		instructionMarker: RESEARCH_INSTRUCTION_MARKER,
		instructionText: "research instruction",
		resolveTrigger: FORCED,
	});

	// apiA riceve un unit_start, apiB no.
	dA.emit("unit_start", { unitType: "research-decision" });

	assert.equal(
		getCurrentUnitType(apiA as never),
		"research-decision",
		"apiA ha lo stato visibile",
	);
	// apiB non è mai passato per attach → WeakMap non contiene la chiave →
	// fail-safe "unknown". Questo è il caso di test isolation / runtime
	// Tier D: due istanze di ExtensionAPI NON si contaminano.
	assert.equal(
		getCurrentUnitType(apiB as never),
		"unknown",
		"apiB isolata da apiA: nessuna contaminazione cross-api",
	);
});

test("getCurrentUnitType: ogni Seconda attach sullo stesso api riusa lo stateRef (D107)", () => {
	// Verifica che la registrazione multi-marker (planning + research) NON
	// crei un secondo stateRef: il getter continua a leggere l'unico
	// singleton per-API, anche dopo il secondo attach.
	const d = createDispatcher();
	const api = { on: makeApi(d.handlers) };

	attachUnitAwareHooks(api as never, ctxStub, {
		activeUnitTypes: new Set(["planning"]),
		instructionMarker: PLANNING_INSTRUCTION_MARKER,
		instructionText: "planning instruction",
		resolveTrigger: FORCED,
	});
	// Seconda attach con marker diverso: idempotenza di registrazione
	// fallisce (return false) ma NON deve reset stateRef.
	attachUnitAwareHooks(api as never, ctxStub, {
		activeUnitTypes: new Set(["research-decision"]),
		instructionMarker: RESEARCH_INSTRUCTION_MARKER,
		instructionText: "research instruction",
		resolveTrigger: FORCED,
	});

	// Entrambe le attach hanno chiamato lo stesso `stateRef` reused;
	// un unit_start emesso aggiorna UN singolo ref.
	d.emit("unit_start", { unitType: "research-decision" });
	assert.equal(
		getCurrentUnitType(api as never),
		"research-decision",
		"multi-marker NON resetta il singleton: stateRef condiviso",
	);
});
