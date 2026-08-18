/**
 * tests/unit/pending-research-lock.test.ts — T02/M011/S01.
 *
 * Suite del lock file cross-process per la pipeline pending-research:
 *
 *   - creazione esclusiva (O_CREAT|O_EXCL): due processi distinti non entrano
 *     MAI simultaneamente nella sezione critica; esattamente uno vince, gli
 *     altri serializzano;
 *   - attesa bounded: un waiter riceve il lock appena il precedente rilascia,
 *     oppure solleva `PendingResearchLockTimeoutError` strutturato al timeout;
 *   - stale recovery: lock abbandonati (owner morto da più di `staleAfterMs`)
 *     vengono unlinked e rimpiazzati dal nuovo owner;
 *   - release idempotente: doppio rilascio è no-op (`reason: "absent"`);
 *   - release ownership-safe: se il lock è stato "rubato" (recovery di un
 *     altro owner), il rilascio NON rimuove il lock altrui (`reason: "stolen"`);
 *   - log stderr strutturato con prefisso canonico `[discussion-arena]` per
 *     acquisizione, attesa, stale-recovery, timeout e rilascio;
 *   - `withPendingResearchLock` garantisce rilascio sia su successo sia su
 *     throw di `fn`;
 *   - cross-process demo: due subprocessi Node distinti che incrementano un
 *     contatore condiviso sotto lock producono `2`, mai `1` (read-modify-write
 *     atomico).
 *
 * I test cross-process spawnano subprocessi Node reali (via `spawn`), così la
 * barriera `open(path, "wx")` viene esercitata in processi distinti (la
 * proprietà di esclusività è del kernel, non di un singolo address space).
 *
 * Tutti i tmpdir sono locali al test (`os.tmpdir()`), mai path di progetto.
 */

// Allineato al pattern di tests/unit/hooks-unit-aware-getter.test.ts (T01):
// niente self-import del loader (risiederebbe a `../ts-esm-loader.mjs`, non
// a `./ts-esm-loader.mjs`); il loader globale è registrato dal flag
// `--import ./tests/ts-esm-loader.mjs` che la verify command passa a `node
// --test`. Static import dal source: TS strippa il tipo a compile-time e il
// resolve hook (`.js` -> `.ts`) gestisce il remapping a runtime.
import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
	acquirePendingResearchLock,
	releasePendingResearchLock,
	withPendingResearchLock,
	pendingResearchLockPath,
	PendingResearchLockTimeoutError,
	PENDING_RESEARCH_LOCK_FILENAME,
} from "../../src/discussion-arena-pending-research.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Root del repo (per spawnare child con path assoluti). */
const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const SRC_FILE = path.join(REPO_ROOT, "src", "discussion-arena-pending-research.ts");
const LOADER_FILE = path.join(REPO_ROOT, "tests", "ts-esm-loader.mjs");

/** Crea un workspace dir temporaneo per i test del lock. */
async function createTmpDir(): Promise<string> {
	return await fs.mkdtemp(path.join(os.tmpdir(), "pending-lock-test-"));
}

/** Raccoglitore stderr in-memory per asserire i log strutturati. */
function collectStderr(): {
	stream: NodeJS.WritableStream;
	lines: () => string[];
} {
	const lines: string[] = [];
	const stream = {
		write: (chunk: unknown) => {
			lines.push(String(chunk).replace(/\n$/, ""));
			return true;
		},
	} as NodeJS.WritableStream;
	return { stream, lines: () => lines };
}

/** Pre-popola un lock file con stato raw (per test stale-recovery). */
async function seedLockFile(
	lockPath: string,
	state: { pid: number; createdAtMs: number },
): Promise<void> {
	const dir = path.dirname(lockPath);
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(lockPath, JSON.stringify(state), "utf-8");
}

/** true se il lock file esiste su disco. */
async function lockExists(lockPath: string): Promise<boolean> {
	try {
		await fs.access(lockPath);
		return true;
	} catch {
		return false;
	}
}

// =============================================================================
// Single-process: claim, attesa, recovery, ownership, idempotenza.
// =============================================================================

test("acquire: lock file assente → handle creato, file con JSON {pid, createdAtMs}", async () => {
	const cwd = await createTmpDir();
	try {
		const { stream } = collectStderr();
		const handle = await acquirePendingResearchLock(cwd, { stderr: stream });

		const lockPath = pendingResearchLockPath(cwd);
		assert.equal(path.basename(lockPath), PENDING_RESEARCH_LOCK_FILENAME);
		assert.equal(
			await lockExists(lockPath),
			true,
			"lock file creato su disco dopo acquire",
		);

		const raw = await fs.readFile(lockPath, "utf-8");
		const parsed = JSON.parse(raw);
		assert.equal(parsed.pid, process.pid);
		assert.equal(typeof parsed.createdAtMs, "number");
		assert.equal(parsed.createdAtMs, handle.createdAtMs, "handle.createdAtMs === file");

		await releasePendingResearchLock(handle, { stderr: stream });
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

test("acquire: log di acquisizione con prefisso canonico [discussion-arena]", async () => {
	const cwd = await createTmpDir();
	try {
		const { stream, lines } = collectStderr();
		const handle = await acquirePendingResearchLock(cwd, { stderr: stream });
		try {
			const logText = lines().join("\n");
			assert.match(
				logText,
				/\[discussion-arena\] pending-research: lock acquired .* pid=\d+/,
				"log acquisizione con prefisso canonico e PID",
			);
		} finally {
			await releasePendingResearchLock(handle, { stderr: stream });
		}
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

test("acquire: directory .gsd/discussion-arena/ creata ricorsivamente se assente", async () => {
	const cwd = await createTmpDir();
	try {
		// La dir `.gsd/discussion-arena/` NON esiste — deve essere creata.
		const lockPath = pendingResearchLockPath(cwd);
		assert.equal(await lockExists(lockPath), false);

		const { stream } = collectStderr();
		const handle = await acquirePendingResearchLock(cwd, { stderr: stream });
		try {
			assert.equal(await lockExists(lockPath), true);
			const dir = path.dirname(lockPath);
			const stat = await fs.stat(dir);
			assert.equal(stat.isDirectory(), true);
		} finally {
			await releasePendingResearchLock(handle, { stderr: stream });
		}
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

test("release: idempotente (doppia release è no-op, reason='absent')", async () => {
	const cwd = await createTmpDir();
	try {
		const { stream } = collectStderr();
		const handle = await acquirePendingResearchLock(cwd, { stderr: stream });

		const r1 = await releasePendingResearchLock(handle, { stderr: stream });
		assert.deepEqual(r1, { released: true, reason: "ok" });

		const r2 = await releasePendingResearchLock(handle, { stderr: stream });
		assert.deepEqual(r2, { released: false, reason: "absent" });

		const r3 = await releasePendingResearchLock(handle, { stderr: stream });
		assert.deepEqual(r3, { released: false, reason: "absent" });
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

test("release: ownership-safe — lock 'rubato' (owner diverso) NON rimosso", async () => {
	const cwd = await createTmpDir();
	try {
		const { stream, lines } = collectStderr();
		const handle = await acquirePendingResearchLock(cwd, { stderr: stream });

		// Simula "furto": un altro owner ha fatto stale-recovery e ha
		// sovrascritto il lock con pid+timestamp diversi dal nostro handle.
		const lockPath = pendingResearchLockPath(cwd);
		const stolenState = JSON.stringify({
			pid: 99999,
			createdAtMs: Date.now() - 1000,
		});
		await fs.writeFile(lockPath, stolenState, "utf-8");

		const r = await releasePendingResearchLock(handle, { stderr: stream });
		assert.equal(r.released, false);
		assert.equal(r.reason, "stolen", "rilascio rifiutato per ownership altrui");

		// Il lock "rubato" deve essere ancora su disco, byte-per-byte invariato.
		const stillThere = await fs.readFile(lockPath, "utf-8");
		assert.equal(stillThere, stolenState, "lock altrui NON rimosso");

		const logText = lines().join("\n");
		assert.match(
			logText,
			/\[discussion-arena\] pending-research: lock release-stolen/,
			"log structured per ownership rifiutato",
		);
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

test("acquire: stale recovery — lock con createdAtMs oltre staleAfterMs viene recuperato", async () => {
	const cwd = await createTmpDir();
	try {
		const { stream, lines } = collectStderr();
		const lockPath = pendingResearchLockPath(cwd);

		// Pre-popola un lock stale: PID finto, timestamp 60s fa.
		await seedLockFile(lockPath, {
			pid: 99999,
			createdAtMs: Date.now() - 60_000,
		});

		const handle = await acquirePendingResearchLock(cwd, {
			staleAfterMs: 30_000,
			pollIntervalMs: 10,
			timeoutMs: 1000,
			stderr: stream,
		});
		try {
			// Dopo recovery il lock deve essere del processo corrente.
			const raw = await fs.readFile(lockPath, "utf-8");
			const parsed = JSON.parse(raw);
			assert.equal(
				parsed.pid,
				process.pid,
				"owner del lock ora è il processo corrente dopo stale-recovery",
			);
			assert.notEqual(parsed.pid, 99999, "il vecchio owner fittizio non è più lì");

			const logText = lines().join("\n");
			assert.match(
				logText,
				/\[discussion-arena\] pending-research: lock stale-recovery pid=99999/,
				"log structured per stale-recovery cita il vecchio pid",
			);
			assert.match(
				logText,
				/\[discussion-arena\] pending-research: lock acquired .* pid=/,
				"log structured per acquisizione post-recovery",
			);
		} finally {
			await releasePendingResearchLock(handle, { stderr: stream });
		}
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

test("acquire: lock file corrotto (JSON non valido) → recovery opportunistico senza errori", async () => {
	const cwd = await createTmpDir();
	try {
		const lockPath = pendingResearchLockPath(cwd);
		await seedLockFile(lockPath, { pid: 0, createdAtMs: 0 });
		await fs.writeFile(lockPath, "not-json-at-all{", "utf-8");

		const { stream } = collectStderr();
		const handle = await acquirePendingResearchLock(cwd, {
			timeoutMs: 500,
			pollIntervalMs: 10,
			staleAfterMs: 60_000,
			stderr: stream,
		});
		try {
			// Il file è stato sovrascritto dal nostro stato valido.
			const raw = await fs.readFile(lockPath, "utf-8");
			const parsed = JSON.parse(raw);
			assert.equal(parsed.pid, process.pid);
		} finally {
			await releasePendingResearchLock(handle, { stderr: stream });
		}
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

test("acquire: timeout — lock attivo (non stale) tenuto oltre timeoutMs solleva PendingResearchLockTimeoutError", async () => {
	const cwd = await createTmpDir();
	try {
		const { stream, lines } = collectStderr();
		const lockPath = pendingResearchLockPath(cwd);

		// Lock "non stale" (createdAtMs = now, age 0 < staleAfterMs): non verrà
		// recuperato, il waiter deve ciclare fino al timeout.
		await seedLockFile(lockPath, {
			pid: 99999,
			createdAtMs: Date.now(),
		});

		const before = Date.now();
		await assert.rejects(
			acquirePendingResearchLock(cwd, {
				timeoutMs: 200,
				pollIntervalMs: 20,
				staleAfterMs: 60_000, // non recupera
				stderr: stream,
			}),
			(err: unknown) => {
				assert.ok(
					err instanceof PendingResearchLockTimeoutError,
					"errore è PendingResearchLockTimeoutError",
				);
				const e = err as PendingResearchLockTimeoutError;
				assert.equal(e.lockPath, lockPath);
				assert.equal(e.ownerPid, 99999, "ownerPid riflette il PID del blocker");
				assert.ok(
					e.waitedMs >= 200,
					`waitedMs >= timeoutMs (era ${e.waitedMs})`,
				);
				assert.match(
					e.message,
					/pending-research lock timeout after \d+ms \(owner pid=99999\)/,
				);
				return true;
			},
		);
		const elapsed = Date.now() - before;
		assert.ok(elapsed >= 200, `attesa rispetta il timeout (era ${elapsed}ms)`);
		assert.ok(elapsed < 2000, `attesa non eccede di molto il timeout (era ${elapsed}ms)`);

		const logText = lines().join("\n");
		assert.match(
			logText,
			/\[discussion-arena\] pending-research: lock wait pid=99999/,
			"log structured per attesa cita il PID del blocker",
		);
		assert.match(
			logText,
			/\[discussion-arena\] pending-research: lock timeout pid=99999 waited=\d+ms/,
			"log structured per timeout cita PID e attesa",
		);
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

// =============================================================================
// withPendingResearchLock: convenience wrapper.
// =============================================================================

test("withPendingResearchLock: ritorna il valore di fn e rilascia il lock dopo success", async () => {
	const cwd = await createTmpDir();
	try {
		const { stream } = collectStderr();
		const result = await withPendingResearchLock(
			cwd,
			async () => 42,
			{ stderr: stream },
		);
		assert.equal(result, 42);

		const lockPath = pendingResearchLockPath(cwd);
		assert.equal(
			await lockExists(lockPath),
			false,
			"lock rilasciato dopo che fn è terminata con successo",
		);
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

test("withPendingResearchLock: rilascia il lock anche se fn throws (errore propagato)", async () => {
	const cwd = await createTmpDir();
	try {
		const { stream } = collectStderr();
		await assert.rejects(
			withPendingResearchLock(
				cwd,
				async () => {
					throw new Error("boom");
				},
				{ stderr: stream },
			),
			// Node `assert.rejects` applica `String(err)` per il match RegExp:
			// `new Error("boom").toString()` === "Error: boom", non "boom".
			// Matchiamo il messaggio puro via predicato strutturale per non
			// dipendere da dettagli di formattazione di `Error.toString`.
			(err: unknown) =>
				err instanceof Error &&
				err.message === "boom",
		);

		const lockPath = pendingResearchLockPath(cwd);
		assert.equal(
			await lockExists(lockPath),
			false,
			"lock rilasciato anche dopo throw di fn",
		);
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

test("withPendingResearchLock: se acquire fallisce (timeout) fn non viene mai chiamata", async () => {
	const cwd = await createTmpDir();
	try {
		const lockPath = pendingResearchLockPath(cwd);
		await seedLockFile(lockPath, {
			pid: 99999,
			createdAtMs: Date.now(),
		});

		let fnCalled = false;
		await assert.rejects(
			withPendingResearchLock(
				cwd,
				async () => {
					fnCalled = true;
					return "should-not-run";
				},
				{
					timeoutMs: 100,
					pollIntervalMs: 20,
					staleAfterMs: 60_000,
				},
			),
			(err: unknown) => err instanceof PendingResearchLockTimeoutError,
		);
		assert.equal(fnCalled, false, "fn mai invocata se acquire fallisce");
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

// =============================================================================
// Cross-process demo: serializzazione effettiva tra processi distinti.
// =============================================================================

/**
 * Spawn un child che tiene il lock per `holdMs` ms, poi rilascia ed esce.
 *
 * Nota su cwd: il child NON riceve `cwd` come opzione di spawn — lo eredita
 * dal processo genitore (root del repo). Il loader
 * `tests/ts-esm-loader.mjs` localizza `tests/ts-hooks.mjs` via
 * `process.cwd()` durante la registrazione: se ereditiamo la root, il loader
 * trova i suoi hooks correttamente. Lo script child poi fa `process.chdir`
 * al tmpdir del test PRIMA di chiamare le funzioni di lock, così il lock
 * file è isolato per test senza rompere la registrazione del loader.
 */
async function spawnLockHolder(
	cwd: string,
	holdMs: number,
): Promise<{ exitCode: number | null; stderr: string; stdout: string }> {
	const childFile = path.join(cwd, "holder.mjs");
	await fs.writeFile(
		childFile,
		`import { pathToFileURL } from "node:url";
import { chdir } from "node:process";
const [src, holdMs, targetCwd] = process.argv.slice(2);
const mod = await import(pathToFileURL(src).href);
// chdir PRIMA di acquire: il loader è già stato registrato all'avvio
// (con cwd = repo root), quindi la registrazione non è disturbata dal cambio.
chdir(targetCwd);
const handle = await mod.acquirePendingResearchLock(targetCwd, {
    staleAfterMs: 60000,
    pollIntervalMs: 10,
    timeoutMs: 5000,
});
process.stdout.write(JSON.stringify({ event: "acquired", pid: process.pid }) + "\\n");
await new Promise((r) => setTimeout(r, Number(holdMs)));
await mod.releasePendingResearchLock(handle);
process.stdout.write(JSON.stringify({ event: "released", pid: process.pid }) + "\\n");
`,
		"utf-8",
	);
	return await new Promise((resolve) => {
		const proc = spawn(
			process.execPath,
			[
				"--import",
				LOADER_FILE,
				childFile,
				SRC_FILE,
				String(holdMs),
				cwd,
			],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (c) => (stdout += String(c)));
		proc.stderr.on("data", (c) => (stderr += String(c)));
		proc.on("close", (exitCode) =>
			resolve({ exitCode, stderr, stdout }),
		);
	});
}

test("cross-process: processo principale attende che un child rilasci il lock, poi entra nella sezione critica", async () => {
	const cwd = await createTmpDir();
	try {
		const { stream } = collectStderr();
		const lockPath = pendingResearchLockPath(cwd);

		// 1) Lancia un child che tiene il lock per 300ms.
		const holder = spawnLockHolder(cwd, 300);

		// 2) Attendi che il child ABBIA EFFETTIVAMENTE acquisito il lock
		//    (lock file presente su disco): senza questo sync, il main
		//    potrebbe race-claimare prima del child e non serializzare,
		//    producendo elapsed ~ 1ms invece di >= ~200ms.
		const childAcquiredDeadline = Date.now() + 5000;
		while (Date.now() < childAcquiredDeadline) {
			if (await lockExists(lockPath)) break;
			await new Promise((r) => setTimeout(r, 5));
		}
		assert.ok(
			await lockExists(lockPath),
			"child ha acquisito il lock prima del main (lock file presente)",
		);

		// 3) Tenta acquire dal processo principale: deve attendere il rilascio.
		const start = Date.now();
		const handle = await acquirePendingResearchLock(cwd, {
			timeoutMs: 5000,
			pollIntervalMs: 20,
			staleAfterMs: 60_000,
			stderr: stream,
		});
		const elapsed = Date.now() - start;

		// Attesa minima di serializzazione: child tiene 300ms, noi abbiamo
		// aspettato 80ms prima di partire, dunque il rilascio avviene dopo
		// ~220ms dall'inizio del nostro acquire. Tolleranza ampia (>= 100ms).
		assert.ok(
			elapsed >= 100,
			`attesa minima di serializzazione (era ${elapsed}ms)`,
		);
		assert.ok(elapsed < 4000, `attesa non eccessiva (era ${elapsed}ms)`);

		await releasePendingResearchLock(handle, { stderr: stream });

		const { exitCode, stdout } = await holder;
		assert.equal(exitCode, 0, "child termina con exit 0");
		// Il child ha emesso gli eventi attesi.
		assert.match(stdout, /"event":"acquired"/);
		assert.match(stdout, /"event":"released"/);
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

test("cross-process: due child distinti serializzano le scritture su un contatore condiviso", async () => {
	// Questo è il test "demo" della slice: due processi distinti entrano
	// nella sezione critica uno alla volta. Se la serializzazione funziona,
	// entrambi osservano lo stato coerente e il contatore finale è 2
	// (read-modify-write atomico: se due processi NON fossero serializzati,
	// uno dei due leggerebbe 0 mentre l'altro sta scrivendo 1, e il
	// contatore finale sarebbe 1 invece di 2).
	const cwd = await createTmpDir();
	try {
		const counterPath = path.join(cwd, "counter.txt");
		await fs.writeFile(counterPath, "0\n", "utf-8");

		const childFile = path.join(cwd, "worker.mjs");
		await fs.writeFile(
			childFile,
			`import { pathToFileURL } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import { chdir } from "node:process";
const [src, counterPath, targetCwd] = process.argv.slice(2);
const mod = await import(pathToFileURL(src).href);
// chdir PRIMA di withPendingResearchLock: il loader è già stato registrato
// all'avvio del child (con cwd = repo root), quindi la registrazione non è
// disturbata dal cambio successivo al tmpdir del test.
chdir(targetCwd);
await mod.withPendingResearchLock(
    targetCwd,
    async () => {
        // Sezione critica: read-modify-write del contatore. Se NON
        // serializzata, due processi possono leggere lo stesso "0" prima
        // che uno dei due scriva "1", portando il counter finale a "1"
        // invece di "2".
        const raw = await readFile(counterPath, "utf-8");
        const n = Number(raw.trim());
        await new Promise((r) => setTimeout(r, 60)); // amplifica la race
        await writeFile(counterPath, String(n + 1) + "\\n", "utf-8");
    },
    { timeoutMs: 5000, pollIntervalMs: 10, staleAfterMs: 60000 },
);
process.stdout.write(JSON.stringify({ event: "done", pid: process.pid }) + "\\n");
`,
			"utf-8",
		);

		const procs = [
			spawn(
				process.execPath,
				["--import", LOADER_FILE, childFile, SRC_FILE, counterPath, cwd],
				{ stdio: ["ignore", "pipe", "pipe"] },
			),
			spawn(
				process.execPath,
				["--import", LOADER_FILE, childFile, SRC_FILE, counterPath, cwd],
				{ stdio: ["ignore", "pipe", "pipe"] },
			),
		];
		const results = await Promise.all(
			procs.map(
				(p) =>
					new Promise<{ exitCode: number | null; stderr: string }>(
						(resolve) => {
							let stdout = "";
							let stderr = "";
							p.stdout.on("data", (c) => (stdout += String(c)));
							p.stderr.on("data", (c) => (stderr += String(c)));
							void stdout;
							p.on("close", (exitCode) =>
								resolve({ exitCode, stderr }),
							);
						},
					),
			),
		);
		for (const r of results) {
			assert.equal(
				r.exitCode,
				0,
				`ogni child termina con exit 0 (stderr: ${r.stderr || "<vuoto>"})`,
			);
		}

		const final = await fs.readFile(counterPath, "utf-8");
		assert.equal(
			final.trim(),
			"2",
			"entrambi i processi hanno completato (counter=2, NON 1)",
		);
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});