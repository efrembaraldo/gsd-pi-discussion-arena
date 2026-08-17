/**
 * src/hooks-research-group.ts — Hook unit-aware per il gruppo arena
 * `research` (M010/S02).
 *
 * Mirror di hooks-research.ts (gruppo `research-decision`): registra i tre
 * hook unit-aware (unit_start, adjust_tool_set, before_agent_start) tramite
 * il helper condiviso attachUnitAwareHooks, ma con `activeUnitTypes` pari
 * all'insieme dei 3 unitType del gruppo `research` (research-milestone,
 * research-project, research-slice) — NON al singolo unitType
 * `research-decision`, gestito da hooks-research.ts.
 *
 * Esporta attachResearchGroupHooks(api, ctx, resolveTrigger, stderr),
 * riusato da index.ts in activate() accanto a attachResearchDecisionHooks
 * e attachDiscussionArenaHooks. I due gruppi (`research-decision` e
 * `research`) coesistono nello stesso api perché hanno marker distinti
 * (RESEARCH_INSTRUCTION_MARKER vs RESEARCH_GROUP_INSTRUCTION_MARKER) e la
 * state machine `attachUnitAwareHooks` di S08-T01 è idempotente per-marker.
 *
 * Biiezione D102: `refining` → `research` (fase grigia, appoggio per non
 * ri-mappare `researching` che è già legata a `research-decision`).
 */

import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";
import type { ResolveTriggerOutput } from "../trigger-resolver.js";
import { attachUnitAwareHooks } from "./hooks-unit-aware.js";
import { ACTIVE_UNIT_TYPES } from "./phase-mapping.js";
import { RESEARCH_GROUP_INSTRUCTION_MARKER } from "./markers.js";

/** Testo istruzione per il gruppo `research` (iniettato dopo il marker). */
const RESEARCH_GROUP_INSTRUCTION =
	"Usa discussion_arena prima di decidere l'approccio di ricerca (milestone/project/slice)";

/**
 * Registra gli hook unit-aware per il gruppo `research` (3 unitType).
 *
 * Precondizione: ACTIVE_UNIT_TYPES["research"] è definito (D102) — l'assert
 * non runtime difende da un futuro refactor che dovesse rinominare il gruppo
 * (in tal caso l'errore di tipo TypeScript blocca la build).
 *
 * @param api ExtensionAPI da activate(api)
 * @param ctx ExtensionContext (in avanti per coerenza API)
 * @param resolveTrigger ResolveTriggerOutput risolto da S05-T01
 * @param stderr Sink opzionale per il log strutturato su unit_start
 */
export function attachResearchGroupHooks(
	api: ExtensionAPI,
	ctx: ExtensionContext,
	resolveTrigger: ResolveTriggerOutput,
	stderr?: NodeJS.WritableStream,
): boolean {
	return attachUnitAwareHooks(api, ctx, {
		activeUnitTypes: ACTIVE_UNIT_TYPES.research,
		instructionMarker: RESEARCH_GROUP_INSTRUCTION_MARKER,
		instructionText: RESEARCH_GROUP_INSTRUCTION,
		resolveTrigger,
		stderr,
	});
}
