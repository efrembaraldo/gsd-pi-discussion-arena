/**
 * replay.ts — Event sourcing JSONL e replay opt-in (M003/S07).
 *
 * Espone tre funzioni sulla superficie dell'event log persistito dalla discussion-arena
 * sotto `<cwd>/.gsd/discussion-arena/events/<discussionArenaId>.jsonl` (opt-in via `eventLog`,
 * vedi index.ts):
 *
 * - `discussionArenaEventLogPath(cwd, discussionArenaId)` — path canonico dell'event log per
 *   una discussion-arena. Nessun I/O.
 * - `reconstructTranscript(events)` — funzione pura che ri-deriva il
 *   transcript testuale da una sequenza di `DiscussionArenaEvent` in ordine, senza
 *   rieseguire alcun subprocess. Considera solo gli eventi che contribuiscono
 *   al testo visibile (`participant_message`, `marker`, `participant_skip`);
 *   ignora gli eventi puramente strutturali (`discussion_arena_start`, `round_start`,
 *   `participant_start`, `cost_update`, `round_end`, `discussion_arena_done`).
 * - `replayDiscussionArena(discussionArenaId, cwd)` — rilegge l'event log tramite `readEvents`
 *   (helpers.ts, S01) e ritorna `{ transcript, eventCount }`, oppure `null`
 *   se l'discussionArenaId non ha eventi (file assente o vuoto — `readEvents` è
 *   fail-safe su ENOENT).
 *
 * Schema eventi (emesso da index.ts/runDiscussionArena in S07/T02, qui solo
 * consumato in lettura):
 * - `participant_message`: { participantId, round, text, cost, totalCost }
 * - `marker`:               { participantId, round, marker, kind }
 * - `participant_skip`:     { participantId, round, reason, marker }
 * - strutturali (ignorati dalla ricostruzione): `discussion_arena_start`, `round_start`,
 *   `participant_start`, `cost_update`, `round_end`, `discussion_arena_done`
 *
 * Nota identità (RESEARCH M003/S07): il transcript ri-derivato non è
 * garantito byte-for-byte identico a quello prodotto dalla run originale
 * (che intercala i turni round-per-round man mano che avvengono) — contiene
 * però esattamente gli stessi messaggi/marker, nello stesso ordine di round
 * e partecipante, il che è sufficiente per la prova post-mortem dei
 * guardrail S03-S06.
 *
 * Vincoli (D004): zero dipendenze npm runtime; solo `node:path` e i helper
 * `readEvents`/`DiscussionArenaEvent` già esistenti in helpers.ts (S01), non modificati.
 */

import * as path from "node:path";
import { readEvents, type DiscussionArenaEvent } from "./helpers.js";

/**
 * Path canonico dell'event log JSONL di una discussion-arena:
 * `<cwd>/.gsd/discussion-arena/events/<discussionArenaId>.jsonl`. Nessun I/O — solo composizione
 * path (pattern `getSessionFilePath` in discussion-arena-session.ts, ma
 * namespace separato: l'event log è per-invocazione, non per-topic).
 */
export function discussionArenaEventLogPath(cwd: string, discussionArenaId: string): string {
	return path.join(cwd, ".gsd", "discussion-arena", "events", `${discussionArenaId}.jsonl`);
}

/** Estrae un campo stringa da un evento con payload `unknown`, fallback su invalido/assente. */
function asString(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

/** Estrae un campo numerico finito da un evento con payload `unknown`, fallback su invalido/assente. */
function asNumber(value: unknown, fallback = 0): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Ri-costruisce il transcript testuale da una sequenza di `DiscussionArenaEvent`, in
 * ordine. Funzione pura: nessun I/O, nessun accesso a filesystem/orologio.
 * Solo `participant_message`, `marker` e `participant_skip` contribuiscono
 * al transcript (ciascuno produce un blocco `### Round N — participantId`);
 * gli altri tipi evento (strutturali/di stato) vengono ignorati in silenzio
 * — un tipo evento sconosciuto/futuro non contribuisce e non lancia.
 */
export function reconstructTranscript(events: readonly DiscussionArenaEvent[]): string {
	const parts: string[] = [];
	for (const ev of events) {
		switch (ev.type) {
			case "participant_message": {
				const round = asNumber(ev.round);
				const participantId = asString(ev.participantId);
				const text = asString(ev.text);
				parts.push(`### Round ${round} — ${participantId}\n${text}`);
				break;
			}
			case "marker": {
				const round = asNumber(ev.round);
				const participantId = asString(ev.participantId);
				const marker = asString(ev.marker);
				parts.push(`### Round ${round} — ${participantId}\n${marker}`);
				break;
			}
			case "participant_skip": {
				const round = asNumber(ev.round);
				const participantId = asString(ev.participantId);
				const marker = asString(ev.marker);
				parts.push(`### Round ${round} — ${participantId}\n${marker}`);
				break;
			}
			default:
				// Eventi strutturali (discussion_arena_start, round_start, participant_start,
				// cost_update, round_end, discussion_arena_done) o tipi sconosciuti: nessun
				// contributo al transcript, nessun throw (fail-safe come readEvents).
				break;
		}
	}
	return parts.join("\n\n");
}

/**
 * Ri-deriva il transcript di una discussion-arena a partire dal suo event log JSONL su
 * disco, SENZA rieseguire alcun subprocess (nessuna chiamata a `runTurn`).
 * Rilegge gli eventi con `readEvents` (helpers.ts, fail-safe su righe
 * malformate e su file assente — ENOENT produce un iterable vuoto, non un
 * throw). Ritorna `null` se non ci sono eventi (discussionArenaId inesistente o log
 * vuoto), altrimenti `{ transcript, eventCount }` con `eventCount` pari al
 * numero totale di eventi letti (non solo quelli che contribuiscono al
 * transcript) — utile per assert su completezza del log persistito.
 */
export async function replayDiscussionArena(
	discussionArenaId: string,
	cwd: string,
): Promise<{ transcript: string; eventCount: number } | null> {
	const filePath = discussionArenaEventLogPath(cwd, discussionArenaId);
	const events: DiscussionArenaEvent[] = [];
	for await (const ev of readEvents(filePath)) {
		events.push(ev);
	}
	if (events.length === 0) return null;
	return { transcript: reconstructTranscript(events), eventCount: events.length };
}
