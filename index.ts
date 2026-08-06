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
 * non sa nulla della discussion-arena: vede solo una tool call che dura
 * più a lungo, esattamente come vedrebbe una bash o una web-search.
 *
 * Formato dei partecipanti: vedi participants.ts — file .md con frontmatter
 * in .gsd/discussion-arena/participants/ (progetto) o
 * ~/.gsd/agent/discussion-arena/participants/ (utente). Compatibile 1:1 con
 * le persona portate da BMAD-METHOD.
 */

import { Type } from "typebox";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@gsd/pi-coding-agent";
import {
	discoverParticipants,
	type ParticipantConfig,
} from "./participants.js";
import { runParticipantTurn } from "./run-participant.js";
import {
	getSessionFilePath,
	loadSession,
	saveSession,
	type DiscussionArenaSession,
} from "./discussion-arena-session.js";

export const MAX_PARTICIPANTS = 8;
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
				"Nomi dei partecipanti da coinvolgere (devono corrispondere a un file .md in .gsd/discussion-arena/participants/, ~/.gsd/agent/discussion-arena/participants/ o ai partecipanti bundled dell'estensione). Se omesso, vengono usati tutti i partecipanti disponibili.",
		}),
	),
	rounds: Type.Optional(
		Type.Integer({
			description: `Numero di round di discussione (ogni partecipante vede il transcript dei round precedenti). Default ${DEFAULT_ROUNDS}, massimo ${MAX_ROUNDS}.`,
			minimum: 1,
			maximum: MAX_ROUNDS,
		}),
	),
	contTopic: Type.Optional(
		Type.String({
			description:
				"(solo command) Path del file di sessione esistente da cui continuare (--continue). Se omesso, si cerca la sessione per il topic nel cwd.",
		}),
	),
	model: Type.Optional(
		Type.String({
			description:
				"(solo command) Modello che sovrascrive participant.model per tutti i turn di questa sessione.",
		}),
	),
});

function formatParticipantList(participants: ParticipantConfig[]): string {
	if (participants.length === 0)
		return "(nessun partecipante configurato)";
	return participants.map((p) => `- ${p.name} (${p.role}): ${p.description}`).join("\n");
}

/**
 * Tronca il transcript a `maxBytes` mantenendo i round più recenti e scartando
 * i più vecchi. Necessario per evitare `spawn E2BIG` quando il transcript
 * cresce oltre il limite argv (tipicamente ~2MB su Linux, ~256KB su macOS)
 * a causa di --continue che appende round o topic con risposte molto lunghe.
 * Il transcript completo viene comunque salvato su disco dalla sessione, quindi
 * la troncatura è solo per il prompt — l'utente può sempre rileggere la
 * versione integrale dal file di sessione.
 */
function truncateTranscriptForPrompt(
	transcript: string,
	maxBytes: number = 100_000,
): string {
	if (transcript.length <= maxBytes) return transcript;
	const re = /\n\n(?=### Round \d+)/g;
	const parts: string[] = [];
	let lastIdx = 0;
	let m: RegExpExecArray | null;
	while ((m = re.exec(transcript)) !== null) {
		parts.push(transcript.slice(lastIdx, m.index));
		lastIdx = m.index + 2;
	}
	parts.push(transcript.slice(lastIdx));

	let kept = "";
	for (let i = parts.length - 1; i >= 0; i--) {
		const candidate = parts.slice(i).join("\n\n");
		if (candidate.length <= maxBytes) {
			kept = candidate;
			break;
		}
	}
	if (!kept) {
		// Singolo round più grande del budget: tronca l'ultimo blocco.
		kept =
			"[...troncato per limite prompt...]\n\n" +
			parts[parts.length - 1]!.slice(-(maxBytes - 100));
	} else {
		kept =
			"[...round più vecchi omessi per limite prompt...]\n\n" + kept;
	}
	return kept;
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
 * Parsing argomenti del comando. Pura, testabile. Restituisce le opzioni
 * strutturate oppure null se manca il topic (per mostrare usage).
 *
 * Formato: <topic> [N rounds] [--continue|--new] [--model <id>]
 * Il topic può contenere spazi; --model accetta il token successivo come
 * valore; --continue/--new sono flag standalone; l'ultimo token numerico
 * non consumato da --model è rounds.
 */
export interface ParsedCommandArgs {
	topic: string;
	rounds: number;
	continueSession: boolean;
	explicitNew: boolean;
	modelOverride: string | undefined;
}

export function parseCommandArgs(rawArgs: string, defaults: { rounds: number }): ParsedCommandArgs | null {
	const rawTokens = rawArgs.trim().split(/\s+/).filter(Boolean);
	let continueSession = false;
	let explicitNew = false;
	let modelOverride: string | undefined;
	const topicTokens: string[] = [];
	let rounds = defaults.rounds;

	for (let i = 0; i < rawTokens.length; i++) {
		const t = rawTokens[i]!;
		if (t === "--continue" || t === "-c") {
			continueSession = true;
		} else if (t === "--new") {
			explicitNew = true;
		} else if (t === "--model" || t === "-m") {
			const value = rawTokens[i + 1];
			if (value && !value.startsWith("--")) {
				modelOverride = value;
				i++;
			}
		} else if (topicTokens.length === 0 && /^\d+$/.test(t) && i === rawTokens.length - 1) {
			const parsed = parseInt(t, 10);
			if (Number.isFinite(parsed) && parsed >= 1) {
				rounds = Math.min(parsed, MAX_ROUNDS);
			}
		} else {
			topicTokens.push(t);
		}
	}

	const lastTopic = topicTokens[topicTokens.length - 1];
	if (lastTopic && /^\d+$/.test(lastTopic)) {
		const parsed = parseInt(lastTopic, 10);
		if (Number.isFinite(parsed) && parsed >= 1) {
			rounds = Math.min(parsed, MAX_ROUNDS);
			topicTokens.pop();
		}
	}

	const topic = topicTokens.join(" ").trim();
	if (!topic) return null;
	return { topic, rounds, continueSession, explicitNew, modelOverride };
}

/**
 * Seleziona i partecipanti da coinvolgere nella discussion-arena: se
 * `requestedNames` è fornito e non vuoto, filtra `all` per quei nomi (scartando
 * i nomi senza corrispondenza); altrimenti usa tutti i partecipanti disponibili.
 * In ogni caso applica il cap MAX_PARTICIPANTS troncando la selezione.
 * Funzione pura, nessun I/O — estratta da runDiscussionArena per essere
 * testabile direttamente (D020).
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
	if (selected.length > MAX_PARTICIPANTS) {
		selected = selected.slice(0, MAX_PARTICIPANTS);
	}
	return selected;
}

async function runDiscussionArena(
	topic: string,
	requestedNames: string[] | undefined,
	rounds: number,
	cwd: string,
	signal: AbortSignal | undefined,
	onProgress: (partialTranscript: string) => void,
	onRoundComplete?: (
		roundIndex: number,
		cumulativeTranscript: string,
		totalCost: number,
	) => void,
	continuation?: { transcript: string; roundOffset: number },
	modelOverride?: string,
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
				`Definisci ruoli in .gsd/discussion-arena/participants/*.md o ~/.gsd/agent/discussion-arena/participants/*.md.`,
		);
	}

	let transcript = continuation?.transcript ?? "";
	const roundOffset = continuation?.roundOffset ?? 0;
	let totalCost = 0;

	for (let round = 0; round < rounds; round++) {
		const turnsThisRound: string[] = [];

		// Sequenziale di proposito: ogni partecipante nel round vede gli
		// interventi gia' dati dagli altri nello stesso round (dialogo reale,
		// non N risposte indipendenti). Per un dibattito realmente
		// simultaneo (nessuno vede gli altri nel round corrente) invertire
		// l'ordine: costruire tutti i prompt del round prima di eseguirli e
		// lanciarli con Promise.all.
		for (const participant of selected) {
			// Tronca il transcript prima di passarlo al prompt per evitare
			// E2BIG su argv quando --continue accumula molti round.
			const fullContext = transcript + turnsThisRound.join("\n\n");
			const promptContext = truncateTranscriptForPrompt(fullContext);
			const prompt = buildRoundPrompt(
				topic,
				round,
				promptContext,
				participant,
			);
			const turn = await runParticipantTurn(
				participant,
				prompt,
				cwd,
				signal,
				modelOverride,
			);

			totalCost += turn.usage.cost;

			const entry = `### Round ${round + 1 + roundOffset} — ${participant.name} (${participant.role})\n${
				turn.text || "(nessuna risposta)"
			}`;
			turnsThisRound.push(entry);
			onProgress(transcript + "\n\n" + turnsThisRound.join("\n\n"));
		}

		transcript += (transcript ? "\n\n" : "") + turnsThisRound.join("\n\n");
		onRoundComplete?.(round + 1 + roundOffset, transcript, totalCost);
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
			"Fa discutere più partecipanti (ruoli/competenze definiti dall'utente in .gsd/discussion-arena/participants/) su un tema per N round, e restituisce il transcript. Usalo quando la fase corrente beneficia di prospettive multiple e dedicate (es. valutare un'architettura, un trade-off di design, un piano di rischio) prima di procedere.",
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
				const { transcript, participantsUsed, totalCost } = await runDiscussionArena(
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

				// Persistenza anche per il tool (oltre che per il command): l'agente
				// puo' fare sessioni continue invocando piu' volte con --continue
				// via params.contTopic (futuro) o riaprendo la sessione salvata.
				// Per ora salvataggio semplice su file cwd-relative.
				const sessionPath = getSessionFilePath(ctx.cwd, params.topic);
				const existing = await loadSession(sessionPath);
				const now = new Date().toISOString();
				const session: DiscussionArenaSession = {
					topic: params.topic,
					participants: participantsUsed,
					startedAt: existing?.startedAt ?? now,
					lastUpdatedAt: now,
					rounds,
					transcript,
				};
				await saveSession(sessionPath, session).catch((err) => {
					// Non fatale: la run è riuscita, solo persistenza fallita
					process.stderr.write(
						`[discussion-arena] warning: impossibile salvare sessione in ${sessionPath}: ${err instanceof Error ? err.message : err}\n`,
					);
				});

				return {
					content: [
						{
							type: "text",
							text: `## Discussion Arena — "${params.topic}"\nPartecipanti: ${participantsUsed.join(", ")} | Round: ${rounds} | Costo totale stimato: $${totalCost.toFixed(4)}\n\n${transcript}\n\nSession salvata: ${sessionPath}`,
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
							text: `Errore nell'esecuzione della discussion-arena: ${message}`,
						},
					],
					details: { participantsUsed: [], totalCost: 0, rounds },
				};
			}
		},
	});

	api.registerCommand("discussion-arena", {
		description:
			"Avvia una Discussion Arena: /discussion-arena <topic> [N rounds] [--continue|--new] [--model <id>]",
		handler: async (args, ctx) => {
			const { participants } = discoverParticipants(ctx.cwd);

			const parsed = parseCommandArgs(args, { rounds: DEFAULT_ROUNDS });
			if (!parsed) {
				await ctx.ui.notify(
					`Partecipanti disponibili:\n${formatParticipantList(participants)}\n\nUso: /discussion-arena <topic> [N rounds] [--continue|--new] [--model <id>]`,
				);
				return;
			}

			const sessionPath = getSessionFilePath(ctx.cwd, parsed.topic);
			const existing =
				parsed.continueSession && !parsed.explicitNew
					? await loadSession(sessionPath)
					: null;

			if (parsed.continueSession && !existing) {
				await ctx.ui.notify(
					`Nessuna sessione esistente per "${parsed.topic}" — avvio da zero.`,
				);
			}

			const continuation = existing
				? { transcript: existing.transcript, roundOffset: existing.rounds }
				: undefined;
			const totalRoundsToRun = parsed.rounds + (existing?.rounds ?? 0);

			const modelInfo = parsed.modelOverride
				? `, modello forzato: ${parsed.modelOverride}`
				: "";

			await ctx.ui.notify(
				`Avvio discussion-arena su: "${parsed.topic}" — ${participants.length} partecipanti, ${parsed.rounds} round(s) da eseguire (totale sessione: ${totalRoundsToRun})${modelInfo}.`,
			);

			const { transcript, participantsUsed, totalCost } = await runDiscussionArena(
				parsed.topic,
				undefined,
				parsed.rounds,
				ctx.cwd,
				undefined,
				() => {},
				async (roundIndex, cumulative, cost) => {
					await ctx.ui.notify(
						`[Round ${roundIndex} di ${totalRoundsToRun} completato — costo cumulato $${cost.toFixed(4)}]\n\n${cumulative}`,
					);
				},
				continuation,
				parsed.modelOverride,
			);

			const now = new Date().toISOString();
			const session: DiscussionArenaSession = {
				topic: parsed.topic,
				participants: participantsUsed,
				startedAt: existing?.startedAt ?? now,
				lastUpdatedAt: now,
				rounds: totalRoundsToRun,
				transcript,
			};
			await saveSession(sessionPath, session);

			await ctx.ui.notify(
				`Discussion arena completata — ${participantsUsed.join(", ")} — ${totalRoundsToRun} round(s) totali (${parsed.rounds} nuovi) — costo cumulato $${totalCost.toFixed(4)}.\n\nSession salvata: ${sessionPath}\n\nTranscript finale:\n\n${transcript}`,
			);
		},
	});
}
