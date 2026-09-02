# Agent Discussion Arena for gsd-pi

**Languages:** [English](README.md) · [Italiano](README.it.md)

[![CI](https://github.com/efrembaraldo/gsd-pi-discussion-arena/actions/workflows/ci.yml/badge.svg)](https://github.com/efrembaraldo/gsd-pi-discussion-arena/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@efrembaraldo/gsd-pi-discussion-arena)](https://www.npmjs.com/package/@efrembaraldo/gsd-pi-discussion-arena)

Extension that adds a `discussion_arena` tool and a `/discussion-arena` command
to gsd-pi. It makes N participants (roles/skills you define in Markdown)
discuss a topic for K rounds, and returns the transcript to the agent that
invoked the tool — so **gsd-pi stays the coordinator**: the discussion arena is
only a tool that the agent active in the current unit may decide to use,
exactly like it would use bash or web-search.

## Documentation

| Section | Audience | Covers |
| --- | --- | --- |
| [User Guide](docs/user-guide/index.md) | People who install and use the extension | Installation, configuration, usage, persistent sessions, troubleshooting |
| [Contributor Guide](docs/contributor-guide/index.md) | People who extend the extension | Adding roles, writing loadable examples, repository and documentation conventions |
| [Architecture Reference](docs/architecture/index.md) | People who modify internals | Tool registration, subprocess model, trigger resolution, auto-mode hooks, runtime limits |

## How it works

1. `discussion_arena` is a tool registered via `api.registerTool()` — the
   same mechanism as any custom gsd-pi tool.
2. Each participant runs as an isolated `gsd --mode json -p --no-session`
   subprocess, with its own system prompt and (optionally) its own model and
   restricted tool set.
3. Rounds are sequential on purpose: in round N each participant sees the
   turns already given by the others in the same round (real dialogue). For a
   simultaneous debate where nobody sees the others until the end of the
   round, see the comment in `index.ts` (`runDiscussionArena`) on how to
   invert the order with `Promise.all`.
4. The resulting transcript returns as the tool result to the calling agent,
   which decides what to do with it (synthesize, decide, write code
   accordingly) — the phase/progression logic stays entirely in the gsd-pi
   auto orchestrator (`resolveDispatch`, `orchestrator.ts`), which has no
   awareness of the discussion arena.

## Engines: `gsd` (default) and `hermes -z` (opt-in)

Each participant runs as an isolated subprocess. The discussion arena supports two
engines, declared per-participant in the `.md` frontmatter:

- **`gsd` (default)** — the original `gsd --mode json -p --no-session`
  subprocess described in "How it works" above. This is what every bundled
  participant (`analyst`, `architect`, `dev`, `qa`) uses and is the
  unchanged behavior from M001–M014.
- **`hermes -z` (opt-in)** — added in milestone M015 (`Hermes come motore
  di un partecipante nella Discussion Arena`). A participant opts in by
  setting `engine: hermes` in its frontmatter, plus optional `provider`,
  `hermes_toolsets`, `hermes_skills`, and `soft_deadline_ms`. The discussion arena
  spawns `hermes -z <prompt> --usage-file <path>` reusing the existing
  timer/abort/kill layer (D039), and degrades to `gsd` — emitting a one-shot
  warning on stderr plus a `<!-- engine: gsd (degradato...) -->` marker in the
  transcript — when the `hermes` binary is not in `PATH`.

The bundled `participants/researcher.md` is a working example of an
`engine: hermes` participant. See
[`docs/architecture/participant-subprocesses.md`](docs/architecture/participant-subprocesses.md)
for the full engine contract (D126, D127) and the soft-deadline / recovery
block semantics (R042, R043).

## Installation (from npm, after publishing — see dedicated section)

```bash
# Top-level CLI command (verified in packages/pi-coding-agent/src/core/package-commands.ts —
# appName resolves to "gsd" for this binary)
gsd install npm:@efrembaraldo/gsd-pi-discussion-arena

# Alternatively, inside an interactive session:
# /gsd extensions install @efrembaraldo/gsd-pi-discussion-arena
```

Then restart gsd-pi (or `/reload` in an interactive session).

## Manual installation (without npm, for local testing)

```bash
mkdir -p ~/.gsd/agent/extensions/gsd-pi-discussion-arena
cp -r index.ts participants.ts run-participant.ts package.json extension-manifest.json ~/.gsd/agent/extensions/gsd-pi-discussion-arena/

mkdir -p ~/.gsd/agent/discussion-arena/participants
cp participants/*.md ~/.gsd/agent/discussion-arena/participants/
```

For a **project** scope (different participants per repo), create instead:

```bash
mkdir -p .gsd/discussion-arena/participants
cp participants/*.md .gsd/discussion-arena/participants/
```

Project participants take precedence over user ones with the same `name`
(the same project > user precedence rule gsd-pi uses for skills).

## Verifying the installation

```bash
gsd extensions info gsd-pi-discussion-arena   # confirms the manifest was read
gsd -p "list the available tools" --mode json | grep discussion_arena
```

Quick manual test, outside auto mode:

```bash
gsd
> /discussion-arena Should we migrate hel-arxai from MongoDB 7.x to a hybrid model with Postgres for the relational data?
```

## Bootstrap

The `/discussion-arena-init` slash command scaffolds the project-level
coordination tree for the discussion arena. It is safe to run at any time,
even after the extension is already installed and used.

### Slash command: /discussion-arena-init

```
/discussion-arena-init
```

Takes no arguments. On first run it creates the following structure under
the current working directory:

```
.gsd/discussion-arena/
├── participants/           # project-level participants (override of bundled/user)
│   └── .gitkeep
├── participants-overrides/ # per-role overrides for project participants
│   └── .gitkeep
└── transcripts/            # saved sessions of the discussion arena
    └── .gitkeep
```

On subsequent runs the command is **idempotent**: existing directories are
left untouched, and `.gitkeep` files are only written when a subdirectory is
freshly created. You can drop your own `analyst.md`, `architect.md`, etc.
into `participants/` and the command will never overwrite or disturb them
— the init flow is non-destructive by design.

The command is **failure-safe**: it never throws. Filesystem errors
(`EACCES`, `ENOSPC`, and similar) are collected into the result's `errors[]`
and surfaced through the session notification, so the worst-case outcome is
a visible "what failed" message rather than a crashed pipeline.

## Streaming mode

The `stream` parameter controls the live streaming mode of the discussion arena tool.
Default: `"off"` (current behavior).

- `"off"` — No live streaming. The `onProgress` callback receives the
  cumulative `partialTranscript` as usual.
- `"events"` — Populates `details.streamingEvents: StreamingEvent[]` at
  every discussion event. Each `StreamingEvent` carries `ts` (ISO 8601),
  `type`, `participantId`, `round`, `costUsd`, `durationMs`,
  `cumulativeCost`, `text`. Useful for UIs that want real-time per-participant
  rendering.
- `"transcript"` — Minimal stub (M018): accepts the parameter, emits a
  warning to stderr, and falls back to `"off"`. Full implementation is
  planned for a future slice.

Example:

```typescript
await discussionArena({
  topic: "Architectural trade-offs for module X",
  participants: ["analyst", "architect"],
  rounds: 3,
  stream: "events",
});
```

Note: sessions with many participants and rounds can produce thousands of
events. The consumer is responsible for throttling and rendering.

## Branching di sessioni

The `discussion_arena` tool accepts an optional `branch` parameter that
creates a new child session derived from an existing ancestor session,
leaving the ancestor fully untouched. This is a capability-additive
feature (R058): it short-circuits the normal run flow and reuses the
existing `continuation?` mechanism of `runDiscussionArena`, so the round
loop itself is unchanged. The validator lives in `branch.ts` as a pure
helper (`validateBranchRequest`) and is invoked before any subprocess is
spawned, so the failure paths are fail-fast.

The `branch` parameter is a JSON-like object with four fields:

- `fromSessionId` — string, the logical ID of the ancestor session
  (defaults to `fromTopicSlug` when omitted).
- `fromTopicSlug` — string, the topic-slug of the ancestor session used
  for the transcript path lookup.
- `afterRound` — integer with 1 ≤ value ≤ MAX_ROUNDS, the 1-based last
  round (inclusive) to inherit from the ancestor's transcript.
- `newTopic` — string, the topic of the new child session. It must not
  already exist (no overwrite).

Behavior on the happy path:

- Creates a new transcript file named `<cwdHash>-<newTopic>.md` inside
  `<cwd>/.gsd/discussion-arena/transcripts/`, with three new frontmatter
  fields populated: `parentSessionId`, `parentTopicSlug`, and
  `branchedFromRound`. These three fields are optional in the parser,
  so legacy files written without them keep loading unchanged
  (R064 anti-regressione).
- Prefixes the ancestor transcript (rounds 1 through `afterRound`,
  inclusive) as the starting context, so the child session continues
  from that point with the same participants and the same accumulated
  cost and duration.
- The ancestor session file is left fully untouched: same content, same
  mtime. No part of the ancestor is mutated.

Three blocking error scenarios (validated up-front, before any subprocess
is spawned — D058):

1. `afterRound` is greater than the round count of the ancestor session —
   the request is rejected and the existing files are not modified.
2. The ancestor session cannot be found by `fromTopicSlug` — the request
   is rejected with a canonical "parent session not found" error.
3. `newTopic` collides with an existing transcript file — the request is
   rejected. The existing file is never overwritten, even if the caller
   asks for it explicitly.

Example (the example takes the first two rounds of an ancestor
discussion titled "AI value in ERP" and forks them as the starting
context of a new child discussion titled "AI value in ERP - optimization
branch"; the ancestor file keeps its original content and mtime, the
child file is a brand-new session with the parent fields populated):

```typescript
await discussionArena({
  topic: "AI value in ERP - optimization branch",
  participants: ["analyst", "architect"],
  rounds: 2,
  branch: {
    fromSessionId: "AI value in ERP",
    fromTopicSlug: "AI value in ERP",
    afterRound: 2,
    newTopic: "AI value in ERP - optimization branch",
  },
});
```

This feature is purely additive: callers that do not pass `branch`
continue to use the regular run flow unchanged. See
`docs/architecture/invocation-flow.md` for the full source-anchored
contract of the factory short-circuit.

## Decision schema

The `discussion_arena` tool accepts two optional parameters,
`decisionSchema` and `persistDecision`, that together enable structured
per-turn decision capture alongside the free-form transcript. This is
a capability-additive feature (R064): the existing flow is untouched
when the parameters are omitted, so callers that never pass them keep
working with zero behavioral diff.

`decisionSchema` is a JSON-like object describing the schema that every
participant turn is expected to emit. It carries three fields:

- `type` — string literal, currently the only supported value is
  `"approve-reject"`. Additional types (e.g. `"ranked"`, `"graded"`)
  will be added in future slices by extending the type's union; the
  literal-only constraint keeps forward compatibility tight.
- `description` — optional human-readable description, propagated to
  participants as contextual hint (best-effort, depends on participant
  cooperation).
- `fields` — optional map of arbitrary key/value pairs, reserved for
  future validation rules (enums, min/max, …). Currently a no-op
  sink; accepted so future schema extensions can land without
  breaking existing callers.

`persistDecision` is an optional boolean. When `true`, the tool intends
to persist the synthesized final decision via an MCP write (R066).
The MCP writer is not yet implemented in M018/S05 — passing `true`
emits a canonical `[discussion-arena] warning` on stderr and sets
`details.persistDecisionWritten = false`. A dedicated slice is
required to enable the actual write path.

### Output format

Every participant turn (including the Scribe synthesis turn) may embed
zero or more fenced decision blocks in the transcript. The delimiter
for per-turn decisions is triple backticks followed by `decision`:

````text
```decision
{ "choice": "approve", "confidence": 0.9 }
```
````

The Scribe synthesis turn may additionally emit a single
`final-decision` block to canonically record the synthesized arbitration
result:

````text
```final-decision
{ "consensus_level": 0.85, "final_choice": "approve" }
```
````

These blocks are orthogonal to the existing `extractResearchDecisions`
markdown-section parser: the two systems coexist on the same transcript
without interfering with each other.

When `decisionSchema` is set, the factory enriches the response's
`details` with three additional fields:

- `details.decisions` — array of `{participantId, round, parsed,
  parseError}` objects, one per per-turn block found in the transcript,
  in document order. `parsed` is the JSON.parse'd payload (or `null`
  if malformed); `parseError` is the parser's error message (or `null`
  on success). The raw text of the block is intentionally omitted
  from this envelope to keep it minimal — the full transcript is
  still returned in the response content for callers that need it.
- `details.finalDecision` — `{rawText, parsed, parseError}` from the
  Scribe's `final-decision` block, or `undefined` if no Scribe turn
  was produced (or the Scribe emitted no final-decision block). When
  present, `rawText` is included because the Scribe's synthesis is
  authoritative arbitration content.
- `details.persistDecisionWritten` — boolean, only present when
  `persistDecision: true`. Always `false` in M018/S05 (MCP writer
  not implemented; see warning above).

### Five tolerant error scenarios

The factory does not reject malformed input; instead, it populates the
envelope so callers can introspect failures:

1. **JSON malformed** — a `decision` or `final-decision` block whose
   payload is not valid JSON (e.g. truncated, wrong quotes, comments
   inside). Result: the corresponding `details.decisions[i].parsed` is
   `null` and `parseError` carries the parser message.
2. **No decision block found** — the transcript contains no `decision`
   blocks at all. Result: `details.decisions` is an empty array; no
   error is raised.
3. **No Scribe synthesis** — the transcript has no Scribe turn (no
   role equals `"Scribe"`). Result: `details.finalDecision` is
   `undefined` (the field is omitted from the envelope, not set to
   `null`).
4. **Scribe without final-decision block** — the Scribe emits a turn
   but no `final-decision` fenced block. Result: `details.finalDecision`
   is `undefined` (same as no Scribe).
5. **Scribe with malformed final-decision block** — the Scribe emits a
   `final-decision` block with invalid JSON. Result:
   `details.finalDecision.parsed` is `null` and `parseError` is
   non-null. The field IS present (not `undefined`) because the caller
   wants to know the block exists but is broken.

### Behavior outside the happy paths

- **Replay short-circuit** — when `replay` is set, the response is
  served from the saved transcript without invoking
  `runDiscussionArena`. No decision schema enrichment is applied;
  `details.replay` carries the replay metadata unchanged.
- **Branch path** — when `branch` is set, the child session's
  transcript is enriched identically to the main run path. The same
  five error scenarios apply on the branch transcript.
- **Error catch** — when `runDiscussionArena` throws, the catch
  handler returns `details.pendingResearchWritten: false` directly,
  without invoking the decision schema enrichment.

### Backward compatibility (R064)

Callers that do not pass `decisionSchema` see exactly the same
response shape as before M018/S05. The three new `details` fields are
populated only when `decisionSchema !== undefined`. This is verified
by an anti-regression test in `tests/decision-schema.test.ts`.

### End-to-end example

```typescript
const result = await discussionArena({
  topic: "Refactor auth provider",
  participants: ["engineer", "reviewer"],
  rounds: 2,
  decisionSchema: {
    type: "approve-reject",
    description: "Approve or reject the proposed refactor",
  },
});

// result.details.decisions:
// [
//   { participantId: "engineer", round: 1, parsed: { choice: "approve", confidence: 0.9 }, parseError: null },
//   { participantId: "reviewer", round: 1, parsed: { choice: "approve", confidence: 0.8 }, parseError: null },
//   { participantId: "engineer", round: 2, parsed: null, parseError: "Unexpected token } in JSON at position 42" },
// ]

// result.details.finalDecision:
// { rawText: "{ \"consensus_level\": 0.85, \"final_choice\": \"approve\" }",
//   parsed: { consensus_level: 0.85, final_choice: "approve" },
//   parseError: null }
```

See `docs/architecture/invocation-flow.md` for the source-anchored
contract of the enrichment wiring in the factory.

## Viewer

The command `discussion-arena-view <id>` renders the discussion arena event log
of a completed run into a single self-contained HTML file that you can open
offline in any browser.

- `<id>` is the `details.discussionArenaId` value returned by the
  discussion arena tool. The event log exists only for runs started with
  `eventLog: true`;
  for an id without an event log the command fails with
  `event log not found or empty: <id>`.
- The file is written to `<cwd>/.gsd/discussion-arena/views/<id>.html`. On
  success the command notifies the written path together with a ready-to-open
  `file://` URL; on failure it notifies
  `[discussion-arena-view] error: <message>` (the other canonical failure is
  `invalid replay id format: <id>` for a malformed id).
- Open the produced file in any browser via the printed `file://` URL.

Guarantees of the generated file:

- Standalone document: `doctype` / `html` / `head` (inline `<style>`) / `body`
  / `main` with one `article` per round.
- Embedded CSS with `prefers-color-scheme` support (dark mode included);
  zero external assets: no `<link>`, no `script src=`, no CDN reference.
- Every participant text is HTML-escaped (`&`, `<`, `>`, quotes), so
  participant output can never inject markup or scripts (no XSS).
- Idempotent: re-running the command for the same id rewrites the file
  byte-identically (rendering is deterministic and clock-free).
- When the decision schema is active, each round with a well-formed decision
  block shows a decision box with the pretty-printed parsed JSON; a malformed
  block shows a visible parse error instead.

## Customizing roles and skills

After installation the discussion arena works out of the box with the 4
bundled example participants (`analyst`, `architect`, `dev`, `qa`). To add or
override roles, create a `.md` file in one of these directories (precedence:
project > user > bundled):

- `.gsd/discussion-arena/participants/` — project level (walk-up to the git root)
- `~/.gsd/agent/discussion-arena/participants/` — user level
- `participants/` next to the installed module — the bundled examples (conceptual read-only)

## Configuring the model

Each participant `.md` can specify `model:` in the frontmatter — it is the
model used to spawn `gsd` as a subprocess for that participant:

```markdown
---
name: analyst
role: Business Analyst
description: Clarifies requirements
model: claude-sonnet-5            # ← model for this participant
tools: read, grep
---
```

If `model:` is omitted, the `gsd` subprocess uses the active model of the
parent session (i.e. the one set with `/model` or `gsd --model`).

To force a model **for an entire session** without editing files, use the
`--model <id>` command flag:

```
/discussion-arena "topic" 2 --model claude-sonnet-5
```

The override applies to all rounds of the session; on the next invocation
without `--model`, participants fall back to their `.md`.

## Persistent sessions and continuation

Every command invocation saves the cumulative transcript to
`<cwd>/.gsd/discussion-arena/transcripts/<cwd-hash>-<topic-slug>.md` (YAML frontmatter + markdown body). Project-relative: the transcript is visible in the repo working tree (tip: add `.gsd/` to your project `.gitignore` if you don't want to commit transcripts).

To add rounds to an existing session without starting over, use `--continue`:

```
/discussion-arena "AI value in ERP" 2           # rounds 1-2, saves the session
/... read, decide ...
/discussion-arena "AI value in ERP" 1 --continue # round 3 (continuous numbering)
/discussion-arena "AI value in ERP" 2 --continue # rounds 4-5, then you see the MAX_ROUNDS message
```

Without `--continue`, every invocation starts from scratch. `--new` forces a
new session even if a file already exists.

Each `.md` file follows this frontmatter:

```markdown
---
name: unique-identifier       # used to invoke it from participants: [...]
role: Label shown in the transcript
description: One line, also used in the tool promptSnippet
tools: read, grep, find, ls        # optional — subset of allowed tools
model: claude-sonnet-5             # optional — model override for this role
---

File body = the role's system prompt. Behavioral instructions,
not domain knowledge to repeat every round.
```

I included 4 example participants (`analyst`, `architect`, `dev`, `qa`),
translated from the equivalent BMAD-METHOD roles (`bmad-agent-analyst`,
`bmad-agent-architect`, `bmad-agent-dev`, plus a QA synthesized from the
`bmad-qa-generate-e2e-tests`/`bmad-code-review` skills since BMAD has no
single dedicated QA agent file in the current v6). Add more by copying the
schema — e.g. a `ux-designer.md` from the content of
`bmad-agent-ux-designer/SKILL.md`.

## Auto-mode: three activation tiers (Tier 1-2-3)

Inside the gsd-pi auto loop the discussion arena behavior has **two states**:

- **Available** — in every phase (`researching`, `planning`, `executing`,
  `verifying`, `closeout`) the `discussion_arena` tool is registered and
  visible to the agent, which can invoke it on its own when it considers it
  useful, as the tool's `promptGuidelines` urge it to do (decisions that
  benefit from multiple perspectives, not executive work).
- **Forced** — only in the `planning` phase and only if one of the Tier 1/2
  triggers below is active, the extension forces the agent to use the
  discussion arena before deciding the plan: it adds the tool to the toolset
  and injects a specific instruction into the prompt.

The decision between the two states is a pure function (`trigger-resolver.ts`)
with deterministic order — it never throws, there is always a result:

1. **Tier 1 — environment variable.** `GSD_DISCUSSION_ARENA_AUTO=1` →
   the discussion arena is mandatory (source `env`). The simplest and most
   global way to force it: set the variable in the terminal before starting
   `gsd auto`.
2. **Tier 2 — coordination file (`activation:`).** If in the `activation:`
   section of `<cwd>/.gsd/discussion-arena/discussion-arena-coordination.md`
   the current milestone has `milestones.<MID>.enabled: true`, or `enabled:
   true` at global level, the discussion arena is mandatory (source
   `preferences`). The legacy `discussion_arena:` section in
   `<cwd>/.gsd/PREFERENCES.md` is still honored for backwards compatibility
   but emits a one-shot deprecation warning; see
   [Migration path](#migration-path-discussion_arena--activation).
3. **Tier 3 — availability-only fallback.** If neither Tier 1 nor Tier 2
   enable it, the default is `availability-only`: the discussion arena stays
   **available but not forced** (no `adjust_tool_set` adds it, no instruction
   in the prompt). It is the default M001 behavior, deterministic and safe.

Tier 1 and Tier 2 are the only paths that make the invocation **mandatory**.
`always-on` as a fallback would be too aggressive: the user could not disable
the discussion arena for a low-risk milestone without an explicit opt-out.

### Migration path: `discussion_arena:` → `activation:`

The `discussion_arena:` section in `<cwd>/.gsd/PREFERENCES.md` is
**deprecated** but still read. New setups — and the interactive wizard —
configure the discussion arena in the coordination file
`<cwd>/.gsd/discussion-arena/discussion-arena-coordination.md` under the
`activation:` section. The two share the same keys and the same 2/4/6-space
indentation contract (D025), so migration is a straight copy.

A project that still defines the legacy section shows a one-shot warning on
stderr:

```
[discussion-arena] DEPRECATION: discussion_arena: section in PREFERENCES.md is deprecated — move to .gsd/discussion-arena/discussion-arena-coordination.md under activation:.
```

To migrate, remove `discussion_arena:` from `PREFERENCES.md` and add
`activation:` to the coordination file:

```yaml
activation:
  enabled: true
  mode: per-milestone
  milestones:
    M001:
      enabled: true
```

### The (legacy) `discussion_arena:` schema in PREFERENCES.md (D025)

Inside the frontmatter of `<cwd>/.gsd/PREFERENCES.md` (minimal YAML parser,
zero dependencies — D004), the section uses this schema:

```yaml
discussion_arena:
  enabled: false            # bool — default false; true = always-on
  mode: availability-only   # per-milestone | always-on | availability-only
  milestones:
    M003:
      enabled: true         # force only for that milestone
```

The parser distinguishes 4 states: missing file, missing section, valid
config, malformed config — on malformed config it emits a warning (never a
`throw`) and applies the deterministic fallback.

### Interactive wizard (TUI) at milestone_start

At the `milestone_start` event, if the session has a TUI (`hasUI === true`),
the extension proposes a 3-choice picker (`ui.select`) and persists the
choice **atomically** (read-modify-write) in the `activation:` section of the
coordination file
`<cwd>/.gsd/discussion-arena/discussion-arena-coordination.md`:

- `per-milestone` → writes `activation.milestones.<MID>.enabled: true`
- `always-on` → writes `activation.enabled: true`
- `availability-only` → writes `activation.enabled: false` (default)

If `hasUI === false` (CI/print/no-TUI mode), the wizard is a **strict no-op**:
it only writes a diagnostic to `stderr` and returns, never blocking the
pipeline.

### Phase hooks (S06)

The current phase is tracked by the `unit_start` event (D024). The obligation
to use the discussion arena fires only when both conditions are true: the
current phase is `planning` **and** `resolveTrigger().decision === "forced"`. In that
case:

- `adjust_tool_set` adds `discussion_arena` to `toolNames` (removes nothing);
- `before_agent_start` adds an idempotent instruction to the prompt
  (identified by an HTML marker, never duplicated) that pushes to use the
  discussion arena before deciding the plan.

In every other phase (`executing`, `verifying`, `closeout`), or in decision
`availability-only`, the tool stays registered but **never forced**.

## Known limitations

- `MAX_PARTICIPANTS = 8`, `MAX_ROUNDS = 5` — hardcoded in
  `index.ts`, raise them if you need wider discussions.
- For very long transcripts (e.g. after many `--continue` sessions), the
  prompt passed to the model is truncated to ~100KB discarding the oldest
  rounds (prompt only — the full transcript on disk is preserved, see the
  "Persistent sessions" section).
- Every turn of every participant is a full `gsd` process: cost and latency
  scale linearly with participants × rounds. With 4 participants and 2 rounds
  that is 8 model invocations for a single tool call.
- It has not been compiled against the real gsd-pi tree (that would require
  `pnpm install` of the whole monorepo): the `ExtensionAPI`,
  `ToolDefinition`, `AgentToolResult` signatures were verified by reading
  `packages/pi-coding-agent/src/core/extensions/extension-upstream-types.ts`
  and `packages/pi-agent-core/src/types.ts` in the cloned repo, but a real
  `tsc --noEmit` before the first production use is recommended.

### Integration gaps with gsd-pi (Vision v2 §2)

Beyond the internal limits above, the extension has **not** yet achieved the
"deterministic forced integration" described in Vision v2 §2. That analysis
(seven gaps, G1–G7) lives in an internal planning document kept in the local
working tree as an honest, in-flight artifact — untracked in git and not part
of the shipped docs graph. Each gap below lists its current state
(`workaround` = a local mitigation exists, `open` = no mitigation yet):

- **G1** — `unit_start` is never emitted by `gsd-pi` (no `before_agent_start`
  call-site), so every auto-mode hook is a no-op and Tier 1/2/3 "forced" does
  not run. *State: open* (degraded probe workaround is theoretical only).
- **G2** — The `"planning"` unit-type does not exist in `gsd-pi`, so even if
  G1 were fixed `currentUnitType` would not match; hooks stay silently
  inactive. *State: open*.
- **G3** — The bundled model `minimax/minimax-m3` (verified in
  `participants/architect.md:6`, `participants/analyst.md:6`,
  `participants/dev.md:6`, `participants/qa.md:6`, and in all
  `examples/participants/*.example.md`; provider-id format per D092)
  must be resolvable in the caller's registry or participant subprocesses
  fail out-of-the-box and the quickstart does not work. *State:
  workaround* — point the model at a valid provider/project-level
  `model_default` in the coordination file.
- **G4** — `writePendingResearch` is never invoked from `index.ts` and no
  `scribe` participant is bundled, so the S04 pipeline
  (research-decision → REQUIREMENTS.md) is dead. *State: open*.
- **G5** — `adjust_tool_set` short-circuits on the first handler
  (`runner.ts:1183`), a race between the core listener and the extension
  listener; the tool injection is not applied unless the load order is the
  expected one. *State: workaround* — this is a load-order concern handled
  by the upstream framework; the extension manifest intentionally does not
  declare a `priority` field (D083 removed it because the loader did not
  honor it), so we rely on the documented core-first extension ordering.
- **G6** — The test suite is entirely stub-based (redirect of
  `@gsd/pi-coding-agent` to `tests/fixtures/`): CI passes by simulating
  events that `gsd-pi` does not emit. *State: open*.
- **G7** — `extension-manifest.json` declares neither capabilities nor
  runtime dependencies, so the registry cannot guess what the extension
  expects out-of-the-box. *State: open*.

The seven runtime risks (R1–R7) these gaps imply are tracked in
[`docs/architecture/runtime-fallbacks.md`](docs/architecture/runtime-fallbacks.md) /
[`runtime-fallbacks.it.md`](docs/architecture/runtime-fallbacks.it.md). As
of this writing, R1, R2, R3, R5, and R6 are populated with their local
mitigations (zero-PR umbrella strategy, `src/phase-mapping.ts` matrix,
Tier F/A/D/G runtime classifier, the S02 scribe bundled as
`participants/scribe.md`, and the S01 cross-process lock); R4 and
R7 remain explicit "not yet implemented" placeholders (honest
skeletons, not closure claims).

## License

MIT License

Copyright (c) 2026 Efrem Baraldo

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
