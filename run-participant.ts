/**
 * Agent Discussion Arena — Participant execution
 *
 * Esegue un singolo partecipante come sottoprocesso `gsd` isolato in
 * modalità print/JSON, con contesto azzerato (--no-session) e system prompt
 * di ruolo iniettato via --append-system-prompt.
 *
 * Pattern di spawn e parsing eventi copiato 1:1 da
 * packages/pi-coding-agent/examples/extensions/subagent/index.ts (runSingleAgent),
 * con una sola modifica strutturale: il binario invocato è `gsd`, non `pi`,
 * perché l'arena gira dentro il processo gsd-pi, non pi vanilla.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ParticipantConfig } from "./participants.js";

export interface ParticipantTurnResult {
	participant: string;
	role: string;
	exitCode: number;
	text: string;
	stderr: string;
	usage: { input: number; output: number; cost: number; turns: number };
}

/** Scrive il system prompt in un file temporaneo (evita limiti di lunghezza argv). */
async function writePromptToTempFile(name: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `gsd-arena-${name}-`));
	const filePath = path.join(dir, "system-prompt.md");
	await fs.promises.writeFile(filePath, prompt, "utf-8");
	return { dir, filePath };
}

function getGsdInvocation(args: string[]): { command: string; args: string[] } {
	// A differenza del subagent example (che rileva se sta girando dentro il
	// binario pi compilato per auto-invocarsi), qui assumiamo `gsd` presente
	// in PATH — è la stessa assunzione che fa già il resto di gsd-pi per i
	// comandi worktree/CLI. Se in futuro serve il fallback all'eseguibile
	// corrente compilato, applicare la stessa logica di getPiInvocation().
	return { command: "gsd", args };
}

/**
 * Esegue un turno di un partecipante: riceve il topic/transcript accumulato
 * come task, restituisce il suo intervento testuale.
 */
export async function runParticipantTurn(
	participant: ParticipantConfig,
	promptForThisTurn: string,
	cwd: string,
	signal: AbortSignal | undefined,
): Promise<ParticipantTurnResult> {
	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (participant.model) args.push("--model", participant.model);
	if (participant.tools && participant.tools.length > 0) args.push("--tools", participant.tools.join(","));

	let tmpDir: string | null = null;
	const result: ParticipantTurnResult = {
		participant: participant.name,
		role: participant.role,
		exitCode: 0,
		text: "",
		stderr: "",
		usage: { input: 0, output: 0, cost: 0, turns: 0 },
	};

	try {
		if (participant.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(participant.name, participant.systemPrompt);
			tmpDir = tmp.dir;
			args.push("--append-system-prompt", tmp.filePath);
		}

		args.push(promptForThisTurn);

		const invocation = getGsdInvocation(args);

		const exitCode = await new Promise<number>((resolve, reject) => {
			const proc = spawn(invocation.command, invocation.args, {
				cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});

			let buffer = "";
			let lastAssistantText = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message?.role === "assistant") {
					result.usage.turns++;
					const usage = event.message.usage;
					if (usage) {
						result.usage.input += usage.input || 0;
						result.usage.output += usage.output || 0;
						result.usage.cost += usage.cost || 0;
					}
					const textParts = (event.message.content ?? [])
						.filter((c: any) => c.type === "text")
						.map((c: any) => c.text);
					if (textParts.length > 0) lastAssistantText = textParts.join("\n");
				}
			};

			proc.stdout?.on("data", (chunk: Buffer) => {
				buffer += chunk.toString("utf-8");
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) processLine(line);
			});

			proc.stderr?.on("data", (chunk: Buffer) => {
				result.stderr += chunk.toString("utf-8");
			});

			proc.on("error", (err: Error) => reject(err));
			proc.on("close", (code: number | null) => {
				if (buffer.trim()) processLine(buffer);
				result.text = lastAssistantText;
				resolve(code ?? 1);
			});

			signal?.addEventListener("abort", () => proc.kill("SIGTERM"), { once: true });
		});

		result.exitCode = exitCode;
	} finally {
		if (tmpDir) {
			await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
		}
	}

	return result;
}
