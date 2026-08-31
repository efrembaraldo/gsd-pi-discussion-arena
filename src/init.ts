/**
 * src/init.ts — Scaffold idempotente e non-distruttivo delle cartelle di
 * progetto della discussion-arena (S03/M017, T01).
 *
 * Espone l'inizializzazione del coordination tree per il comando slash
 * `/discussion-arena-init` (wiring in T02):
 *
 *  - `runInit(cwd, opts?)` — funzione PURA: nessun I/O su stdout/stderr/
 *    exit. Ritorna un `InitResult` con i path creati / skippati / errori
 *    così il chiamante decide dove scrivere il sommario (testabile in-
 *    process senza mock di process.stderr / process.exit, D020);
 *  - `runInitCli(cwd)` — wrapper side-effect: invoca `runInit` con un
 *    `InitLogger` di default che scrive su stderr con il prefisso canonico
 *    `[discussion-arena-init]` (speculare a `[copy-template]` di S01 e
 *    `[discussion-arena]` di S02, D053). Ritorna il `InitResult` completo
 *    — NON una forma ridotta — perché l'handler T02 ne ha bisogno per
 *    mostrare il sommario via `ctx.ui.notify`.
 *
 * Pattern pure/CLI split (S02): speculare a `dumpParticipants` +
 * `dumpParticipantsCli` in `src/discussion-arena-cli.ts` (M004/S02/T01).
 *
 * Naming policy: usare la forma canonica hyphenated `discussion-arena` per
 * ogni riferimento lessicale. Il guard di regressione
 * `tests/naming-residue.test.ts` valida il perimetro automaticamente.
 *
 * Zero dipendenze npm (D004): solo `node:fs` e `node:path`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { DISCUSSION_ARENA_COORDINATION_DIR } from "./discussion-arena-coordination.js";

/**
 * Sub-directory canoniche del coordination tree di progetto. L'ordine
 * rispecchia il livello di referenziazione nel codice esistente
 * (`participants.ts:30`, `participants.ts:16`, `README.md:154`): prima
 * `participants/` (più referenziata), poi gli override, poi i transcript.
 * Riusato da `runInit` per la creazione idempotente delle subdir e da
 * test T03 per asserzioni di copertura.
 */
const INIT_SUBDIRS: readonly string[] = [
	"participants",
	"participants-overrides",
	"transcripts",
];

/** Nome canonico del marker file che tiene le subdir vuote sotto git. */
const GITKEEP_FILENAME = ".gitkeep";

/**
 * Risultato dell'inizializzazione: sempre popolato (anche su errore,
 * failure-safe come `copyTemplate` di S01).
 *
 *  - `created`: path effettivamente creati da `runInit` (root + subdir).
 *    I file `.gitkeep` NON sono entry separate di `created`: sono un
 *    dettaglio della creazione di una subdir e vengono creati solo se la
 *    subdir stessa è stata appena creata (mai iniettati in subdir
 *    preesistenti, anche se prive di `.gitkeep` o con file utente come
 *    `participants/analyst.md`);
 *  - `skipped`: path già esistenti e NON toccati (idempotenza + non-
 *    distruzione dei file utente);
 *  - `errors`: messaggi di errore raccolti durante il loop; la funzione
 *    NON lancia mai, ritorna un risultato parziale.
 */
export interface InitResult {
	created: string[];
	skipped: string[];
	errors: string[];
}

/** Logger iniettabile (test in-process senza mock di `process.stderr`). */
export type InitLogger = (message: string) => void;

/**
 * Crea in modo idempotente e non-distruttivo il coordination tree della
 * discussion-arena sotto `<cwd>/<DISCUSSION_ARENA_COORDINATION_DIR>`.
 *
 * Comportamento:
 *  - root: `mkdirSync(root, { recursive: true })` solo se assente,
 *    altrimenti `skipped` (NON toccato);
 *  - per ogni subdir in `INIT_SUBDIRS`:
 *    - `mkdirSync(subPath, { recursive: true })` solo se assente;
 *    - `.gitkeep` scritto solo in concomitanza con la creazione della
 *      subdir (le subdir preesistenti NON vengono toccate, anche se
 *      prive di `.gitkeep` o se contengono file utente);
 *  - errori raccolti in `errors`, MAI lanciati: ritorna sempre un
 *    `InitResult` (anche parziale).
 *
 * Se `opts.logger` è passato, viene invocato per ogni path in `created`
 * (subito dopo l'effettiva creazione) e in caso di errore. Senza logger
 * la funzione è totalmente priva di side-effect su stderr / stdout.
 *
 * Su tmpdir vuota `created.length === 4` (root + 3 subdir); una seconda
 * invocazione ritorna `created.length === 0` e `skipped.length === 4`.
 */
export function runInit(
	cwd: string,
	opts?: { logger?: InitLogger },
): InitResult {
	const result: InitResult = { created: [], skipped: [], errors: [] };
	const logger = opts?.logger;

	try {
		const root = path.join(cwd, DISCUSSION_ARENA_COORDINATION_DIR);

		if (!fs.existsSync(root)) {
			fs.mkdirSync(root, { recursive: true });
			result.created.push(root);
			if (logger) logger(`created ${root}`);
		} else {
			result.skipped.push(root);
		}

		for (const subdir of INIT_SUBDIRS) {
			const subPath = path.join(root, subdir);
			if (!fs.existsSync(subPath)) {
				fs.mkdirSync(subPath, { recursive: true });
				fs.writeFileSync(path.join(subPath, GITKEEP_FILENAME), "");
				result.created.push(subPath);
				if (logger) logger(`created ${subPath}`);
			} else {
				result.skipped.push(subPath);
			}
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		result.errors.push(message);
		if (logger) logger(`error ${message}`);
	}

	return result;
}

/**
 * Wrapper side-effect di `runInit` (S03/M017/T01).
 *
 * Invoca `runInit(cwd)` con un `InitLogger` di default che scrive su
 * stderr con il prefisso canonico `[discussion-arena-init]` (speculare
 * a `[discussion-arena]` di S02 e `[copy-template]` di S01, D053). Ritorna
 * il `InitResult` completo per consentire all'handler T02 di mostrare un
 * sommario strutturato via `ctx.ui.notify` (root + subdir creati,
 * eventuali skip / errori).
 */
export function runInitCli(cwd: string): InitResult {
	const logger: InitLogger = (message: string) => {
		process.stderr.write(`[discussion-arena-init] ${message}\n`);
	};
	return runInit(cwd, { logger });
}
