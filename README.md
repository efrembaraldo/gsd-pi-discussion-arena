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

## License

MIT License

Copyright (c) 2026 Efrem Baraldo

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
