/**
 * Agent Discussion Arena — estensione gsd-pi
 *
 * Aggiunge un tool `discussion_arena` che l'agente attivo (in qualsiasi
 * fase del ciclo auto: researching, planning, executing, verifying...) può
 * invocare per far discutere N partecipanti con ruoli/competenze definiti
 * dall'utente, per K round, e ricevere il transcript risultante come testo
 * da usare nella propria risposta.
 *
 * Punto chiave architetturale: gsd-pi resta il coordinatore. Questo tool
 * non lancia un processo parallelo indipendente — viene chiamato come
 * qualsiasi altro tool DALL'agente che gsd-pi sta già eseguendo nella unit
 * corrente. L'orchestratore di auto mode (resolveDispatch, orchestrator.ts)
 * non sa nulla dell'arena: vede solo una tool call che dura più a lungo,
 * esattamente come vedrebbe una bash o una web-search.
 *
 * Formato dei partecipanti: vedi participants.ts — file .md con frontmatter
 * in .gsd/arena/participants/ (progetto) o ~/.gsd/agent/arena/participants/
 * (utente). Compatibile 1:1 con le persona portate da BMAD-METHOD.
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";
import {
	discoverParticipants,
	type ParticipantConfig,
} from "./participants.js";
import { runParticipantTurn } from "./run-participant.js";

export const MAX_PARTICIPANTS_PER_ARENA = 8;
export const MAX_ROUNDS = 5;
export const DEFAULT_ROUNDS = 2;

const ArenaParamsSchema = Type.Object({
	topic: Type.String({
		description:
			"Il tema/domanda su cui i partecipanti devono discutere o su cui devono deliberare.",
	}),
	participants: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Nomi dei partecipanti da coinvolgere (devono corrispondere a un file .md in .gsd/arena/participants/, ~/.gsd/agent/arena/participants/ o ai partecipanti bundled dell'estensione). Se omesso, vengono usati tutti i partecipanti disponibili.",
		}),
	),
	rounds: Type.Optional(
		Type.Integer({
			description: `Numero di round di discussione (ogni partecipante vede il transcript dei round precedenti). Default ${DEFAULT_ROUNDS}, massimo ${MAX_ROUNDS}.`,
			minimum: 1,
			maximum: MAX_ROUNDS,
		}),
	),
});

function formatParticipantList(participants: ParticipantConfig[]): string {
	if (participants.length === 0) return "(nessun partecipante configurato)";
	return participants
		.map((p) => `- ${p.name} (${p.role}): ${p.description}`)
		.join("\n");
}

export function buildRoundPrompt(
	topic: string,
	roundIndex: number,
	transcript: string,
	participant: ParticipantConfig,
): string {
	if (roundIndex === 0) {
		return [
			`Tema della discussione: ${topic}`,
			``,
			`Sei ${participant.name} (${participant.role}). Esprimi la tua posizione iniziale, basandoti esclusivamente sulla tua competenza. Sii specifico e conciso — niente premesse generiche.`,
		].join("\n");
	}
	return [
		`Tema della discussione: ${topic}`,
		``,
		`Transcript finora:`,
		transcript,
		``,
		`Sei ${participant.name} (${participant.role}). Rispondi agli altri partecipanti dal tuo punto di vista: dove concordi, dove dissenti e perché, cosa aggiungeresti. Sii specifico e conciso.`,
	].join("\n");
}

/**
 * Seleziona i partecipanti da coinvolgere nell'arena: se `requestedNames` è
 * fornito e non vuoto, filtra `all` per quei nomi (scartando i nomi senza
 * corrispondenza); altrimenti usa tutti i partecipanti disponibili. In ogni
 * caso applica il cap MAX_PARTICIPANTS_PER_ARENA troncando la selezione.
 * Funzione pura, nessun I/O — estratta da runArena per essere testabile
 * direttamente (D020).
 */
export function selectParticipants(
	all: ParticipantConfig[],
	requestedNames: string[] | undefined,
): ParticipantConfig[] {
	let selected: ParticipantConfig[];
	if (requestedNames && requestedNames.length > 0) {
		selected = requestedNames
			.map((name) => all.find((p) => p.name === name))
			.filter((p): p is ParticipantConfig => Boolean(p));
	} else {
		selected = all;
	}
	if (selected.length > MAX_PARTICIPANTS_PER_ARENA) {
		selected = selected.slice(0, MAX_PARTICIPANTS_PER_ARENA);
	}
	return selected;
}

async function runArena(
	topic: string,
	requestedNames: string[] | undefined,
	rounds: number,
	cwd: string,
	signal: AbortSignal | undefined,
	onProgress: (partialTranscript: string) => void,
): Promise<{
	transcript: string;
	participantsUsed: string[];
	totalCost: number;
}> {
	const { participants: all } = discoverParticipants(cwd);

	const selected = selectParticipants(all, requestedNames);

	if (selected.length === 0) {
		const available = all.map((p) => p.name).join(", ") || "nessuno";
		throw new Error(
			`Nessun partecipante valido trovato. Disponibili: ${available}. ` +
				`Definisci ruoli in .gsd/arena/participants/*.md o ~/.gsd/agent/arena/participants/*.md.`,
		);
	}

	let transcript = "";
	let totalCost = 0;

	for (let round = 0; round < rounds; round++) {
		const turnsThisRound: string[] = [];

		// Sequenziale di proposito: ogni partecipante nel round vede gli
		// interventi già dati dagli altri nello stesso round (dialogo reale,
		// non N risposte indipendenti). Per un dibattito realmente
		// simultaneo (nessuno vede gli altri nel round corrente) invertire
		// l'ordine: costruire tutti i prompt del round prima di eseguirli e
		// lanciarli con Promise.all.
		for (const participant of selected) {
			const prompt = buildRoundPrompt(
				topic,
				round,
				transcript + turnsThisRound.join("\n\n"),
				participant,
			);
			const turn = await runParticipantTurn(participant, prompt, cwd, signal);

			totalCost += turn.usage.cost;

			const entry = `### Round ${round + 1} — ${participant.name} (${participant.role})\n${
				turn.text || "(nessuna risposta)"
			}`;
			turnsThisRound.push(entry);
			onProgress(transcript + "\n\n" + turnsThisRound.join("\n\n"));
		}

		transcript += (transcript ? "\n\n" : "") + turnsThisRound.join("\n\n");
	}

	return {
		transcript,
		participantsUsed: selected.map((p) => p.name),
		totalCost,
	};
}

export default function activate(api: ExtensionAPI) {
	api.registerTool({
		name: "discussion_arena",
		label: "Discussion Arena",
		description:
			"Fa discutere più partecipanti (ruoli/competenze definiti dall'utente in .gsd/arena/participants/) su un tema per N round, e restituisce il transcript. Usalo quando la fase corrente beneficia di prospettive multiple e dedicate (es. valutare un'architettura, un trade-off di design, un piano di rischio) prima di procedere.",
		promptSnippet:
			"discussion_arena — consiglio di agenti con ruoli configurabili per deliberare su un tema",
		promptGuidelines: [
			"Usa discussion_arena quando una decisione beneficia di più punti di vista specializzati invece di un'unica risposta.",
			"Non usarlo per compiti puramente esecutivi (scrivere codice, eseguire comandi) — è pensato per discussione e deliberazione, non per implementazione.",
		],
		parameters: ArenaParamsSchema,
		execute: async (
			_toolCallId,
			params,
			signal,
			onUpdate,
			ctx: ExtensionContext,
		) => {
			const rounds = Math.min(params.rounds ?? DEFAULT_ROUNDS, MAX_ROUNDS);
			try {
				const { transcript, participantsUsed, totalCost } = await runArena(
					params.topic,
					params.participants,
					rounds,
					ctx.cwd,
					signal,
					(partial) => {
						onUpdate?.({
							content: [{ type: "text", text: partial || "(in corso...)" }],
							details: { participantsUsed: [], totalCost: 0, rounds },
						});
					},
				);

				return {
					content: [
						{
							type: "text",
							text: `## Discussion Arena — "${params.topic}"\nPartecipanti: ${participantsUsed.join(", ")} | Round: ${rounds} | Costo totale stimato: $${totalCost.toFixed(4)}\n\n${transcript}`,
						},
					],
					details: { participantsUsed, totalCost, rounds },
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [
						{
							type: "text",
							text: `Errore nell'esecuzione dell'arena: ${message}`,
						},
					],
					details: { participantsUsed: [], totalCost: 0, rounds },
				};
			}
		},
	});

	api.registerCommand("discussion-arena", {
		description:
			"Avvia una Discussion Arena manuale: /gsd discussion-arena <topic>",
		handler: async (args, ctx) => {
			const { participants } = discoverParticipants(ctx.cwd);
			if (!args.trim()) {
				await ctx.ui.notify(
					`Partecipanti disponibili:\n${formatParticipantList(participants)}\n\nUso: /gsd discussion-arena <topic>`,
				);
				return;
			}
			await ctx.ui.notify(
				`Avvio arena su: "${args.trim()}" con ${participants.length} partecipanti disponibili...`,
			);
			const { transcript, participantsUsed, totalCost } = await runArena(
				args.trim(),
				undefined,
				DEFAULT_ROUNDS,
				ctx.cwd,
				undefined,
				() => {},
			);
			await ctx.ui.notify(
				`Arena completata (${participantsUsed.join(", ")}, costo $${totalCost.toFixed(4)}):\n\n${transcript}`,
			);
		},
	});
}
