/**
 * src/hooks-verifying.ts — Hook unit-aware per il gruppo arena
 * `verifying` (M010/S02).
 *
 * Mirror di hooks-research-group.ts: registra i tre hook unit-aware
 * (unit_start, adjust_tool_set, before_agent_start) tramite il helper
 * condiviso attachUnitAwareHooks, con `activeUnitTypes` pari all'insieme
 * dei 3 unitType del gruppo `verifying` (validate-milestone,
 * complete-milestone, complete-slice).
 *
 * Esporta attachVerifyingHooks(api, ctx, resolveTrigger, stderr),
 * riusato da index.ts in activate() accanto agli altri 5 attach*Hooks.
 * Coesistenza con gli altri moduli hooks-*.ts garantita dall'idempotenza
 * per-marker della state machine `attachUnitAwareHooks` di S08-T01.
 *
 * Biiezione D102: `verifying` → `verifying` (fase canonica già referenzia
 * direttamente il gruppo).
 */

import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";
import type { ResolveTriggerOutput } from "../trigger-resolver.js";
import { attachUnitAwareHooks } from "./hooks-unit-aware.js";
import { ACTIVE_UNIT_TYPES } from "./phase-mapping.js";
import { VERIFYING_INSTRUCTION_MARKER } from "./markers.js";

/** Testo istruzione per il gruppo `verifying` (iniettato dopo il marker). */
const VERIFYING_INSTRUCTION =
	"Usa discussion_arena prima di convalidare il milestone";

/**
 * Registra gli hook unit-aware per il gruppo `verifying` (3 unitType).
 *
 * @param api ExtensionAPI da activate(api)
 * @param ctx ExtensionContext (in avanti per coerenza API)
 * @param resolveTrigger ResolveTriggerOutput risolto da S05-T01
 * @param stderr Sink opzionale per il log strutturato su unit_start
 */
export function attachVerifyingHooks(
	api: ExtensionAPI,
	ctx: ExtensionContext,
	resolveTrigger: ResolveTriggerOutput,
	stderr?: NodeJS.WritableStream,
): boolean {
	return attachUnitAwareHooks(api, ctx, {
		activeUnitTypes: ACTIVE_UNIT_TYPES.verifying,
		instructionMarker: VERIFYING_INSTRUCTION_MARKER,
		instructionText: VERIFYING_INSTRUCTION,
		resolveTrigger,
		stderr,
	});
}
