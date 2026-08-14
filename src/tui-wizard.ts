/**
 * milestone_start TUI wizard per la strategia di attivazione discussion_arena.
 *
 * Registered via `attachDiscussionArenaWizard(api, ctx, writePreferences)`. Listens for
 * the `milestone_start` GSD event and, when the milestone context has a TUI
 * (`ctx.hasUI === true`), asks the user to pick one of three strategies:
 *   - per-milestone    -> prompts for a milestone ID, then persists
 *                         `activation.milestones.<mid>.enabled: true`
 *   - always-on        -> persists `activation.enabled: true`
 *   - availability-only -> persists `activation.enabled: false`
 *
 * La strategia viene persistita nella sezione `activation:` del coordination
 * file per-progetto `.gsd/discussion-arena/discussion-arena-coordination.md`
 * (Tier 2 canonicato, S02/M007), non piu in PREFERENCES.md (Tier 2-bis
 * deprecato).
 *
 * When `hasUI === false` (CI/print/"no UI" modal), it is a strict no-op that
 * emits a diagnostic on stderr and returns — it must never block the pipeline.
 * Always idempotent: re-writing the same choice is a no-op on disk.
 *
 * `writePreferences` is injected (single dependency), which keeps this module
 * fully decoupled from the filesystem and trivially testable.
 */

import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";
import { LOG_PREFIX } from "./log-prefix.js";

export type WizardMode = "per-milestone" | "always-on" | "availability-only";

export interface WizardWriteTarget {
	cwd: string;
	mode: WizardMode;
	milestoneId?: string;
}

/** Signature of the injected atomic writer (real impl in preferences-writer.ts). */
export type WritePreferencesFn = (target: WizardWriteTarget) => Promise<void>;

export const DISCUSSION_ARENA_WIZARD_OPTIONS: readonly WizardMode[] = [
	"per-milestone",
	"always-on",
	"availability-only",
];

export const DISCUSSION_ARENA_WIZARD_MODE_LABELS: Record<WizardMode, string> = {
	"per-milestone":
		"per-milestone — abilita Discussion Arena solo per un milestone specifico",
	"always-on": "always-on — abilita Discussion Arena per tutti i milestone futuri",
	"availability-only":
		"availability-only — Discussion Arena disponibile ma non forzata (default)",
};

function normalizeChoice(
	choice: string | string[] | undefined,
): WizardMode | null {
	const value = Array.isArray(choice) ? choice[0] : choice;
	if (value && (DISCUSSION_ARENA_WIZARD_OPTIONS as readonly string[]).includes(value)) {
		return value as WizardMode;
	}
	return null;
}

/**
 * Register the milestone_start wizard.
 *
 * @param api             ExtensionAPI from activate(api).
 * @param ctx             Fallback context (cwd/hasUI used only when the event
 *                        context omits them).
 * @param writePreferences Injected atomic writer. Receives the derived target
 *                        and must resolve once persisted.
 */
export function attachDiscussionArenaWizard(
	api: ExtensionAPI,
	ctx: ExtensionContext,
	writePreferences: WritePreferencesFn,
): void {
	api.on("milestone_start", async (event, eventCtx) => {
		const ui = eventCtx ?? ctx;
		const cwd = event.cwd ?? ui?.cwd ?? ctx.cwd;

		// CI / print / no-TUI: strict no-op with a stderr diagnostic.
		if (!ui?.hasUI) {
			process.stderr.write(
				`${LOG_PREFIX} milestone_start (${event.milestoneId}): hasUI=false, ` +
					`wizard no-op (CI/print). Configura via la sezione activation del coordination file.\n`,
			);
			return;
		}

		const label = event.milestoneId
			? `"${event.milestoneId}"`
			: "(milestone corrente)";
		const choice = await ui.ui.select(
			`Discussion Arena per il milestone ${label} — strategia di attivazione`,
			[...DISCUSSION_ARENA_WIZARD_OPTIONS],
		);
		const mode = normalizeChoice(choice);

		if (!mode) {
			await ui.ui.notify("Discussion Arena: selezione annullata — nessuna modifica.");
			return;
		}

		let milestoneId: string | undefined;
		if (mode === "per-milestone") {
			milestoneId = await ui.ui.input(
				"ID milestone da abilitare (es. M003)",
				event.milestoneId,
			);
			if (!milestoneId?.trim()) {
				await ui.ui.notify(
					"Discussion Arena: ID milestone mancante — nessuna modifica.",
				);
				return;
			}
			milestoneId = milestoneId.trim();
		}

		await writePreferences({ cwd, mode, milestoneId });

		const suffix = milestoneId ? ` per milestone ${milestoneId}` : "";
		await ui.ui.notify(
			`Discussion Arena: strategia "${mode}"${suffix} attivata nel coordination file (sezione activation).`,
		);
	});
}