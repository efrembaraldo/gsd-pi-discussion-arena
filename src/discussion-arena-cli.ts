/**
 * CLI di diagnostica della discussion-arena (S02/M004).
 *
 * Espone il dump post-override dei partecipanti disponibili: un elenco
 * human-readable con nome, path sorgente e tier (override / project / user /
 * bundled) che permette di ispezionare la configurazione partecipanti senza
 * leggere il filesystem a mano (Slice Verification S02).
 *
 * Separazione di responsabilità (D-round 5 dev):
 *  - `dumpParticipants(cwd, opts?)` — funzione PURA: nessun I/O su stdout/
 *    stderr, nessun `process.exit`. Ritorna `{output, exitCode}` così il
 *    chiamante decide dove scrivere e come terminare (testabile in-process
 *    senza mock di process.stdout/process.exit, D020).
 *  - `dumpParticipantsCli(argv, cwd)` — side-effect: parsa `argv` per il flag
 *    `--dump-participants`, scrive l'output sullo stream giusto (stdout su
 *    successo, stderr su errore) ed esce con l'exit code.
 *
 * Forward-compat S03: `DiscoverParticipantsOptions.coordinationPath` è
 * trasportato ma NON consumato — i virtual roles (`(virtual role from
 * discussion-arena-coordination.md)`) saranno popolati da S03; qui la firma
 * resta pronta senza rendere alcun marker.
 *
 * Zero dipendenze npm (D004): solo node:os/node:path + il modulo
 * participants.ts esistente.
 */

import * as os from "node:os";
import * as path from "node:path";
import {
	discoverParticipants,
	type DiscoverParticipantsOptions,
} from "../participants.js";

export interface DumpParticipantsResult {
	/** Testo canonico da stampare (lista partecipanti o messaggio di errore). */
	output: string;
	/** 0 su successo, 1 se la discovery fallisce (es. override orfano). */
	exitCode: number;
}

/**
 * Path sorgente in forma leggibile per il dump:
 *  - relativo al cwd quando il file sta sotto il cwd (es.
 *    `.gsd/discussion-arena/participants-overrides/analyst.md`);
 *  - con prefisso `~` quando sta sotto la home utente (es.
 *    `~/.gsd/agent/discussion-arena/participants/dev.md`);
 *  - assoluto in ogni altro caso (es. bundled da node_modules esterna).
 */
function displayPath(filePath: string, cwd: string): string {
	const base = path.resolve(cwd);
	const rel = path.relative(base, filePath);
	if (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)) {
		return rel;
	}
	const home = os.homedir();
	if (filePath.startsWith(home + path.sep)) {
		return "~" + filePath.slice(home.length);
	}
	return filePath;
}

/**
 * Dump puro dei partecipanti post-override (S02).
 *
 * Output canonico:
 *  - `[no overrides active]` quando la directory override è assente o non ha
 *    alcun override applicato (dir vuota o tutti i file scartati come
 *    incompleti — i log stderr di discoverParticipants spiegano il perché);
 *  - una riga per partecipante, colonne allineate con `padEnd`, formato
 *    `<name>source: <path> (<source>)` con source ∈ override|project|user|
 *    bundled (ordine alfabetico per determinismo);
 *  - su errore di discovery (es. override orfano: discoverParticipants
 *    lancia) ritorna il messaggio canonico in `output` con exitCode 1 — mai
 *    un throw: il contratto è `{output, exitCode}`.
 */
export function dumpParticipants(
	cwd: string,
	options: DiscoverParticipantsOptions = {},
): DumpParticipantsResult {
	try {
		const result = discoverParticipants(cwd, options);

		const hasActiveOverride = result.participants.some(
			(p) => p.source === "override",
		);
		if (result.overridesDir === null || !hasActiveOverride) {
			return { output: "[no overrides active]\n", exitCode: 0 };
		}

		const width =
			Math.max(...result.participants.map((p) => p.name.length)) + 2;
		const rows = [...result.participants]
			.sort((a, b) => a.name.localeCompare(b.name))
			.map(
				(p) =>
					`${p.name.padEnd(width)}source: ${displayPath(p.filePath, cwd)} (${p.source})`,
			);
		return { output: rows.join("\n") + "\n", exitCode: 0 };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { output: `[discussion-arena] ${message}\n`, exitCode: 1 };
	}
}

/**
 * Wrapper side-effect del dump (S02).
 *
 * Parsa `argv` per il flag `--dump-participants` (flag booleano, scope S02:
 * niente parsing di parametri aggiuntivi — vedi 04-02-RESEARCH Known
 * Limitations). Con flag presente scrive l'output su stdout (exitCode 0) o
 * su stderr (exitCode 1) e termina il processo con `process.exit(exitCode)`;
 * senza flag è un no-op che ritorna 0.
 */
export function dumpParticipantsCli(
	argv: readonly string[],
	cwd: string,
): number {
	if (!argv.includes("--dump-participants")) return 0;

	const { output, exitCode } = dumpParticipants(cwd);
	if (exitCode === 0) {
		process.stdout.write(output);
	} else {
		process.stderr.write(output);
	}
	process.exit(exitCode);
	return exitCode;
}
