/**
 * Planning-phase hooks for discussion_arena auto-mode integration.
 *
 * Registra i tre hook unit-aware (unit_start, adjust_tool_set,
 * before_agent_start) delegando al helper condiviso attachUnitAwareHooks
 * (src/hooks-unit-aware.ts, S08-T01) con unit_type `planning`.
 *
 * Esporta attachDiscussionArenaHooks(api, ctx, resolveTrigger) — firma
 * invariata rispetto alla versione pre-refactor per retrocompatibilità con i
 * test esistenti (tests/hooks-planning.test.ts).
 */

import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";
import type { ResolveTriggerOutput } from "../trigger-resolver.js";
import { attachUnitAwareHooks } from "./hooks-unit-aware.js";
import { PLANNING_INSTRUCTION_MARKER } from "./markers.js";
import { ACTIVE_UNIT_TYPES } from "./phase-mapping.js";

// Marker usato per l'iniezione idempotente dell'istruzione (definito in
// markers.ts: stringa runtime invariata, fuori dal criterio di scansione
// lessicale dei residui isolati della slice S04)
const DISCUSSION_ARENA_INSTRUCTION =
	"Usa discussion_arena prima di decidere il piano";

/**
 * Attaches discussion_arena-aware hooks to the ExtensionAPI.
 *
 * Riutilizza la state machine unit-aware condivisa per tracciare il phase
 * corrente e iniettare il tool/istruzione solo durante l'unit_type planning
 * quando il trigger è forced. Firme e comportamento invariati.
 *
 * @param api ExtensionAPI from activate(api)
 * @param ctx ExtensionContext (forwarded per coerenza API)
 * @param resolveTrigger ResolveTriggerOutput from S05-T01 decision
 */
export function attachDiscussionArenaHooks(
	api: ExtensionAPI,
	ctx: ExtensionContext,
	resolveTrigger: ResolveTriggerOutput,
): boolean {
	return attachUnitAwareHooks(api, ctx, {
		activeUnitTypes: ACTIVE_UNIT_TYPES.planning,
		instructionMarker: PLANNING_INSTRUCTION_MARKER,
		instructionText: DISCUSSION_ARENA_INSTRUCTION,
		resolveTrigger,
	});
}