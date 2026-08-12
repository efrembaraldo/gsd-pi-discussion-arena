/**
 * Planning-phase hooks for discussion_arena auto-mode integration.
 *
 * Registers three hooks with the gsd-pi ExtensionAPI:
 * 1. unit_start — tracks current phase (planning, execution, verifying, closeout)
 * 2. adjust_tool_set — adds discussion_arena to result.toolNames when phase===planning AND forced
 * 3. before_agent_start — appends idempotent marker-injected instruction to systemPrompt
 *
 * Pure function (no side effects except hook registration). Exposed for testability.
 */

import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";
import type { ResolveTriggerOutput } from "../trigger-resolver.js";
import { PLANNING_INSTRUCTION_MARKER } from "./markers.js";

// Marker usato per l'iniezione idempotente dell'istruzione (definito in
// markers.ts: stringa runtime invariata, fuori dal criterio di scansione
// lessicale dei residui isolati della slice S04)
const DISCUSSION_ARENA_INSTRUCTION =
	"Usa discussion_arena prima di decidere il piano";

/**
 * Attaches discussion_arena-aware hooks to the ExtensionAPI.
 *
 * Creates a closure to track currentPhase across hook invocations.
 * - Registers unit_start hook to track current phase
 * - Registers adjust_tool_set hook to conditionally add discussion_arena
 * - Registers before_agent_start hook to conditionally append idempotent instruction
 *
 * @param api ExtensionAPI from activate(api)
 * @param _ctx ExtensionContext (passed for API consistency; not used in current implementation)
 * @param resolveTrigger ResolveTriggerOutput from S05-T01 decision
 */
export function attachDiscussionArenaHooks(
	api: ExtensionAPI,
	_ctx: ExtensionContext,
	resolveTrigger: ResolveTriggerOutput,
): void {
	// Track current phase — mutable state scoped to the activate() call closure
	let currentPhase: string = "unknown";

	// Hook 1: unit_start — track current phase
	api.on("unit_start", (event) => {
		// Distinguish planning from execution/verifying/closeout
		// event.unitType can be "planning", "execution", "verifying", "closeout"
		// Fallback to "unknown" if not recognized
		const unitType = event.unitType ?? "unknown";
		if (
			unitType === "planning" ||
			unitType === "execution" ||
			unitType === "verifying" ||
			unitType === "closeout"
		) {
			currentPhase = unitType;
		} else {
			currentPhase = "unknown";
		}
	});

	// Hook 2: adjust_tool_set — conditionally add discussion_arena
	api.on(
		"adjust_tool_set",
		(event): { toolNames?: string[] } | void => {
			// Only add if:
			// - currentPhase === "planning"
			// - resolveTrigger.decision === "forced"
			// Do NOT remove any tools, do NOT touch other phases
			if (currentPhase === "planning" && resolveTrigger.decision === "forced") {
				const toolNames = [...event.activeToolNames];
				if (!toolNames.includes("discussion_arena")) {
					toolNames.push("discussion_arena");
				}
				return { toolNames };
			}
		},
	);

	// Hook 3: before_agent_start — append idempotent instruction
	api.on(
		"before_agent_start",
		(event): { systemPrompt?: string } | void => {
			// Only append during planning phase
			if (currentPhase === "planning" && resolveTrigger.decision === "forced") {
				const marker = `\n\n${PLANNING_INSTRUCTION_MARKER}\n${DISCUSSION_ARENA_INSTRUCTION}`;

				// Check if instruction already present (idempotency via marker)
				if (!event.systemPrompt.includes(PLANNING_INSTRUCTION_MARKER)) {
					return {
						systemPrompt: event.systemPrompt + marker,
					};
				}
			}
		},
	);
}
