/**
 * replay.ts — Event sourcing JSONL e replay opt-in (M003/S07).
 *
 * Espone quattro funzioni sulla superficie dell'event log persistito dalla discussion-arena
 * sotto `<cwd>/.gsd/discussion-arena/events/<discussionArenaId>.jsonl` (opt-in via `eventLog`,
 * vedi index.ts):
 *
 * - `discussionArenaEventLogPath(cwd, discussionArenaId)` — path canonico dell'event log per
 *   una discussion-arena. Nessun I/O.
 * - `isValidReplayId(id)` — validatore di formato per il parametro `replay` di
 *   `discussion_arena` (R057). Accetta 32 char hex o UUID v4 standard con dashes.
 * - `reconstructTranscript(events)` — funzione pura che ri-deriva il
 *   transcript testuale da una sequenza di `DiscussionArenaEvent` in ordine, senza
 *   rieseguire alcun subprocess. Considera solo gli eventi che contribuiscono
 *   al testo visibile (`participant_message`, `marker`, `participant_skip`);
 *   ignora gli eventi puramente strutturali (`discussion_arena_start`, `round_start`,
 *   `participant_start`, `cost_update`, `round_end`, `discussion_arena_done`).
 * - `replayDiscussionArena(discussionArenaId, cwd)` — rilegge l'event log tramite `readEvents`
 *   (helpers.ts, S01) e ritorna `{ transcript, eventCount, events }`, oppure `null`
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

/**
 * Valida il formato di un replay ID (R057 — capability additive `replay`).
 *
 * Accetta entrambe le forme osservabili sul disco:
 * - 32 caratteri hex lowercase/uppercase (forma canonica prodotta da `randomUUID().replace(/-/g, "")`)
 * - UUID v4 standard con dashes (36 char, es. `f47ac10b-58cc-4372-a567-0e02b2c3d479`)
 *
 * Regex permissiva per backward-compat con gli event log pre-S03 già scritti su disco
 * da `randomUUID()` di `node:crypto` (che conserva i dashes). Cambiare questa regex a
 * 32-hex strict romperebbe la retrocompatibilità di tutti i replay delle run pre-S03.
 *
 * Esempi:
 * - `isValidReplayId("f47ac10b58cc4372a5670e02b2c3d479")` → `true` (32 hex)
 * - `isValidReplayId("f47ac10b-58cc-4372-a567-0e02b2c3d479")` → `true` (UUID v4 con dashes)
 * - `isValidReplayId("F47AC10B58CC4372A5670E02B2C3D479")` → `true` (case-insensitive)
 * - `isValidReplayId("abc")` → `false` (troppo corto)
 * - `isValidReplayId("")` → `false` (length === 0)
 * - `isValidReplayId("with-uuid-dashes-but-wrong-segment-count")` → `false`
 *
 * @param id - stringa candidata come replay ID (es. parametro `replay` di `discussion_arena`)
 * @returns `true` se l'ID è sintatticamente valido come hex32 o UUID v4 dashed
 */
export function isValidReplayId(id: string): boolean {
	if (typeof id !== "string" || id.length === 0) return false;
	return (
		/^[0-9a-f]{32}$/i.test(id) ||
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
	);
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
 * vuoto), altrimenti `{ transcript, eventCount, events }` con `eventCount` pari al
 * numero totale di eventi letti (non solo quelli che contribuiscono al
 * transcript) — utile per assert su completezza del log persistito.
 *
 * Il campo `events` (aggiunto in M018/S03/T01) espone la sequenza grezza letta da
 * `readEvents` come `readonly DiscussionArenaEvent[]`, consentendo al caller
 * (es. `buildDiscussionArenaExecute` corto-circuito replay in index.ts) di
 * calcolare metriche derivate (`restoredRounds`, `restoredCost`,
 * `restoredOutcome`) tramite l'helper `extractReplayMetrics` senza dover
 * rileggere il log da disco. La modifica è additiva (R064): consumer
 * esistenti che accedono solo a `.transcript` / `.eventCount` continuano a
 * funzionare invariati.
 */
export async function replayDiscussionArena(
	discussionArenaId: string,
	cwd: string,
): Promise<{ transcript: string; eventCount: number; events: readonly DiscussionArenaEvent[] } | null> {
	const filePath = discussionArenaEventLogPath(cwd, discussionArenaId);
	const events: DiscussionArenaEvent[] = [];
	for await (const ev of readEvents(filePath)) {
		events.push(ev);
	}
	if (events.length === 0) return null;
	return {
		transcript: reconstructTranscript(events),
		eventCount: events.length,
		events,
	};
}

/**
 * Estrae le metriche di riepilogo da un array di eventi persistiti della
 * discussion-arena (M018/S03). Funzione PURA: nessun I/O, nessun accesso
 * a clock o filesystem, nessun side-effect — stessa sequenza di input
 * produce stesso output. Determinismo garantito per costruzione (no
 * random, no Date.now, no letture esterne).
 *
 * Usata dal corto-circuito replay in `buildDiscussionArenaExecute`
 * (index.ts) per popolare `details.replay.restoredRounds`,
 * `details.replay.restoredCost`, `details.replay.restoredOutcome` senza
 * dover rileggere il log da disco (il caller passa direttamente il campo
 * `events` esposto da `replayDiscussionArena`).
 *
 * Ortogonalità con D144 (threshold minimo 3 eventi per validare la
 * completezza del log): questa funzione NON impone alcun vincolo sulla
 * lunghezza di `events`. Funziona correttamente anche con array vuoto o
 * di lunghezza 1, restituendo i fallback `restoredRounds=0`,
 * `restoredCost=0`, `restoredOutcome="unknown"`. La validazione D144 è
 * una check di runtime separata in index.ts (M018/S03/T03), non parte di
 * questo helper.
 *
 * Contratto di ordinamento: l'array `events` DEVE essere in ordine
 * cronologico ascendente (timestamp). Quando il caller è
 * `replayDiscussionArena`, questo è garantito perché `readEvents`
 * (helpers.ts, S01) legge il JSONL in append-order fail-safe. Per
 * trovare l'esito terminale dell'arena, la funzione scorre l'array a
 * ritroso partendo dall'ultimo elemento — l'ULTIMO `discussion_arena_done`
 * è quello che vince, coerente con il modello "ultimo write vince" del
 * log append-only.
 *
 * Campi letti dagli eventi (via `asNumber` / `asString` per coerenza
 * fail-safe con `reconstructTranscript`):
 * - `round_end.round`            → contribuisce a `restoredRounds`
 * - `participant_message.totalCost` e `discussion_arena_done.totalCost`
 *                                  → contribuiscono a `restoredCost`
 *   (l'osservazione del costo è monotona non decrescente: il valore
 *    massimo osservato coincide con il costo finale, che è quello
 *    canonizzato anche nell'evento terminale)
 * - `discussion_arena_done.outcome` → contribuisce a `restoredOutcome`
 *
 * @param events - sequenza di eventi del log JSONL (in ordine cronologico ascendente)
 * @returns oggetto con `restoredRounds` (round massimo raggiunto),
 *   `restoredCost` (costo massimo cumulato osservato), e `restoredOutcome`
 *   (esito terminale dell'arena, ristretto al literal type `"complete" |
 *   "partial" | "unknown"` — qualsiasi altro valore di `outcome` o la
 *   sua assenza producono `"unknown"`).
 */
export function extractReplayMetrics(events: readonly DiscussionArenaEvent[]): {
	restoredRounds: number;
	restoredCost: number;
	restoredOutcome: "complete" | "partial" | "unknown";
} {
	// restoredRounds: massimo `round` osservato tra gli eventi round_end.
	let restoredRounds = 0;
	for (const ev of events) {
		if (ev.type === "round_end") {
			const r = asNumber(ev.round, 0);
			if (r > restoredRounds) restoredRounds = r;
		}
	}

	// restoredCost: massimo `totalCost` osservato tra participant_message e
	// discussion_arena_done. Il costo è monotonico non decrescente durante una
	// run (accumulateCost in helpers.ts), quindi il massimo coincide col valore
	// terminale dell'evento done.
	let restoredCost = 0;
	for (const ev of events) {
		if (ev.type === "participant_message" || ev.type === "discussion_arena_done") {
			const c = asNumber(ev.totalCost, 0);
			if (c > restoredCost) restoredCost = c;
		}
	}

	// restoredOutcome: prendi l'ULTIMO discussion_arena_done (cfr. JSDoc —
	// scan a ritroso, "ultimo write vince"). Se il valore di outcome non è
	// esattamente "complete" o "partial", fallback "unknown". Se nessun
	// discussion_arena_done è presente, resta "unknown".
	let restoredOutcome: "complete" | "partial" | "unknown" = "unknown";
	for (let i = events.length - 1; i >= 0; i--) {
		const ev = events[i];
		if (ev !== undefined && ev.type === "discussion_arena_done") {
			const o = asString(ev.outcome);
			if (o === "complete" || o === "partial") {
				restoredOutcome = o;
			}
			break;
		}
	}

	return { restoredRounds, restoredCost, restoredOutcome };
}
