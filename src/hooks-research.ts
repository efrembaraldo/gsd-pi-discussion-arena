/**
 * src/hooks-research.ts — Hook unit-aware per la fase adr/research.
 *
 * Mirror di hooks-planning.ts (S08-T01): registra i tre hook unit-aware
 * (unit_start, adjust_tool_set, before_agent_start) tramite il helper
 * condiviso attachUnitAwareHooks, limitando l'iniezione del tool
 * discussion_arena + dell'istruzione all'unit_type `research-decision`.
 *
 * Esporta attachResearchDecisionHooks(api, ctx, resolveTrigger, stderr),
 * riusato da index.ts in activate() accanto a attachDiscussionArenaHooks.
 */

import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";
import type { ResolveTriggerOutput } from "../trigger-resolver.js";
import { attachUnitAwareHooks } from "./hooks-unit-aware.js";
import { RESEARCH_INSTRUCTION_MARKER } from "./markers.js";
import { ACTIVE_UNIT_TYPES } from "./phase-mapping.js";

/** Testo istruzione per l'unit_type research-decision (iniettato dopo il
 * marker nel systemPrompt). */
const RESEARCH_INSTRUCTION =
	"Usa discussion_arena prima di decidere l'approccio di ricerca";

/**
 * Registra gli hook unit-aware per la fase research-decision.
 *
 * @param api ExtensionAPI da activate(api)
 * @param ctx ExtensionContext (in avanti per coerenza API)
 * @param resolveTrigger ResolveTriggerOutput risolto da S05-T01
 * @param stderr Sink opzionale per il log strutturato su unit_start
 */
export function attachResearchDecisionHooks(
	api: ExtensionAPI,
	ctx: ExtensionContext,
	resolveTrigger: ResolveTriggerOutput,
	stderr?: NodeJS.WritableStream,
): boolean {
	return attachUnitAwareHooks(api, ctx, {
		activeUnitTypes: ACTIVE_UNIT_TYPES["research-decision"],
		instructionMarker: RESEARCH_INSTRUCTION_MARKER,
		instructionText: RESEARCH_INSTRUCTION,
		resolveTrigger,
		stderr,
	});
}