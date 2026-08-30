/**
 * Test del runner hermes (M015/S02/R040).
 *
 * Copertura:
 *   (a) UNIT — buildHermesPrompt (D127, separatori markdown): 4 test.
 *   (b) UNIT — buildHermesInvocation (D126 argv order): 8 test (no spawn,
 *       inspection diretta di args[] + warnings[] via la funzione pura
 *       esportata dal refactor T03).
 *   (c) UNIT — readHermesUsageFile (parser best-effort): 5 test (file
 *       assente, JSON corrotto, campi mancanti, string coercion, schema
 *       valido).
 *   (d) INTEGRATION — runParticipantTurnViaHermes con fake-hermes in PATH:
 *       8 scenari (fast/silent/hang/crash/no-usage-file/corrupt-usage-file/
 *       model-error/sigkill) + 1 scenario aggiuntivo per la dedup del
 *       warning provider-without-model (stderr emesso esattamente una volta
 *       attraverso due invocazioni).
 *
 * Pattern condivisi:
 *   - PATH prepend fake-hermes in before(), restore in after()
 *     (tests/timeout-watchdog.test.ts:111-131).
 *   - captureStderr per silenziare i warning stderr attesi
 *     (tests/discussion-arena-loop.test.ts:142-152).
 *   - recordStderr (estensione di captureStderr) per verificare il
 *     contenuto dei warning emessi.
 *   - makeParticipant minimale con campi engine/provider/hermesToolsets/
 *     hermesSkills opzionali (override per gli scenari che li richiedono).
 *
 * Verifica anche la superficie che S08 consumerà: shape stabile di
 * `ParticipantTurnResult` (participant, role, exitCode, text, stderr,
 * usage, durationMs), usage populated da usage-file, failureKind per i
 * branch di failure, durationMs >= 0.
 */

import { test, before, after, beforeEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	buildHermesPrompt,
	buildHermesInvocation,
	readHermesUsageFile,
	runParticipantTurnViaHermes,
	type ParticipantTurnResult,
} from "../run-participant.js";
import type { ParticipantConfig } from "../participants.js";
import {
	DEFAULT_PARTICIPANT_LIMITS,
	type ResolvedLimits,
} from "../helpers.js";

// ─── PATH: il binario `hermes` finto deve vincere sul reale ─────────────────

const FAKE_HERMES_DIR = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"fixtures",
	"fake-hermes",
);

let originalPath: string | undefined;
before(() => {
	originalPath = process.env.PATH;
	process.env.PATH = `${FAKE_HERMES_DIR}${path.delimiter}${originalPath ?? ""}`;
});
after(() => {
	if (originalPath === undefined) {
		delete process.env.PATH;
	} else {
		process.env.PATH = originalPath;
	}
});

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Silenzia process.stderr.write durante `fn` (warning provider/watchdog attesi). */
async function captureStderr<T>(fn: () => Promise<T>): Promise<T> {
	const original = process.stderr.write.bind(process.stderr);
	process.stderr.write = (() => true) as unknown as typeof process.stderr.write;
	try {
		return await fn();
	} finally {
		process.stderr.write = original;
	}
}

/**
 * Come captureStderr ma raccoglie i chunk scritti su stderr durante `fn`,
 * per asserzioni sul contenuto dei warning (es. "emesso una volta").
 */
async function recordStderr<T>(
	fn: () => Promise<T>,
): Promise<{ result: T; stderr: string }> {
	const chunks: string[] = [];
	const original = process.stderr.write.bind(process.stderr);
	process.stderr.write = ((chunk: unknown) => {
		chunks.push(typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf-8"));
		return true;
	}) as unknown as typeof process.stderr.write;
	try {
		const result = await fn();
		return { result, stderr: chunks.join("") };
	} finally {
		process.stderr.write = original;
	}
}

/** ParticipantConfig minimale per i test (nessun discovery). */
function makeParticipant(
	overrides: Partial<ParticipantConfig> & { name: string; role: string },
): ParticipantConfig {
	return {
		description: `fixture ${overrides.name}`,
		limits: {},
		systemPrompt: "",
		source: "user",
		filePath: "/dev/null",
		...overrides,
	};
}

/** Limiti di base: soglie ampie per i test che non badano al timeout. */
function makeLimits(overrides: Partial<ResolvedLimits> = {}): ResolvedLimits {
	return { ...DEFAULT_PARTICIPANT_LIMITS, ...overrides };
}

/** ParticipantTurnResult "vuoto" per i test di readHermesUsageFile. */
function freshResult(): ParticipantTurnResult {
	return {
		participant: "unused",
		role: "unused",
		exitCode: 0,
		text: "",
		stderr: "",
		usage: { input: 0, output: 0, cost: 0, turns: 0 },
		durationMs: 0,
	};
}

/** Asserzioni di shape comuni a tutti gli scenari. */
function assertShape(result: ParticipantTurnResult, participant: ParticipantConfig): void {
	assert.equal(result.participant, participant.name);
	assert.equal(result.role, participant.role);
	assert.equal(typeof result.durationMs, "number");
	assert.ok(result.durationMs >= 0, `durationMs >= 0 (era ${result.durationMs})`);
}

// ─── UNIT: buildHermesPrompt (D127 — separatori markdown) ─────────────────

test("buildHermesPrompt: con systemPrompt valorizzato include '# Ruolo:', '---', '# Turno di discussione', systemPrompt integrale", () => {
	const p = makeParticipant({ name: "alice", role: "Architetto" });
	p.systemPrompt = "Sei un architetto esperto di sistemi distribuiti.";
	const out = buildHermesPrompt(p, "Discuti del protocollo di consenso.");

	assert.ok(out.startsWith("# Ruolo: Architetto\n"), "apre con '# Ruolo: <role>'");
	assert.ok(
		out.includes("Sei un architetto esperto di sistemi distribuiti."),
		"systemPrompt integrale presente nel mezzo",
	);
	assert.ok(out.includes("\n---\n"), "separatore orizzontale '---' presente");
	assert.ok(
		out.includes("# Turno di discussione"),
		"header '# Turno di discussione' presente",
	);
	assert.ok(out.endsWith("Discuti del protocollo di consenso."), "turnPrompt in coda");
});

test("buildHermesPrompt: con systemPrompt vuoto niente doppio newline anomalo", () => {
	const p = makeParticipant({ name: "bob", role: "Tester" });
	p.systemPrompt = "";
	const out = buildHermesPrompt(p, "Pronto?");

	// '# Ruolo:' seguito da blank line, poi subito '---' (nessuna sezione
	// systemPrompt vuota tra i due). Verifica con regex per essere robusto a
	// spazi bianchi.
	assert.match(out, /# Ruolo: Tester\n\n---\n\n# Turno di discussione\n\nPronto\?/);
});

test("buildHermesPrompt: ruolo custom 'Ricercatore' appare nel titolo", () => {
	const p = makeParticipant({ name: "carol", role: "Ricercatore" });
	p.systemPrompt = "Sei un ricercatore curioso.";
	const out = buildHermesPrompt(p, "Cerca pattern interessanti.");
	assert.ok(out.includes("# Ruolo: Ricercatore\n"));
});

test("buildHermesPrompt: turnPrompt multi-linea preservato integralmente", () => {
	const p = makeParticipant({ name: "dave", role: "Dev" });
	const multiline = "Linea 1\nLinea 2\n\nLinea 4 (post-blank)";
	const out = buildHermesPrompt(p, multiline);
	assert.ok(out.endsWith(multiline), "turnPrompt multi-linea in coda, identico");
});

// ─── UNIT: buildHermesInvocation (D126 argv order) ────────────────────────

test("buildHermesInvocation: argv base contiene '-z', '--usage-file', '--yolo'", async () => {
	const p = makeParticipant({ name: "u1", role: "Tester" });
	const inv = await buildHermesInvocation(p, "DIRECTIVE:fast");
	assert.equal(inv.command, "hermes");
	assert.ok(inv.args.includes("-z"), "manca -z");
	assert.ok(inv.args.includes("--usage-file"), "manca --usage-file");
	assert.ok(inv.args.includes("--yolo"), "manca --yolo");
	assert.ok(inv.usageFilePath !== null, "usage-file path popolato");
	// cleanup tmpdir creato dal builder.
	if (inv.tmpDir) await fs.promises.rm(inv.tmpDir, { recursive: true, force: true });
});

test("buildHermesInvocation: con model, '--model M' presente esattamente una volta", async () => {
	const p = makeParticipant({
		name: "u2",
		role: "Tester",
		model: "minimax-m3",
	});
	const inv = await buildHermesInvocation(p, "DIRECTIVE:fast");
	const occurrences = inv.args.filter((a) => a === "--model").length;
	assert.equal(occurrences, 1, "--model presente una sola volta");
	const modelIdx = inv.args.indexOf("--model");
	assert.equal(inv.args[modelIdx + 1], "minimax-m3", "valore modello corretto");
	if (inv.tmpDir) await fs.promises.rm(inv.tmpDir, { recursive: true, force: true });
});

test("buildHermesInvocation: con provider+model, '--provider P' presente", async () => {
	const p = makeParticipant({
		name: "u3",
		role: "Tester",
		model: "minimax-m3",
		provider: "anthropic",
	});
	const inv = await buildHermesInvocation(p, "DIRECTIVE:fast");
	const providerIdx = inv.args.indexOf("--provider");
	assert.ok(providerIdx >= 0, "--provider presente");
	assert.equal(inv.args[providerIdx + 1], "anthropic", "valore provider corretto");
	if (inv.tmpDir) await fs.promises.rm(inv.tmpDir, { recursive: true, force: true });
});

test("buildHermesInvocation: provider-senza-model -> '--provider' assente da argv + warning in warnings[]", async () => {
	const p = makeParticipant({
		name: "u4",
		role: "Tester",
		// model: undefined di proposito
		provider: "anthropic",
	});
	const inv = await buildHermesInvocation(p, "DIRECTIVE:fast");
	assert.equal(
		inv.args.includes("--provider"),
		false,
		"--provider omesso quando model assente (D126)",
	);
	const providerWarning = inv.warnings.find((w) =>
		w.includes("provider valorizzato ma model assente"),
	);
	assert.ok(
		providerWarning !== undefined,
		"warning provider-without-model presente in warnings[]",
	);
	assert.ok(
		providerWarning!.includes('"u4"'),
		"warning cita il participant.name per la dedup per-sessione",
	);
	if (inv.tmpDir) await fs.promises.rm(inv.tmpDir, { recursive: true, force: true });
});

test("buildHermesInvocation: hermesToolsets produce '--toolsets CSV' con CSV join corretto", async () => {
	const p = makeParticipant({
		name: "u5",
		role: "Tester",
		hermesToolsets: ["fs", "bash", "git"],
	});
	const inv = await buildHermesInvocation(p, "DIRECTIVE:fast");
	const idx = inv.args.indexOf("--toolsets");
	assert.ok(idx >= 0, "--toolsets presente");
	assert.equal(inv.args[idx + 1], "fs,bash,git", "CSV join con virgola");
	if (inv.tmpDir) await fs.promises.rm(inv.tmpDir, { recursive: true, force: true });
});

test("buildHermesInvocation: hermesSkills produce '--skills CSV' con CSV join corretto", async () => {
	const p = makeParticipant({
		name: "u6",
		role: "Tester",
		hermesSkills: ["research", "summarize"],
	});
	const inv = await buildHermesInvocation(p, "DIRECTIVE:fast");
	const idx = inv.args.indexOf("--skills");
	assert.ok(idx >= 0, "--skills presente");
	assert.equal(inv.args[idx + 1], "research,summarize", "CSV join con virgola");
	if (inv.tmpDir) await fs.promises.rm(inv.tmpDir, { recursive: true, force: true });
});

test("buildHermesInvocation: '--yolo' sempre presente anche senza model/tools/skills", async () => {
	const p = makeParticipant({ name: "u7", role: "Tester" });
	const inv = await buildHermesInvocation(p, "DIRECTIVE:fast");
	assert.ok(inv.args.includes("--yolo"), "--yolo sempre presente");
	if (inv.tmpDir) await fs.promises.rm(inv.tmpDir, { recursive: true, force: true });
});

test("buildHermesInvocation: '-z PROMPT' posizionato in coda (ultimo argomento)", async () => {
	const p = makeParticipant({
		name: "u8",
		role: "Tester",
		model: "minimax-m3",
		provider: "anthropic",
		hermesToolsets: ["fs"],
		hermesSkills: ["research"],
	});
	const inv = await buildHermesInvocation(p, "DIRECTIVE:fast — prompt finale");
	const zIdx = inv.args.indexOf("-z");
	assert.ok(zIdx >= 0, "-z presente");
	assert.equal(zIdx, inv.args.length - 2, "-z in penultima posizione (PROMPT è ultimo)");
	assert.equal(
		inv.args[inv.args.length - 1],
		"DIRECTIVE:fast — prompt finale",
		"PROMPT è l'ultimo argomento",
	);
	if (inv.tmpDir) await fs.promises.rm(inv.tmpDir, { recursive: true, force: true });
});

// ─── UNIT: readHermesUsageFile (parser best-effort) ───────────────────────

test("readHermesUsageFile: JSON valido con schema completo popola input/output/cost/turns", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-hermes-usage-unit-"));
	const file = path.join(dir, "usage.json");
	fs.writeFileSync(
		file,
		JSON.stringify({
			estimated_cost_usd: 0.0015,
			input_tokens: 10,
			output_tokens: 20,
			api_calls: 1,
		}),
	);
	const result = freshResult();
	readHermesUsageFile(file, result);
	assert.equal(result.usage.input, 10);
	assert.equal(result.usage.output, 20);
	assert.equal(result.usage.cost, 0.0015);
	assert.equal(result.usage.turns, 1);
	fs.rmSync(dir, { recursive: true, force: true });
});

test("readHermesUsageFile: file assente -> usage a zero, no throw", () => {
	const result = freshResult();
	// Path che sicuramente non esiste.
	assert.doesNotThrow(() => readHermesUsageFile("/tmp/gsd-hermes-no-such-file.json", result));
	assert.deepEqual(result.usage, { input: 0, output: 0, cost: 0, turns: 0 });
});

test("readHermesUsageFile: JSON corrotto -> usage a zero, no throw", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-hermes-usage-unit-"));
	const file = path.join(dir, "usage.json");
	fs.writeFileSync(file, "not-json{{{");
	const result = freshResult();
	assert.doesNotThrow(() => readHermesUsageFile(file, result));
	assert.deepEqual(result.usage, { input: 0, output: 0, cost: 0, turns: 0 });
	fs.rmSync(dir, { recursive: true, force: true });
});

test("readHermesUsageFile: campi mancanti -> usage a zero per i campi assenti, presenti parsati", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-hermes-usage-unit-"));
	const file = path.join(dir, "usage.json");
	fs.writeFileSync(
		file,
		JSON.stringify({
			input_tokens: 42,
			// output_tokens, estimated_cost_usd, api_calls assenti.
		}),
	);
	const result = freshResult();
	readHermesUsageFile(file, result);
	assert.equal(result.usage.input, 42, "campo presente parsato");
	assert.equal(result.usage.output, 0, "campo assente -> 0");
	assert.equal(result.usage.cost, 0, "campo assente -> 0");
	assert.equal(result.usage.turns, 0, "campo assente -> 0");
	fs.rmSync(dir, { recursive: true, force: true });
});

test("readHermesUsageFile: string coercion via toNumber ('0.0015' -> 0.0015)", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-hermes-usage-unit-"));
	const file = path.join(dir, "usage.json");
	fs.writeFileSync(
		file,
		JSON.stringify({
			estimated_cost_usd: "0.0015",
			input_tokens: "123",
			output_tokens: "456",
			api_calls: "7",
		}),
	);
	const result = freshResult();
	readHermesUsageFile(file, result);
	assert.equal(result.usage.cost, 0.0015, "stringa '0.0015' -> 0.0015");
	assert.equal(result.usage.input, 123);
	assert.equal(result.usage.output, 456);
	assert.equal(result.usage.turns, 7);
	fs.rmSync(dir, { recursive: true, force: true });
});

// ─── INTEGRATION: runParticipantTurnViaHermes con fake-hermes ─────────────

const FAKE_PROMPT = (mode: string) =>
	`DIRECTIVE:${mode} — prompt di test per scenario ${mode}`;

/** Esegue un turno reale (fake-hermes) silenziando i warning stderr. */
async function runHermesTurn(
	participant: ParticipantConfig,
	mode: string,
	limits?: ResolvedLimits,
): Promise<ParticipantTurnResult> {
	return captureStderr(() =>
		runParticipantTurnViaHermes(
			participant,
			FAKE_PROMPT(mode),
			process.cwd(),
			undefined,
			undefined,
			limits,
		),
	);
}

test("integration fast: exit 0, text='fast-reply', usage popolato, durationMs > 0", async () => {
	const p = makeParticipant({ name: "fast-p", role: "Tester" });
	const r = await runHermesTurn(p, "fast");
	assertShape(r, p);
	assert.equal(r.exitCode, 0);
	assert.equal(r.text, "fast-reply");
	assert.equal(r.usage.input, 10);
	assert.equal(r.usage.output, 20);
	assert.equal(r.usage.cost, 0.0015);
	assert.equal(r.usage.turns, 1);
	assert.ok(r.durationMs > 0, "durationMs > 0");
});

test("integration silent: exit 0, text='', usage a zero", async () => {
	const p = makeParticipant({ name: "silent-p", role: "Tester" });
	const r = await runHermesTurn(p, "silent");
	assertShape(r, p);
	assert.equal(r.exitCode, 0);
	assert.equal(r.text, "");
	assert.deepEqual(r.usage, { input: 0, output: 0, cost: 0, turns: 0 });
});

test("integration hang con roundTimeoutMs piccolo: failureKind='timeout_round', failureReason contiene 'round timeout'", async () => {
	const p = makeParticipant({ name: "hang-p", role: "Tester" });
	const r = await runHermesTurn(p, "hang", makeLimits({ roundTimeoutMs: 500 }));
	assertShape(r, p);
	assert.equal(r.failureKind, "timeout_round");
	assert.match(
		r.failureReason ?? "",
		/round timeout/,
		"failureReason cita 'round timeout'",
	);
});

test("integration crash: failureKind='failed', failureReason='crash exit=1'", async () => {
	const p = makeParticipant({ name: "crash-p", role: "Tester" });
	const r = await runHermesTurn(p, "crash");
	assertShape(r, p);
	assert.equal(r.failureKind, "failed");
	assert.equal(r.failureReason, "crash exit=1");
});

test("integration no-usage-file: exit 0, text presente, usage a zero (ENOENT tollerato)", async () => {
	const p = makeParticipant({ name: "nouf-p", role: "Tester" });
	const r = await runHermesTurn(p, "no-usage-file");
	assertShape(r, p);
	assert.equal(r.exitCode, 0);
	assert.equal(r.text, "no-usage-file-reply");
	assert.deepEqual(r.usage, { input: 0, output: 0, cost: 0, turns: 0 });
});

test("integration corrupt-usage-file: exit 0, text presente, usage a zero (parse SyntaxError tollerato)", async () => {
	const p = makeParticipant({ name: "corrupt-p", role: "Tester" });
	const r = await runHermesTurn(p, "corrupt-usage-file");
	assertShape(r, p);
	assert.equal(r.exitCode, 0);
	assert.equal(r.text, "corrupt-usage-file-reply");
	assert.deepEqual(r.usage, { input: 0, output: 0, cost: 0, turns: 0 });
});

test("integration model-error: exit 0, text presente, usage a zero (failed:true nel JSON non propaga)", async () => {
	const p = makeParticipant({ name: "model-err-p", role: "Tester" });
	const r = await runHermesTurn(p, "model-error");
	assertShape(r, p);
	assert.equal(r.exitCode, 0);
	assert.equal(r.text, "model-error-reply");
	assert.deepEqual(r.usage, { input: 0, output: 0, cost: 0, turns: 0 });
	assert.equal(r.failureKind, undefined, "model-error NON propaga come failure del turno");
});

test("integration sigkill: failureKind='failed', failureReason='crash SIGKILL'", async () => {
	const p = makeParticipant({ name: "sigkill-p", role: "Tester" });
	const r = await runHermesTurn(p, "sigkill");
	assertShape(r, p);
	assert.equal(r.failureKind, "failed");
	assert.equal(r.failureReason, "crash SIGKILL");
});

// ─── INTEGRATION: dedup del warning provider-without-model ────────────────

test("integration provider-without-model: warning stderr emesso esattamente una volta su due invocazioni consecutive", async () => {
	const p = makeParticipant({
		name: "provider-dedup-p",
		role: "Tester",
		provider: "anthropic",
		// model assente di proposito.
	});
	// Due invocazioni consecutive con stesso participant. La seconda NON
	// deve emettere di nuovo il warning (providerWarned module-scope Set).
	const { stderr } = await recordStderr(async () => {
		await runParticipantTurnViaHermes(p, FAKE_PROMPT("silent"), process.cwd(), undefined);
		await runParticipantTurnViaHermes(p, FAKE_PROMPT("silent"), process.cwd(), undefined);
	});
	const occurrences = (
		stderr.match(/provider valorizzato ma model assente/g) ?? []
	).length;
	assert.equal(
		occurrences,
		1,
		`atteso 1 occorrenza del warning, ottenute ${occurrences}`,
	);
});

test("integration provider-without-model: '--provider' omesso da argv ma '--model' assente (runtime fake-hermes non crasha)", async () => {
	const p = makeParticipant({
		name: "provider-no-model-runtime",
		role: "Tester",
		provider: "anthropic",
	});
	const r = await runHermesTurn(p, "silent");
	assertShape(r, p);
	// fixture silent ignora gli argomenti (no parsing hermes-specific), quindi
	// exit 0 e text vuoto indipendentemente dal contenuto di argv.
	assert.equal(r.exitCode, 0);
	assert.equal(r.text, "");
});

// ─── Cleanup globale: nessun tmpdir residuo dal builder ────────────────────

beforeEach(() => {
	// reset implicito: ogni test pulisce il proprio tmpdir (vedi i test che
	// chiamano buildHermesInvocation). Qui non servono azioni perché il
	// registry metrics non è toccato da questo file.
});