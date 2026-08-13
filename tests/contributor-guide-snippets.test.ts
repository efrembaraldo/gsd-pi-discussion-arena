/**
 * Harness di validazione snippet della contributor guide (M006/S03/T02).
 *
 * Contratto eseguibile (Proof by production loader, non by prose — MEM137):
 * ogni fence `participant` e `coordination` delle pagine di
 * `docs/contributor-guide/` è uno snippet COPIIABILE, e come tale viene
 * caricato dal loader di produzione reale:
 *
 *   - fence ```participant  → file participant completo (frontmatter + body):
 *                             scritto in una dir utente temporanea isolata e
 *                             passato a `discoverParticipants` (participants.ts)
 *                             con `skipBundled: true` — la stessa funzione che
 *                             l'estensione esegue a runtime;
 *   - fence ```coordination → coordination file completo (frontmatter + body):
 *                             scritto in un tmp file e passato a
 *                             `loadDiscussionArenaCoordination`
 *                             (src/discussion-arena-coordination.ts) — mai
 *                             throw, zero warning se lo snippet è valido;
 *   - fence ```participant-invalid / ```coordination-invalid → snippet
 *     deliberatamente MALFORMATO: deve produrre esattamente il comportamento
 *     registrato in EXPECTED_INVALID_OUTCOMES per la pagina (skip dalla
 *     discovery, oppure warning `[discussion-arena]`, D053);
 *   - ogni altro tag (yaml, text, bash, ...) → ignorato: usatelo per
 *     illustrazioni parziali che non pretendono di essere copiabili.
 *
 * La validazione non è un'ispezione a vista: i fence vengono scritti su disco
 * (os.tmpdir, mai path gitignored del repo) e caricati dai loader veri. I
 * casi negativi in fondo provano che l'enforcement è sensibile: un participant
 * senza `role` non compare nel risultato, un `rounds_default` non intero
 * produce il warning D053, un virtual role con chiave dict ≠ name viene
 * saltato.
 *
 * Regole per gli autori delle pagine:
 *   - un fence `participant` deve essere un FILE COMPLETO: prima riga `---`,
 *     frontmatter con `name`/`role`/`description` (obbligatori per il loader),
 *     body = system prompt del ruolo. Un frontmatter senza name/role/
 *     description fa sì che `discoverParticipants` salti il file e il test
 *     fallisce nominando `pagina:riga` del fence;
 *   - un fence `coordination` deve essere un FILE COMPLETO: prima riga `---`,
 *     frontmatter con `rounds_default`/`model_default`/`roles_virtuals`. Un
 *     valore non valido (es. `rounds_default: 0`) produce un warning del
 *     loader e il test fallisce: uno snippet copiabile non deve degradare la
 *     config ai code defaults;
 *   - un fence `*-invalid` SENZA registrazione in EXPECTED_INVALID_OUTCOMES
 *     fa fallire il test: la registrazione è il contratto che lega la pagina
 *     al comportamento reale del loader, e il comportamento atteso deve
 *     comparire nella prosa della pagina;
 *   - se una pagina con "participant"/"coordination" nel nome non è registrata
 *     in EXPECTED_CONTRACT_PAGES, la guardia la segnala: una pagina contratto
 *     non può sfuggire all'harness con un nome diverso.
 *
 * Nessuna dipendenza npm: solo node:test e i loader di produzione reali
 * (D004). Un caso di test per pagina, con il nome del file e la riga del
 * fence nel messaggio: uno snippet rotto identifica la pagina senza bisecare
 * (verifica di slice).
 */

import { afterEach, test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDiscussionArenaCoordination } from "../src/discussion-arena-coordination.js";
import { discoverParticipants } from "../participants.js";
import { GSD_AGENT_DIR_ENV, parseFrontmatter } from "./fixtures/pi-coding-agent-stub.js";
import type { ParticipantDiscoveryResult } from "../participants.js";
import type { LoadDiscussionArenaCoordinationResult } from "../src/discussion-arena-coordination.js";

const CONTRIBUTOR_GUIDE_DIR = fileURLToPath(
	new URL("../docs/contributor-guide", import.meta.url),
);

/**
 * Le quattro pagine con contratto snippet (due tipi × EN/IT). L'harness è
 * armato su queste pagine anche prima che esistano: quando T03 le crea, la
 * guardia pretende almeno un fence valido del tipo giusto; se una pagina con
 * "participant"/"coordination" nel nome non è qui, la guardia la segnala.
 */
const EXPECTED_CONTRACT_PAGES = [
	"participants.md",
	"participants.it.md",
	"coordination-file.md",
	"coordination-file.it.md",
];

const FENCE_RE = /^\s*(```|~~~)\s*([^\s`]*)/;

interface SnippetFence {
	tag: string;
	startLine: number;
	lines: string[];
}

/** Estrae i code fence (``` o ~~~) con language tag e righe del corpo. */
function extractFences(content: string): SnippetFence[] {
	const lines = content.split(/\r?\n/);
	const fences: SnippetFence[] = [];
	let inFence = false;
	let tag = "";
	let startLine = 0;
	let body: string[] = [];

	for (let i = 0; i < lines.length; i++) {
		const m = lines[i]!.match(FENCE_RE);
		if (m) {
			if (!inFence) {
				inFence = true;
				tag = m[2] ?? "";
				startLine = i + 1;
				body = [];
			} else {
				fences.push({ tag, startLine, lines: body });
				inFence = false;
			}
			continue;
		}
		if (inFence) body.push(lines[i]!);
	}
	// Fence non chiuso a fine file: viene comunque validato, mai silenzioso.
	if (inFence) fences.push({ tag, startLine, lines: body });
	return fences;
}

// ---------------------------------------------------------------------------
// Fixture temporanee in os.tmpdir (mai path gitignored del repo), cleanup in
// afterEach — stesso pattern di tests/examples-validation.test.ts.
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

function makeTmp(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tmpDirs.push(dir);
	return dir;
}

afterEach(() => {
	// La dir utente è un override per-test: non deve trapelare nei test dopo.
	delete process.env[GSD_AGENT_DIR_ENV];
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop()!;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Comportamento registrato per i fence *-invalid
// ---------------------------------------------------------------------------

/**
 * Registro degli snippet deliberatamente malformati: basename della pagina →
 * comportamento atteso (in ordine di comparsa) per ogni fence `*-invalid`.
 * Gli unici comportamenti reali possibili sono:
 *   - `{ kind: "skip" }`    → il participant non compare in discoverParticipants
 *                             (file scartato dal loader: frontmatter incompleto);
 *   - `{ kind: "warning", match }` → il coordination file produce un warning
 *                             D053 con quella substring (mai throw).
 * La stessa chiave/condizione deve essere documentata nella prosa della
 * pagina (pattern identico a EXPECTED_PARSE_ERRORS della user guide).
 */
type InvalidOutcome = { kind: "skip" } | { kind: "warning"; match: string };

const EXPECTED_INVALID_OUTCOMES: Record<string, InvalidOutcome[]> = {
	// T03: le pagine participants/coordination-file documentano un failure
	// mode reale ciascuna, registrato qui col comportamento atteso (stesso
	// pattern di EXPECTED_PARSE_ERRORS della user guide):
	//   - participants: un file senza il campo obbligatorio `role` viene
	//     escluso silenziosamente dalla discovery ({ kind: "skip" });
	//   - coordination-file: un `rounds_default: 0` (non integer >= 1)
	//     produce il warning D053 del loader ({ kind: "warning" }).
	"participants.md": [{ kind: "skip" }],
	"participants.it.md": [{ kind: "skip" }],
	"coordination-file.md": [
		{ kind: "warning", match: "rounds_default must be a positive integer" },
	],
	"coordination-file.it.md": [
		{ kind: "warning", match: "rounds_default must be a positive integer" },
	],
};

// ---------------------------------------------------------------------------
// Check: i fence scritti su disco e caricati dai loader di produzione
// ---------------------------------------------------------------------------

/**
 * Scrive il fence come unico file participant in una dir utente isolata e lo
 * passa a discoverParticipants (skipBundled: true). Ritorna il risultato
 * completo della discovery e il `name` dichiarato nel frontmatter (via
 * parseFrontmatter, lo stesso parser di produzione). Nessuna asserzione sul
 * contenuto: decide il chiamante se il participant doveva comparire o no.
 */
function checkParticipantSnippet(
	where: string,
	fence: SnippetFence,
): { declaredName: string | null; result: ParticipantDiscoveryResult } {
	const content = fence.lines.join("\n");
	assert.ok(
		/^---\s*$/.test(fence.lines[0] ?? ""),
		`${where}: fence ${fence.tag} senza delimitatore --- iniziale — uno snippet copiabile è un file participant completo (frontmatter + body)`,
	);

	const { frontmatter } = parseFrontmatter(content);
	const declaredName =
		typeof frontmatter.name === "string" && frontmatter.name.length > 0
			? frontmatter.name
			: null;

	const agentDir = makeTmp("cg-snip-agent-");
	const participantsDir = path.join(agentDir, "discussion-arena", "participants");
	fs.mkdirSync(participantsDir, { recursive: true });
	// Il basename non conta: il loader usa il campo `name` del frontmatter.
	fs.writeFileSync(path.join(participantsDir, "snippet.md"), content, "utf8");
	process.env[GSD_AGENT_DIR_ENV] = agentDir;

	const projDir = makeTmp("cg-snip-proj-");
	const result = discoverParticipants(projDir, { skipBundled: true });
	return { declaredName, result };
}

/** Valori dichiarati nel frontmatter di un fence coordination (specchiato dal loader indentation-aware, D051). */
interface CoordinationDeclarations {
	roundsDefault?: number;
	modelDefault?: string;
	/** Chiavi del dict `roles_virtuals` dichiarate a indent 2. */
	virtualKeys: string[];
}

function indentOf(line: string): number {
	const m = line.match(/^ */);
	return m ? m[0].length : 0;
}

/**
 * Estrae dal frontmatter del fence (tra i due `---`) i valori dichiarati che
 * il loader deve parsare: rounds_default, model_default e le chiavi di
 * roles_virtuals. Commenti e righe vuote ignorati, commento inline strippato
 * (stesse regole del loader, D051).
 */
function extractCoordinationDeclarations(fence: SnippetFence): CoordinationDeclarations {
	const decl: CoordinationDeclarations = { virtualKeys: [] };
	let inVirtuals = false;
	for (const raw of fence.lines.slice(1)) {
		if (/^---\s*$/.test(raw)) break; // chiusura frontmatter
		if (!raw.trim() || raw.trim().startsWith("#")) continue;
		const indent = indentOf(raw);
		const content = raw.trim();
		if (indent === 0) {
			if (content === "roles_virtuals:") {
				inVirtuals = true;
				continue;
			}
			if (content.startsWith("rounds_default:")) {
				const v = content.slice("rounds_default:".length).split(" #", 1)[0]!.trim();
				const n = Number(v);
				if (v !== "" && Number.isInteger(n) && n >= 1) decl.roundsDefault = n;
				continue;
			}
			if (content.startsWith("model_default:")) {
				const v = content.slice("model_default:".length).split(" #", 1)[0]!.trim();
				if (v !== "") decl.modelDefault = v;
				continue;
			}
			inVirtuals = false; // altra chiave top-level: fuori dai virtuals
			continue;
		}
		if (inVirtuals && indent === 2 && /:\s*$/.test(content)) {
			const key = content.slice(0, content.indexOf(":")).trim();
			if (key) decl.virtualKeys.push(key);
		}
	}
	return decl;
}

/**
 * Scrive il fence come coordination file in un tmp dir e lo passa a
 * loadDiscussionArenaCoordination (mai throw). Ritorna il risultato completo
 * del loader e i valori dichiarati nel frontmatter.
 */
function checkCoordinationSnippet(
	where: string,
	fence: SnippetFence,
): { result: LoadDiscussionArenaCoordinationResult; declared: CoordinationDeclarations } {
	const content = fence.lines.join("\n");
	assert.ok(
		/^---\s*$/.test(fence.lines[0] ?? ""),
		`${where}: fence ${fence.tag} senza delimitatore --- iniziale — uno snippet copiabile è un coordination file completo (frontmatter + body)`,
	);

	const tmpDir = makeTmp("cg-snip-coord-");
	const filePath = path.join(tmpDir, "coordination.md");
	fs.writeFileSync(filePath, content, "utf8");

	const result = loadDiscussionArenaCoordination(filePath);
	return { result, declared: extractCoordinationDeclarations(fence) };
}

// ---------------------------------------------------------------------------
// Un caso di test per pagina: il messaggio di fallimento nomina file e riga
// ---------------------------------------------------------------------------

function contributorGuidePages(): string[] {
	return fs
		.readdirSync(CONTRIBUTOR_GUIDE_DIR)
		.filter((name) => name.endsWith(".md"))
		.sort();
}

for (const page of contributorGuidePages()) {
	test(`contributor-guide snippet fences in ${page} match the production loader contract`, () => {
		const content = fs.readFileSync(path.join(CONTRIBUTOR_GUIDE_DIR, page), "utf8");
		const fences = extractFences(content);
		const interesting = fences.filter(
			(f) =>
				f.tag === "participant" ||
				f.tag === "coordination" ||
				f.tag === "participant-invalid" ||
				f.tag === "coordination-invalid",
		);
		if (interesting.length === 0) return; // pagina senza snippet copiabili: coperta da altre suite

		const invalid = fences.filter(
			(f) => f.tag === "participant-invalid" || f.tag === "coordination-invalid",
		);
		const expected = EXPECTED_INVALID_OUTCOMES[page] ?? [];
		assert.equal(
			invalid.length,
			expected.length,
			`${page}: ${invalid.length} fence *-invalid ma ${expected.length} registrazione/i in EXPECTED_INVALID_OUTCOMES — registra il comportamento atteso (skip | warning) per ogni snippet malformato`,
		);

		let invalidIdx = 0;
		for (const fence of fences) {
			const where = `${page}:${fence.startLine}`;
			if (fence.tag === "participant") {
				const { declaredName, result } = checkParticipantSnippet(where, fence);
				assert.equal(
					result.participants.length,
					1,
					`${where}: atteso esattamente 1 participant dalla discovery isolata, trovati ${result.participants.length} — lo snippet deve essere un file participant valido`,
				);
				const discovered = result.participants[0]!;
				assert.ok(
					declaredName !== null,
					`${where}: frontmatter senza name — name/role/description sono obbligatori per il loader`,
				);
				assert.equal(
					discovered.name,
					declaredName,
					`${where}: name scoperto ("${discovered.name}") diverso dal frontmatter ("${declaredName}")`,
				);
				assert.equal(
					discovered.source,
					"user",
					`${where}: source atteso "user" (trovato "${discovered.source}")`,
				);
				assert.ok(
					discovered.role.length > 0,
					`${where}: role vuoto dopo la discovery`,
				);
				assert.ok(
					discovered.description.length > 0,
					`${where}: description vuota dopo la discovery`,
				);
			} else if (fence.tag === "coordination") {
				const { result, declared } = checkCoordinationSnippet(where, fence);
				assert.ok(
					result.sourcePath,
					`${where}: il loader di produzione non ha letto il file dello snippet`,
				);
				assert.deepEqual(
					result.warnings,
					[],
					`${where}: il loader ha prodotto warning (D053): ${JSON.stringify(result.warnings)} — uno snippet copiabile non deve degradare la config`,
				);
				if (declared.roundsDefault !== undefined) {
					assert.equal(
						result.config.roundsDefault,
						declared.roundsDefault,
						`${where}: rounds_default dichiarato ${declared.roundsDefault} ma parsato ${result.config.roundsDefault}`,
					);
				}
				if (declared.modelDefault !== undefined) {
					assert.equal(
						result.config.modelDefault,
						declared.modelDefault,
						`${where}: model_default dichiarato "${declared.modelDefault}" ma parsato "${result.config.modelDefault}"`,
					);
				}
				for (const key of declared.virtualKeys) {
					const vr = result.config.rolesVirtuals[key];
					assert.ok(
						vr,
						`${where}: virtual role "${key}" dichiarato nel fence ma assente dalla config del loader`,
					);
					assert.equal(
						vr.name,
						key,
						`${where}: name del virtual role "${key}" diverso dalla chiave del dict — il loader lo salta`,
					);
				}
			} else if (fence.tag === "participant-invalid") {
				const outcome = expected[invalidIdx++]!;
				if (outcome.kind !== "skip") {
					assert.fail(
						`${where}: comportamento registrato per participant-invalid deve essere { kind: "skip" }`,
					);
				}
				const { result } = checkParticipantSnippet(where, fence);
				assert.equal(
					result.participants.length,
					0,
					`${where}: il fence participant-invalid doveva essere escluso dalla discovery (skip), ma ${result.participants.length} participant/i sono comparsi`,
				);
			} else if (fence.tag === "coordination-invalid") {
				const outcome = expected[invalidIdx++]!;
				if (outcome.kind !== "warning") {
					assert.fail(
						`${where}: comportamento registrato per coordination-invalid deve essere { kind: "warning"; match: string }`,
					);
				}
				const { result } = checkCoordinationSnippet(where, fence);
				assert.ok(
					result.warnings.some((w) => w.includes(outcome.match)),
					`${where}: warning atteso "${outcome.match}" non prodotto dal loader — warnings: ${JSON.stringify(result.warnings)}`,
				);
			}
			// Altri tag (yaml, text, bash, ...): illustrazioni parziali, non validate qui.
		}
	});
}

// ---------------------------------------------------------------------------
// Guardie: l'harness è armato sui contratti anche prima che le pagine esistano
// ---------------------------------------------------------------------------

test("guardia: pagine contratto registrate e ancorate, nessuna pagina con contratto sfugge all'harness", () => {
	const pages = contributorGuidePages();
	for (const page of EXPECTED_CONTRACT_PAGES) {
		const full = path.join(CONTRIBUTOR_GUIDE_DIR, page);
		if (!fs.existsSync(full)) continue; // T03 crea le pagine: a T02 l'harness è armato ma disattivo
		const fences = extractFences(fs.readFileSync(full, "utf8"));
		const kind = page.startsWith("coordination") ? "coordination" : "participant";
		assert.ok(
			fences.some((f) => f.tag === kind),
			`${page}: nessun fence \`${kind}\` trovato — la pagina contratto deve contenere almeno uno snippet copiabile validato dal loader di produzione`,
		);
	}
	for (const page of pages) {
		if (/participant|coordination/.test(page) && !EXPECTED_CONTRACT_PAGES.includes(page)) {
			assert.fail(
				`${page}: pagina con contratto snippet non registrata in EXPECTED_CONTRACT_PAGES — registrala o rinominala, altrimenti i suoi fence sfuggono all'harness`,
			);
		}
	}
});

// ---------------------------------------------------------------------------
// Casi negativi su fixture temporanee: l'enforcement è sensibile, non tautologico
// ---------------------------------------------------------------------------

test("negativo: un fence participant senza role non viene scoperto da discoverParticipants", () => {
	const fence: SnippetFence = {
		tag: "participant",
		startLine: 0,
		lines: [
			"---",
			"name: ghost",
			"description: ruota senza role obbligatorio",
			"---",
			"Corpo del prompt.",
		],
	};
	const { result } = checkParticipantSnippet(
		"fixture-negativo:participant-senza-role",
		fence,
	);
	assert.equal(
		result.participants.length,
		0,
		"un participant senza role deve essere escluso dalla discovery (parseParticipantContent → null)",
	);
});

test("negativo: coordination con rounds_default non intero produce il warning D053 e nessun default", () => {
	const fence: SnippetFence = {
		tag: "coordination",
		startLine: 0,
		lines: ["---", "rounds_default: 0", "---", "Body del file."],
	};
	const { result } = checkCoordinationSnippet(
		"fixture-negativo:rounds-non-valido",
		fence,
	);
	assert.ok(result.sourcePath, "il loader non deve fallire sul file (mai throw)");
	assert.equal(
		result.config.roundsDefault,
		undefined,
		"un rounds_default non valido non deve produrre un default",
	);
	assert.ok(
		result.warnings.some((w) => w.includes("rounds_default")),
		`il loader deve segnalare la chiave non valida (warnings: ${JSON.stringify(result.warnings)})`,
	);
});

test("negativo: virtual role con chiave dict diversa dal campo name viene saltato da discoverParticipants", () => {
	const agentDir = makeTmp("cg-snip-neg-agent-");
	fs.mkdirSync(path.join(agentDir, "discussion-arena", "participants"), { recursive: true });
	process.env[GSD_AGENT_DIR_ENV] = agentDir;

	const projDir = makeTmp("cg-snip-neg-proj-");
	const coordDir = path.join(projDir, ".gsd", "discussion-arena");
	fs.mkdirSync(coordDir, { recursive: true });
	const coordPath = path.join(coordDir, "discussion-arena-coordination.md");
	fs.writeFileSync(
		coordPath,
		[
			"---",
			"roles_virtuals:",
			"  a:",
			"    name: b",
			"    role: Ghost",
			"    description: chiave del dict diversa dal name",
			"    systemPrompt: |",
			"      Prompt del virtual role.",
			"---",
		].join("\n"),
		"utf8",
	);

	const result = discoverParticipants(projDir, { skipBundled: true, coordinationPath: coordPath });
	const byKey = result.participants.find((p) => p.name === "a");
	const byName = result.participants.find((p) => p.name === "b");
	assert.equal(byKey, undefined, "il virtual role con chiave 'a' ma name 'b' non deve essere applicato");
	assert.equal(byName, undefined, "il name interno 'b' non è la chiave canonica: nessun participant deve comparire");
});
