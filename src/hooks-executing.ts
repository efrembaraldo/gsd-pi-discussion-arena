/**
 * src/hooks-executing.ts — Hook unit-aware per il gruppo discussion-arena
 * `executing` (M010/S02).
 *
 * Mirror di hooks-research-group.ts: registra i tre hook unit-aware
 * (unit_start, adjust_tool_set, before_agent_start) tramite il helper
 * condiviso attachUnitAwareHooks, con `activeUnitTypes` pari all'insieme
 * dei 4 unitType del gruppo `executing` (execute-task, reactive-execute,
 * run-uat, reassess-roadmap).
 *
 * Esporta attachExecutingHooks(api, ctx, resolveTrigger, stderr),
 * riusato da index.ts in activate() accanto agli altri 5 attach*Hooks.
 * Coesistenza con gli altri moduli hooks-*.ts garantita dall'idempotenza
 * per-marker della state machine `attachUnitAwareHooks` di S08-T01.
 *
 * Biiezione D102: `executing` → `executing` (fase canonica già referenzia
 * direttamente il gruppo).
 */

import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";
import type { ResolveTriggerOutput } from "../trigger-resolver.js";
import { attachUnitAwareHooks } from "./hooks-unit-aware.js";
import { ACTIVE_UNIT_TYPES } from "./phase-mapping.js";
import { EXECUTING_INSTRUCTION_MARKER } from "./markers.js";

/** Testo istruzione per il gruppo `executing` (iniettato dopo il marker). */
const EXECUTING_INSTRUCTION =
	"Usa discussion_arena prima di eseguire il task se il rischio è non banale";

/**
 * Registra gli hook unit-aware per il gruppo `executing` (4 unitType).
 *
 * @param api ExtensionAPI da activate(api)
 * @param ctx ExtensionContext (in avanti per coerenza API)
 * @param resolveTrigger ResolveTriggerOutput risolto da S05-T01
 * @param stderr Sink opzionale per il log strutturato su unit_start
 */
export function attachExecutingHooks(
	api: ExtensionAPI,
	ctx: ExtensionContext,
	resolveTrigger: ResolveTriggerOutput,
	stderr?: NodeJS.WritableStream,
): boolean {
	return attachUnitAwareHooks(api, ctx, {
		activeUnitTypes: ACTIVE_UNIT_TYPES.executing,
		instructionMarker: EXECUTING_INSTRUCTION_MARKER,
		instructionText: EXECUTING_INSTRUCTION,
		resolveTrigger,
		stderr,
	});
}
