/**
 * src/hooks-discussing.ts — Hook unit-aware per il gruppo discussion-arena
 * `discussing` (M010/S02).
 *
 * Mirror di hooks-research-group.ts: registra i tre hook unit-aware
 * (unit_start, adjust_tool_set, before_agent_start) tramite il helper
 * condiviso attachUnitAwareHooks, con `activeUnitTypes` pari all'insieme
 * dei 3 unitType del gruppo `discussing` (discuss-milestone,
 * discuss-project, discuss-requirements).
 *
 * Esporta attachDiscussingHooks(api, ctx, resolveTrigger, stderr),
 * riusato da index.ts in activate() accanto a attachDiscussionArenaHooks,
 * attachResearchDecisionHooks e attachResearchGroupHooks. Coesistenza
 * con gli altri 5 moduli hooks-*.ts garantita dall'idempotenza per-marker
 * della state machine `attachUnitAwareHooks` di S08-T01.
 *
 * Biiezione D102: `discussing` → `discussing` (primo gruppo con la fase
 * canonica che lo referenza direttamente).
 */

import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";
import type { ResolveTriggerOutput } from "../trigger-resolver.js";
import { attachUnitAwareHooks } from "./hooks-unit-aware.js";
import { ACTIVE_UNIT_TYPES } from "./phase-mapping.js";
import { DISCUSSING_INSTRUCTION_MARKER } from "./markers.js";

/** Testo istruzione per il gruppo `discussing` (iniettato dopo il marker). */
const DISCUSSING_INSTRUCTION =
	"Usa discussion_arena prima di deliberare sui requisiti del progetto";

/**
 * Registra gli hook unit-aware per il gruppo `discussing` (3 unitType).
 *
 * @param api ExtensionAPI da activate(api)
 * @param ctx ExtensionContext (in avanti per coerenza API)
 * @param resolveTrigger ResolveTriggerOutput risolto da S05-T01
 * @param stderr Sink opzionale per il log strutturato su unit_start
 */
export function attachDiscussingHooks(
	api: ExtensionAPI,
	ctx: ExtensionContext,
	resolveTrigger: ResolveTriggerOutput,
	stderr?: NodeJS.WritableStream,
): boolean {
	return attachUnitAwareHooks(api, ctx, {
		activeUnitTypes: ACTIVE_UNIT_TYPES.discussing,
		instructionMarker: DISCUSSING_INSTRUCTION_MARKER,
		instructionText: DISCUSSING_INSTRUCTION,
		resolveTrigger,
		stderr,
	});
}
