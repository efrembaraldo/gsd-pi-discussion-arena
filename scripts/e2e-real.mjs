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
import {
	existsSync,
	mkdtempSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
	dirname,
	fileURLToPath,
	join,
	resolve,
} from "node:path";
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

/** Prefisso della riga canonica emessa dal child `gsd` su stderr. */
export const TIER_LINE_PREFIX = "[gsd-extension-e2e]";

/** Timeout per scenario in millisecondi (anti-hang). */
export const DEFAULT_SCENARIO_TIMEOUT_MS = 30_000;

/** Limite di output bufferizzato per scenario. */
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

/**
 * Trova `gsd` su PATH. Ritorna il path assoluto del binario, oppure
 * `null` se non trovato. Cross-platform: usa `path.delimiter` per
 * separare le entry di PATH (Linux/macOS `:`, Windows `;`).
 */
export function findGsd(envPath = process.env.PATH ?? "", sep = (process.platform === "win32") ? ";" : ":") {
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
 * Parsa la riga canonica del tier da un blob stderr. Ritorna
 * `{tier, reasons}` se trovata, altrimenti `null`. Tollera
 * multi-line stderr: scorre tutte le righe e ritorna la prima che
 * matcha il prefisso canonico.
 *
 * Formato atteso:
 *   `[gsd-extension-e2e] tier=<F|A|D> reasons=[<r1>,<r2>,...]`
 *   `[gsd-extension-e2e] tier=F reasons=[]`
 *
 * Robusto a:
 *   - spazi multipli tra `tier=` e `reasons=`;
 *   - reasons con o senza virgole (lista vuota o 1+ elementi);
 *   - prefisso canonical in qualsiasi posizione della riga (non solo
 *     all'inizio: il child `gsd` potrebbe prependere log lines).
 */
export function parseTierLine(stderr) {
	if (typeof stderr !== "string" || stderr.length === 0) {
		return null;
	}
	const lines = stderr.split(/\r?\n/);
	for (const line of lines) {
		const idx = line.indexOf(TIER_LINE_PREFIX);
		if (idx === -1) {
			continue;
		}
		const tail = line.slice(idx + TIER_LINE_PREFIX.length).trim();
		// Regex tollerante: spazi multipli, `reasons=[]` o `reasons=[a,b]`.
		const tierMatch = tail.match(/^tier\s*=\s*([FAD])\s+reasons\s*=\s*\[([^\]]*)\]/);
		if (!tierMatch) {
			continue;
		}
		const tier = tierMatch[1];
		const reasonsStr = tierMatch[2];
		const reasons = reasonsStr.length > 0
			? reasonsStr.split(",").map((r) => r.trim()).filter(Boolean)
			: [];
		return { tier, reasons };
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
	const gsdVersionEntry = profile.gsdVersion === null
		? { GSD_VERSION: null }
		: { GSD_VERSION: profile.gsdVersion };
	return {
		GSD_E2E_PROFILE: profileName,
		GSD_E2E_PHASE: phase,
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
export function formatSummaryLine(profile, phase, observedTier, reasons, exitCode) {
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
	const scenarioTmp = mkdtempSync(join(tmpdirRoot, `e2e-real-${profile}-${phase}-`));
	const logPath = join(scenarioTmp, "scenario.log");

	// 2) Env overrides per il child.
	const overrides = envForScenario(profile, phase);
	const spawnEnv = buildSpawnEnv(overrides);

	// 3) Comandi & argomenti.
	const args = ["--extension", entryPath];
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

	// 6) Parsa tier osservato.
	const parsed = parseTierLine(stderr);

	if (!parsed) {
		// Nessuna riga canonica → scenario degradato (parse-fail).
		const summary = formatSummaryLine(profile, phase, "?", expectedReasons, 1);
		const fail = formatFailLine(profile, phase, expectedTier, "?", expectedReasons);
		return {
			profile,
			phase,
			expectedTier,
			observedTier: null,
			reasons: [],
			exitCode: 1,
			summary,
			fail,
			durationMs,
			tmpdir: scenarioTmp,
			logPath,
		};
	}

	const matches = parsed.tier === expectedTier;
	const observedTier = parsed.tier;
	const exitCode = matches ? 0 : 1;
	const summary = formatSummaryLine(profile, phase, observedTier, parsed.reasons, exitCode);
	const fail = matches ? null : formatFailLine(profile, phase, expectedTier, observedTier, parsed.reasons);

	return {
		profile,
		phase,
		expectedTier,
		observedTier,
		reasons: parsed.reasons,
		exitCode,
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

	let failures = 0;
	const tmpdirs = [];
	for (const cell of SCENARIO_MATRIX) {
		// Sanity check: la cella deve esistere anche via getScenario.
		const lookup = getScenario(cell.profile, cell.phase);
		if (!lookup) {
			console.error(
				`${RUNNER_TAG} FAIL scenario=${cell.profile}/${cell.phase} expected=${cell.expectedTier} got=? reasons=[internal_lookup_miss]`,
			);
			failures++;
			continue;
		}

		const result = runScenario(cell, { gsdPath });
		console.error(result.summary);
		if (result.fail) {
			console.error(result.fail);
			failures++;
		}
		tmpdirs.push(result.tmpdir);
	}

	// 4) Riga DONE aggregata + exit.
	if (failures === 0) {
		console.error(
			`${RUNNER_TAG} DONE matrix=${total} passed=${total} failed=0 exit=0 tmpdirs=${tmpdirs.length}`,
		);
		process.exit(0);
	}
	const passed = total - failures;
	console.error(
		`${RUNNER_TAG} DONE matrix=${total} passed=${passed} failed=${failures} exit=1 tmpdirs=${tmpdirs.length}`,
	);
	process.exit(1);
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	main();
}