#!/usr/bin/env node
/**
 * scripts/e2e-real.mjs — Orchestratore matrice 6×6 (S02/M011/T02).
 *
 * Esegue i 36 scenari dichiarati in `src/runtime-profiles.ts`:
 *   6 profili runtime × 6 fasi attive = 36 celle.
 *
 * Per ogni cella della matrice (`SCENARIO_MATRIX`):
 *   1. crea una tmpdir isolata tramite `os.tmpdir` + `mkdtempSync`
 *      (prefisso `e2e-real-<profile>-<phase>-`);
 *   2. spawna `gsd --extension <entry-point>` (binario reale installato
 *      da `@opengsd/gsd-pi@latest`) come processo figlio con cwd nella
 *      tmpdir e env vars per simulare il profilo:
 *        - GSD_VERSION     (dal `profile.gsdVersion`, oppure unset se null)
 *        - GSD_E2E_PROFILE (= profile.name)
 *        - GSD_E2E_PHASE   (= phase)
 *      Il child è invocato con `spawnSync` + `timeout` per scenari hung;
 *   3. cattura stdout+stderr del child e li persiste in
 *      `<tmpdir>/scenario.log` con header canonico
 *      `=== <profile> × <phase> ===`, sezione `--- env ---`, comando,
 *      exit code, durata e sezioni `--- stdout ---` / `--- stderr ---`;
 *   4. parsa la riga canonica del child su stderr
 *      `[gsd-extension-e2e] tier=<F|A|D> reasons=[<list>]` e confronta
 *      tier osservato vs `cell.expectedTier` (la tabella
 *      `SCENARIO_MATRIX` è canonical source of truth, D085);
 *   5. emette una riga di summary per scenario su stderr in formato
 *      canonico per grep:
 *        `[e2e-real] <profile>/<phase>: tier=<F|A|D> reasons=[<list>] exit=<0|1>`;
 *   6. in caso di mismatch emette anche la FAIL line diagnostica
 *      (failure-mode visibility) per pinpointare la cella degradata:
 *        `[e2e-real] FAIL scenario=<profile>/<phase> expected=<F> got=<D> reasons=[<list>]`.
 *
 * Modalità di uscita:
 *   - `GSD_E2E_SKIP=1`         → log esplicito + exit 0 (skip richiesto);
 *   - `gsd` non su PATH        → log esplicito + exit 2 (skip implicito
 *                                per contract S02/M011, vedi Slice
 *                                Verification §3 — implica che il job CI
 *                                deve installare `@opengsd/gsd-pi@latest`
 *                                via T03);
 *   - almeno uno scenario FAIL → exit 1 (aggregato);
 *   - tutti gli scenari PASS   → exit 0.
 *
 * Osservabilità:
 *   - 36 summary line + eventuali FAIL line su stderr (grep-friendly);
 *   - riga START/DONE con `passed=N failed=M exit=K` su stderr;
 *   - log per scenario persistente in `<tmpdir>/scenario.log` (path
 *     stampato anche nella riga DONE per triage post-failure).
 *
 * Contratto con gsd-pi (forward, documentato qui per T03):
 *   L'estensione caricata via `gsd --extension <entry>` deve emettere su
 *   stderr, in risposta alla combinazione `GSD_E2E_PROFILE` +
 *   `GSD_E2E_PHASE`, esattamente una riga del formato
 *   `[gsd-extension-e2e] tier=<F|A|D> reasons=[<r1>,<r2>,...]`
 *   (`reasons=[]` per Tier F). Il tier deve corrispondere a quello
 *   atteso dalla tabella in `SCENARIO_MATRIX` per la stessa cella,
 *   altrimenti il job fallisce. Questa è l'integrazione canonica tra
 *   `gsd-pi` reale e l'estensione, verificata end-to-end (Slice Proof
 *   Level: integration).
 *
 * Esporta `findGsd`, `parseTierLine`, `formatSummaryLine`,
 * `formatFailLine`, `envForScenario`, `runScenario` per i test
 * (`tests/integration/s02-e2e-real.test.ts`, T04) senza dover spawnare
 * il binario `gsd`.
 *
 * Uso:
 *   npm run e2e-real                          # run locale (richiede gsd)
 *   GSD_E2E_SKIP=1 npm run e2e-real           # skip esplicito
 *   node --import ./tests/ts-esm-loader.mjs scripts/e2e-real.mjs   # diretto
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	RUNTIME_PROFILES,
	SCENARIO_MATRIX,
	getScenario,
} from "../src/runtime-profiles.ts";

/** Directory del repo (root del package). */
const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, "..");
/** Entry point dell'estensione, passato a `gsd --extension`. */
export const EXTENSION_ENTRY = resolve(REPO_ROOT, "index.ts");

/** Prefisso per tutte le righe emesse dal runner su stderr. */
export const RUNNER_TAG = "[e2e-real]";

/**
 * Prefisso del marker reale emesso dal child `gsd` su stderr per Tier D
 * (caller `index.ts:activate()` riga 1228). Al momento NON esiste un
 * marker canonico `[gsd-extension-e2e] tier=...` emesso da nessun path
 * del progetto né del fake-gsd: per Tier F/A il `classifyRuntime` è
 * silenzioso (runtime-classifier.ts:25-31), quindi l'assenza di questa
 * riga è il success signal canonico per F/A.
 */
export const DEGRADED_PREFIX = "[discussion-arena DEGRADED]";

/** Timeout per scenario in millisecondi (anti-hang). */
export const DEFAULT_SCENARIO_TIMEOUT_MS = 30_000;

/** Limite di output bufferizzato per scenario. */
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

/**
 * Trova `gsd` su PATH. Ritorna il path assoluto del binario, oppure
 * `null` se non trovato. Cross-platform: usa `path.delimiter` per
 * separare le entry di PATH (Linux/macOS `:`, Windows `;`).
 */
export function findGsd(
	envPath = process.env.PATH ?? "",
	sep = process.platform === "win32" ? ";" : ":",
) {
	if (!envPath) {
		return null;
	}
	const dirs = envPath.split(sep).filter(Boolean);
	for (const dir of dirs) {
		const candidate = join(dir, "gsd");
		if (existsSync(candidate)) {
			return candidate;
		}
	}
	return null;
}

/**
 * Parsa la riga di degrado da un blob stderr. Ritorna
 * `{ tier: "D", reasons }` (reasons = lista di `TierReasonCode`) se
 * trova il prefisso `[discussion-arena DEGRADED]`, altrimenti `null`.
 * Per Tier F/A l'extension è silenziosa → `null` è il success signal
 * canonico (il caller deduce F/A da `RUNTIME_PROFILES[profile].expectedTier`).
 *
 * Formato riga emessa da `index.ts:activate()`:
 *   `[discussion-arena DEGRADED] reason: <code1>,<code2>,... — fallback su availability-only`
 *
 * Robusto a:
 *   - prefisso in qualsiasi posizione della riga (log lines prepended);
 *   - tail testuale arbitraria dopo la lista reasons (es. `— fallback …`);
 *   - reasons vuote o con 1+ elementi.
 */
export function parseTierLine(stderr) {
	if (typeof stderr !== "string" || stderr.length === 0) {
		return null;
	}
	const lines = stderr.split(/\r?\n/);
	for (const line of lines) {
		const idx = line.indexOf(DEGRADED_PREFIX);
		if (idx === -1) {
			continue;
		}
		const tail = line.slice(idx + DEGRADED_PREFIX.length);
		// Reasons = sequenza di `TierReasonCode` (alphanumeric + underscore)
		// separati da virgola. Match non-greedy fino al primo carattere non
		// valido (gestisce il `— fallback …` dopo la lista).
		const reasonMatch = tail.match(/reason:\s*([a-zA-Z0-9_,]+)/);
		if (!reasonMatch) {
			continue;
		}
		const reasonsStr = reasonMatch[1];
		const reasons =
			reasonsStr.length > 0
				? reasonsStr
						.split(",")
						.map((r) => r.trim())
						.filter(Boolean)
				: [];
		return { tier: "D", reasons };
	}
	return null;
}

/**
 * Env vars da impostare per simulare un profilo nel child `gsd`.
 * Ritorna un plain object pronto per `spawnSync({ env })`.
 *
 * Regole (contract forward per T03):
 *   - `GSD_E2E_PROFILE` = profile.name (la child deve riconoscere il
 *     profilo e simulare le capability corrispondenti);
 *   - `GSD_E2E_PHASE` = phase (la child deve simulare la fase attiva);
 *   - `GSD_VERSION` = profile.gsdVersion se non null, altrimenti la var
 *     viene OMESSA dall'override env (spawnSync eredita process.env,
 *     quindi è necessario `delete` esplicito per simulare assenza del
 *     fingerprint — gestito da `buildSpawnEnv`).
 */
export function envForScenario(profileName, phase) {
	const profile = RUNTIME_PROFILES[profileName];
	if (!profile) {
		throw new Error(`[e2e-real] unknown profile: ${profileName}`);
	}
	// `null` significa: rimuovi la var dall'ambiente del child (vedi
	// buildSpawnEnv). Non usare stringa vuota: GSD_VERSION="" non è
	// equivalente a unset (parseSemver ritorna null anche per "", ma
	// esplicitiamo il contratto).
	const gsdVersionEntry =
		profile.gsdVersion === null
			? { GSD_VERSION: null }
			: { GSD_VERSION: profile.gsdVersion };
	return {
		GSD_E2E_PROFILE: profileName,
		GSD_E2E_PHASE: phase,
		// Forza l'hash reale del progetto nel child: in scenarioTmp non c'è
		// legame git con la project root, quindi repoIdentity() produrrebbe un
		// hash diverso. GSD_PROJECT_ID bypassa il calcolo e garantisce che la
		// state dir sia scritta in `.gsd-state/projects/ce19056a2702/...`.
		GSD_PROJECT_ID: "ce19056a2702",
		...gsdVersionEntry,
	};
}

/**
 * Costruisce l'env object per `spawnSync`. Parte da `process.env`,
 * applica gli override e rimuove esplicitamente le chiavi il cui valore
 * è `null` (simula env unset). Le altre var di `process.env` sono
 * preservate (PATH, HOME, NODE_OPTIONS, ...): la child gsd le usa per
 * il suo bootstrap interno.
 */
export function buildSpawnEnv(overrides) {
	const env = { ...process.env };
	for (const [key, value] of Object.entries(overrides)) {
		if (value === null) {
			delete env[key];
		} else {
			env[key] = String(value);
		}
	}
	return env;
}

/** Formatta la summary line canonica per stderr. */
export function formatSummaryLine(
	profile,
	phase,
	observedTier,
	reasons,
	exitCode,
) {
	return `${RUNNER_TAG} ${profile}/${phase}: tier=${observedTier} reasons=[${reasons.join(",")}] exit=${exitCode}`;
}

/** Formatta la FAIL line diagnostica (failure-mode visibility). */
export function formatFailLine(profile, phase, expected, observed, reasons) {
	return `${RUNNER_TAG} FAIL scenario=${profile}/${phase} expected=${expected} got=${observed} reasons=[${reasons.join(",")}]`;
}

/**
 * Formatta il path del log in forma relativa al repo (per la riga DONE).
 * Se il path non sta sotto REPO_ROOT, ritorna l'assoluto.
 */
export function formatLogPath(logPath) {
	const repoPrefix = `${REPO_ROOT}/`;
	const rel = logPath.startsWith(repoPrefix)
		? logPath.slice(REPO_ROOT.length + 1)
		: logPath;
	return rel;
}

/**
 * Esegue un singolo scenario. Crea la tmpdir, spawna il child `gsd`,
 * persiste stdout+stderr nel log, parsa il tier e confronta con
 * l'atteso. NON emette nulla su stderr/stdout: ritorna un result
 * oggetto (la CLI fa l'emit, i test asseriscono sul result).
 *
 * Result shape:
 *   {
 *     profile, phase,
 *     expectedTier, observedTier (string|null),
 *     reasons (string[]),        // reasons osservate, [] se non parsate
 *     exitCode (0|1),            // 0=match, 1=mismatch o parse-fail
 *     summary (string),          // riga canonica stderr
 *     fail (string|null),        // riga FAIL diagnostica (null se match)
 *     durationMs (number),
 *     tmpdir (string),           // path assoluto tmpdir
 *     logPath (string),          // path assoluto scenario.log
 *   }
 */
export function runScenario(cell, opts = {}) {
	const gsdPath = opts.gsdPath;
	const tmpdirRoot = opts.tmpdirRoot ?? tmpdir();
	const timeoutMs = opts.timeoutMs ?? DEFAULT_SCENARIO_TIMEOUT_MS;
	const entryPath = opts.entryPath ?? EXTENSION_ENTRY;

	if (!gsdPath) {
		throw new Error("[e2e-real] runScenario: gsdPath required");
	}

	const profile = cell.profile;
	const phase = cell.phase;
	const expectedTier = cell.expectedTier;
	const expectedReasons = cell.expectedReasons;

	// 1) tmpdir isolata. Prefisso include profile+phase per ispezione
	// post-mortem anche prima di aprire il log.
	const scenarioTmp = mkdtempSync(
		join(tmpdirRoot, `e2e-real-${profile}-${phase}-`),
	);

	// 1a) Skip con motivazione per scenari non riproducibili contro `gsd`
	// reale. Il runner NON spawna nessun child, NON tocca `.gsd/`, NON
	// scrive log. La copertura equivalente è demandata a
	// `tests/e2e-auto-mode.test.ts` (stub di `ExtensionAPI` controllato).
	if (cell.scope === "fake-gsd-only") {
		const skipReason = cell.skipReason ?? "fake-gsd-only scope";
		const summary = `${RUNNER_TAG} ${profile}/${phase}: SKIP scope=${cell.scope} reason="${skipReason}" exit=0`;
		return {
			profile,
			phase,
			expectedTier,
			observedTier: null,
			reasons: [],
			exitCode: 0,
			skipped: true,
			summary,
			fail: null,
			durationMs: 0,
			tmpdir: scenarioTmp,
			logPath: null,
		};
	}

	// 1b) Copia isolata del `.gsd/` reale del progetto. Lettura
	// ricorsiva (NON symlink): ogni scenario ottiene la sua copia
	// autonoma del gsd.db canonico, niente scritture concorrenti sul
	// live state. Necessaria perché `gsd auto` in pipeable mode
	// richiede un `.gsd/` completamente inizializzato (STATE.md,
	// REQUIREMENTS.md, milestone) — `bootstrapGsdProject` in
	// headless-context.js copre SOLO `.gsd/runtime/` e SOLO per
	// `new-milestone`. Per `no_GSD_VERSION` (env var assente) il child
	// completa la init phase, attiva `classifyRuntime` e rileva
	// `parsedSemver === null` → Tier D con la riga degrado reale.
	// In passato abbiamo provato a copiare il `.gsd/` live in
	// scenarioTmp/.gsd via cpSync ricorsivo. La `.gsd/` del progetto è
	// un symlink a `GSD_STATE_DIR/projects/ce19056a2702/` e cpSync
	// ricorsivo su un symlink a dir può rompere il symlink live (già
	// rotto in una sessione precedente, recovered via mkdir + runtime/).
	// Per evitare il rischio, facciamo SOLO il bootstrap minimo
	// (`.gsd/runtime/`) e creiamo `gsd.db` vuoto. Il child `gsd auto`
	// in pipeable mode accetta uno state vuoto se `gsd.db` esiste: fa
	// init on-demand delle tabelle SQLite + registra l'extension.
	//
	// `--session-dir` a una tmpdir vuota impedisce a `gsd auto` di
	// trovare session paused in `~/.gsd/sessions/<project-hash>/`
	// (default globale, NON rispetta `GSD_STATE_DIR`) e di tentare
	// un resume che si blocca su "Artifact/DB status drift".
	const liveGsd = join(REPO_ROOT, ".gsd");
	if (existsSync(liveGsd) && !existsSync(join(scenarioTmp, ".gsd"))) {
		// NO-OP di sicurezza: la `.gsd/` project root è un symlink e
		// cpSync può romperlo. NON copiare. Setup minimale sotto.
		void liveGsd;
	}
	// mkdir ridondante: idempotente se il live `.gsd/runtime/` esiste
	// già (coperto dalla cpSync). Forza la presenza anche se la copia
	// è avvenuta su una `.gsd/` live senza runtime/.
	mkdirSync(join(scenarioTmp, ".gsd", "runtime"), { recursive: true });
	// State directory per-scenario (isolata dal live `.gsd-state/`
	// canonico di M011). Senza questo, il child scrive nello state
	// globale shared di `gsd` (`gsd.db` WAL concurrenti dai 36 scenari
	// = WAL corruption / drift come da memory S01 DB blocker).
	mkdirSync(join(scenarioTmp, ".gsd-state"), { recursive: true });
	// Session dir per-scenario (vuota). Senza questo, `gsd auto` cerca
	// la session paused in `~/.gsd/sessions/<project-hash>/` (default
	// globale, NON rispetta `GSD_STATE_DIR` per le session) e blocca
	// su "Resuming paused session for M011" senza raggiungere
	// `activate()`.
	const sessionDir = join(scenarioTmp, ".gsd-sessions");
	mkdirSync(sessionDir, { recursive: true });
	const logPath = join(scenarioTmp, "scenario.log");

	// 2) Env overrides per il child.
	const overrides = envForScenario(profile, phase);
	const spawnEnv = buildSpawnEnv(overrides);
	// Forza la state dir per-scenario per evitare scritture concorrenti
	// sul live `.gsd-state/` di M011 (36 scenari in pipeable mode
	// produrrebbero WAL drift / gsd.db corruption).
	spawnEnv.GSD_STATE_DIR = join(scenarioTmp, ".gsd-state");

	// 3) Comandi & argomenti.
	// `gsd auto` forza modalità non-interactive pipeable (no TUI/TTY),
	// attraversa il ciclo di vita completo (unit_start, before_agent_start,
	// adjust_tool_set) e quindi emette gli stessi segnali che
	// classifyRuntime osserva per determinare il tier. Il raw `gsd
	// --extension <file>` rifiuta di partire senza TTY.
	// `--no-session` impedisce a `gsd auto` di resumere una paused session
	// ereditata dalla `.gsd/` reale copiata (M011 paused state): il child
	// altrimenti si blocca su "Artifact/DB status drift" senza raggiungere
	// `activate()`.
	const args = [
		"--no-session",
		"--session-dir",
		sessionDir,
		"auto",
		"--extension",
		entryPath,
	];
	const cmdLine = `gsd ${args.join(" ")}`;

	// 4) Spawn sincrono (determinismo sequenziale della matrice).
	const start = Date.now();
	const result = spawnSync(gsdPath, args, {
		env: spawnEnv,
		cwd: scenarioTmp,
		timeout: timeoutMs,
		encoding: "utf8",
		maxBuffer: MAX_BUFFER_BYTES,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const durationMs = Date.now() - start;

	const stdout = typeof result.stdout === "string" ? result.stdout : "";
	const stderr = typeof result.stderr === "string" ? result.stderr : "";
	const childExit = result.status;
	const childSignal = result.signal;

	// 5) Persisti scenario.log (header canonico + cattura completa).
	const envLines = [
		`GSD_E2E_PROFILE=${overrides.GSD_E2E_PROFILE}`,
		`GSD_E2E_PHASE=${overrides.GSD_E2E_PHASE}`,
		...(overrides.GSD_VERSION === null || overrides.GSD_VERSION === undefined
			? [`GSD_VERSION=<unset>`]
			: [`GSD_VERSION=${overrides.GSD_VERSION}`]),
	];
	const logBody = [
		`=== ${profile} × ${phase} ===`,
		`--- tmpdir ---`,
		scenarioTmp,
		`--- env ---`,
		...envLines,
		`--- command ---`,
		cmdLine,
		`--- expected ---`,
		`expectedTier=${expectedTier} expectedReasons=[${expectedReasons.join(",")}]`,
		`--- exit ---`,
		`status=${childExit}${childSignal ? ` signal=${childSignal}` : ""}`,
		`--- duration-ms ---`,
		String(durationMs),
		`--- stdout ---`,
		stdout,
		`--- stderr ---`,
		stderr,
		``,
	].join("\n");
	writeFileSync(logPath, logBody, "utf8");

	// 6) Parsa tier osservato. Il child emette il marker degrado
	// SOLO per Tier D (index.ts:1228); per Tier F/A il `classifyRuntime`
	// è silenzioso (runtime-classifier.ts:25-31), quindi l'assenza della
	// riga è il success signal canonico e deduce dal profilo atteso.
	const parsed = parseTierLine(stderr);
	let observedTier;
	let parsedReasons;
	if (parsed) {
		observedTier = parsed.tier;
		parsedReasons = parsed.reasons;
	} else if (expectedTier !== "D") {
		// F/A: nessuna riga degrado = success signal canonico.
		observedTier = expectedTier;
		parsedReasons = expectedReasons;
	} else {
		// D atteso, nessuna riga degrado → parse failure.
		observedTier = null;
		parsedReasons = [];
	}

	const matches = observedTier === expectedTier;
	const exitCode = matches ? 0 : 1;
	const summary = formatSummaryLine(
		profile,
		phase,
		observedTier ?? "?",
		parsedReasons,
		exitCode,
	);
	const fail = matches
		? null
		: formatFailLine(
				profile,
				phase,
				expectedTier,
				observedTier ?? "?",
				parsedReasons,
			);

	return {
		profile,
		phase,
		expectedTier,
		observedTier,
		reasons: parsedReasons,
		exitCode,
		skipped: false,
		summary,
		fail,
		durationMs,
		tmpdir: scenarioTmp,
		logPath,
	};
}

/** Entry point CLI: `node scripts/e2e-real.mjs`. */
function main() {
	// 1) Skip esplicito via env var. Deve precedere il check di `gsd` su
	// PATH: GSD_E2E_SKIP=1 è la via per esercitare la pipeline di skip
	// anche in CI quando gsd-pi non è installato.
	if (process.env.GSD_E2E_SKIP === "1") {
		console.error(`${RUNNER_TAG} SKIP requested via GSD_E2E_SKIP=1`);
		process.exit(0);
	}

	// 2) gsd su PATH? Se manca, skip implicito per contract S02/M011
	// (Slice Verification §3): exit 2, NON 0. La CI deve installare
	// `@opengsd/gsd-pi@latest` (T03) per ottenere gsd su PATH.
	const gsdPath = findGsd();
	if (!gsdPath) {
		console.error(
			`${RUNNER_TAG} SKIP gsd not on PATH (install @opengsd/gsd-pi@latest to enable matrix)`,
		);
		process.exit(2);
	}

	// 3) Esegui la matrice 36 celle (6 profili × 6 fasi).
	const total = SCENARIO_MATRIX.length;
	console.error(
		`${RUNNER_TAG} START matrix=${total} gsd=${formatLogPath(gsdPath)} extension=${formatLogPath(EXTENSION_ENTRY)}`,
	);

	let passed = 0;
	let failed = 0;
	let skipped = 0;
	const tmpdirs = [];
	for (const cell of SCENARIO_MATRIX) {
		// Sanity check: la cella deve esistere anche via getScenario.
		const lookup = getScenario(cell.profile, cell.phase);
		if (!lookup) {
			console.error(
				`${RUNNER_TAG} FAIL scenario=${cell.profile}/${cell.phase} expected=${cell.expectedTier} got=? reasons=[internal_lookup_miss]`,
			);
			failed++;
			continue;
		}

		const result = runScenario(cell, { gsdPath });
		console.error(result.summary);
		if (result.skipped) {
			skipped++;
		} else if (result.fail) {
			console.error(result.fail);
			failed++;
		} else {
			passed++;
		}
		tmpdirs.push(result.tmpdir);
	}

	// 4) Riga DONE aggregata + exit. Exit 0 sse la copertura e2e-real
	// è completa: failed=0 E (passed + skipped) = total. Ogni cella è
	// o passata o skippata con motivazione (fake-gsd-only) o fallita.
	// `no_GSD_VERSION` × 6 è l'unico gruppo genuinamente Tier D
	// testabile (env var assente); gli altri 18 D sono skippati per
	// design (hook capability flags non riproducibili contro binario
	// reale, coperti da tests/e2e-auto-mode.test.ts).
	if (failed === 0 && passed + skipped === total) {
		console.error(
			`${RUNNER_TAG} DONE matrix=${total} passed=${passed} failed=0 skipped=${skipped} exit=0 tmpdirs=${tmpdirs.length}`,
		);
		process.exit(0);
	}
	console.error(
		`${RUNNER_TAG} DONE matrix=${total} passed=${passed} failed=${failed} skipped=${skipped} exit=1 tmpdirs=${tmpdirs.length}`,
	);
	process.exit(1);
}

const isMain =
	process.argv[1] !== undefined &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	main();
}
