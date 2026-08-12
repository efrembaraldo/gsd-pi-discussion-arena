/**
 * Helper condivisi per i test acceptance end-to-end di M004/S05 (T02-T04).
 *
 * I tre acceptance scenario del CONTEXT M004 esercitano `runDiscussionArena`
 * con il subprocess `gsd` REALE (runTurn omesso -> default
 * `runParticipantTurn`): il fixture fake-gsd in testa a PATH viene risolto
 * dallo spawn (pattern discussion-arena-loop.test.ts sezione (h) e
 * timeout-watchdog.test.ts). Nessuna logica di produzione è toccata: questo
 * modulo è superficie di test pura, condivisa dai tre file di scenario.
 *
 * Cosa offre:
 *  - `installFakeGsdInPath()` / `restoreFakeGsdPath()`: prepend idempotente
 *    della directory fake-gsd in PATH (un solo install per file di test, nel
 *    `before`; lo spawn di `runParticipantTurn` risolve `gsd` qui).
 *  - `makeAcceptanceFixture()`: tmpdir con la gerarchia per-progetto reale
 *    (`.gsd/discussion-arena/participants` + `participants-overrides`) e la
 *    dir utente isolata via `GSD_AGENT_DIR` (pattern pi-coding-agent-stub),
 *    così il discovery non legge la user dir reale di chi esegue i test.
 *  - `writeParticipantMd()`: scrive un participant `.md` (frontmatter + body)
 *    sia per `participants/` sia per `participants-overrides/` — stesso
 *    formato, un solo helper (D-round: mai bifurcare la sintassi base/override).
 *  - `captureStderrChunks()`: cattura le scritture su stderr del processo di
 *    test per asserire i log di trasparenza canonici (`[discussion-arena]
 *    override applied: ...`, `virtual role applied: ...`).
 *  - `cleanupFixture()`: rimozione best-effort del tmpdir (afterEach).
 *
 * Nota sul topic con direttiva: il fixture fake-gsd risolve la propria mode
 * dalle direttive `DIRECTIVE:<name>:<mode>` nel prompt (costruito da
 * `buildRoundPrompt` includendo il topic), quindi ogni scenario mette la
 * direttiva nel topic, es. `DIRECTIVE:analyst:echo-prompt — <tema>`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { GSD_AGENT_DIR_ENV } from "./pi-coding-agent-stub.js";

/** Directory del binario fake `gsd` (questa directory, sottofixture `fake-gsd`). */
export const FAKE_GSD_DIR = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"fake-gsd",
);

// ─── PATH: il binario `gsd` finto deve vincere sul reale ───────────────────
// Ogni file di test viene eseguito da `node --test` in un processo separato,
// quindi lo stato module-level non collide tra file. Dentro lo stesso file,
// `installFakeGsdInPath()` è idempotente: chiamarla nel `before` una volta è
// sufficiente anche se più test dello scenario spawnano subprocess.
let originalPath: string | undefined;
let fakeGsdInstalled = false;

export function installFakeGsdInPath(): void {
	if (fakeGsdInstalled) return;
	fakeGsdInstalled = true;
	originalPath = process.env.PATH;
	process.env.PATH = `${FAKE_GSD_DIR}${path.delimiter}${originalPath ?? ""}`;
}

export function restoreFakeGsdPath(): void {
	if (!fakeGsdInstalled) return;
	fakeGsdInstalled = false;
	if (originalPath === undefined) {
		delete process.env.PATH;
	} else {
		process.env.PATH = originalPath;
	}
	originalPath = undefined;
}

// ─── Fixture per-progetto ───────────────────────────────────────────────────

export interface AcceptanceFixture {
	/** Radice del tmpdir: è anche il `cwd` passato a runDiscussionArena (e quindi allo spawn). */
	root: string;
	/** `root/.gsd/discussion-arena` — contiene participants/, participants-overrides/ e (in T03) il coordination file. */
	arenaDir: string;
	/** `root/.gsd/discussion-arena/participants` (tier project, walk-up dal cwd). */
	participantsDir: string;
	/** `root/.gsd/discussion-arena/participants-overrides` (tier 0, walk-up dal cwd). */
	overridesDir: string;
	/** `root/agent` — dir utente isolata (GSD_AGENT_DIR), nessun leak della user dir reale. */
	agentDir: string;
	/** `cwd` da passare a `runDiscussionArena`. */
	cwd: string;
}

/**
 * Crea la fixture per-progetto completa:
 *  - tmpdir in os.tmpdir();
 *  - gerarchia `.gsd/discussion-arena/{participants,participants-overrides}`;
 *  - dir utente `root/agent` puntata da `GSD_AGENT_DIR` (isolamento).
 *
 * Il walk-up di `discoverParticipants` parte da `cwd === root` e trova la
 * gerarchia project al primo livello; gli antenati di un tmpdir in /tmp non
 * contengono `.gsd/`, quindi nessuna interferenza con checkout reali.
 */
export function makeAcceptanceFixture(): AcceptanceFixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-arena-acceptance-"));
	const arenaDir = path.join(root, ".gsd", "discussion-arena");
	const participantsDir = path.join(arenaDir, "participants");
	const overridesDir = path.join(arenaDir, "participants-overrides");
	fs.mkdirSync(participantsDir, { recursive: true });
	fs.mkdirSync(overridesDir, { recursive: true });
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(agentDir, { recursive: true });
	process.env[GSD_AGENT_DIR_ENV] = agentDir;
	return { root, arenaDir, participantsDir, overridesDir, agentDir, cwd: root };
}

/** Rimozione best-effort del tmpdir (chiamare in afterEach). */
export function cleanupFixture(root: string): void {
	try {
		fs.rmSync(root, { recursive: true, force: true });
	} catch {
		// best-effort: un tmpdir orfano in /tmp non blocca il test
	}
}

// ─── Scrittura participant .md ──────────────────────────────────────────────

export interface ParticipantMdOptions {
	name: string;
	role: string;
	description?: string;
	/** Campo frontmatter `model:` (assente se undefined). */
	model?: string;
	/** Righe frontmatter arbitrarie aggiuntive (es. limiti per-participante). */
	extraRows?: string[];
	/** Body markdown dopo il frontmatter = system prompt del ruolo. */
	body?: string;
}

/**
 * Scrive un participant `.md` (frontmatter + body) in `dir`. Usato sia per i
 * file base in `participants/` sia per gli override in `participants-overrides/`
 * (stesso formato, un solo helper — il tier 0 è sostituzione totale del file).
 * Ritorna il path assoluto scritto, per asserire il log di trasparenza
 * `[discussion-arena] override applied: <role> from <path>`.
 */
export function writeParticipantMd(
	dir: string,
	filename: string,
	opts: ParticipantMdOptions,
): string {
	const rows = [
		`name: ${opts.name}`,
		`role: ${opts.role}`,
		`description: ${opts.description ?? opts.name}`,
		...(opts.model ? [`model: ${opts.model}`] : []),
		...(opts.extraRows ?? []),
	];
	const filePath = path.join(dir, filename);
	fs.writeFileSync(
		filePath,
		`---\n${rows.join("\n")}\n---\n\n${opts.body ?? `System prompt di ${opts.name}.`}\n`,
		"utf-8",
	);
	return filePath;
}

// ─── Cattura stderr del processo di test ────────────────────────────────────

/**
 * Cattura i chunk scritti su stderr durante `fn`. I log di trasparenza di
 * `discoverParticipants` (`override applied: ...`, `virtual role applied: ...`)
 * e di `runDiscussionArena` (`limits <name>: ...`) sono scritti su
 * `process.stderr` del processo di test: per asserirli serve intercettare il
 * write (pattern captureStderrChunks di discussion-arena-loop.test.ts). Lo
 * stderr dei SUBPROCESS resta invece in `result.stderr` di ogni turno e non
 * transita qui.
 */
export async function captureStderrChunks<T>(
	fn: () => Promise<T>,
): Promise<{ value: T; chunks: string[] }> {
	const original = process.stderr.write.bind(process.stderr);
	const chunks: string[] = [];
	process.stderr.write = ((chunk: unknown) => {
		chunks.push(String(chunk));
		return true;
	}) as unknown as typeof process.stderr.write;
	try {
		const value = await fn();
		return { value, chunks };
	} finally {
		process.stderr.write = original;
	}
}
