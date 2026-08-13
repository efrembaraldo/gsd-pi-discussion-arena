**Languages:** [English](quickstart.md) · [Italiano](quickstart.it.md)

[User Guide](index.md) — Quickstart

# Running your first discussion round

This page takes you from a fresh installation to a real discussion round in
about five minutes, using only the four participants bundled with the
extension — no configuration file, no custom roles. Everything shown here is
anchored to the production code: the participant list comes from
`participants/*.md` next to the installed module, the transcript shape comes
from `runDiscussionArena` (`index.ts`), and the round mechanics from
`run-participant.ts`.

The [README](../../README.md) covers the same ground in compact form. This
page shows the complete path with the expected output, so you know what a
healthy first run looks like before you start.

## Prerequisites

- The extension is installed and gsd-pi was restarted afterwards — see
  [Installing the discussion arena extension](install.md) if you are not
  sure.
- You are in a gsd-pi project directory (the discussion arena resolves
  everything relative to the working directory).
- `gsd` is on your `PATH` — check with `gsd --version`.

That is all. The discussion arena works out of the box with the bundled
participants; there is nothing to configure for a first round.

## The four bundled participants

After installation the extension discovers exactly four participants, the
examples shipped in `participants/` next to the module. Their identity is
their `name`; their `role` is what appears in the transcript:

| `name` | `role` (transcript label) | Frontmatter model |
| --- | --- | --- |
| `analyst` | Business Analyst | `<inference provider>` |
| `architect` | Software Architect | `<inference provider>` |
| `dev` | Senior Developer | `<inference provider>` |
| `qa` | QA / Reviewer | `<inference provider>` |

These are the values actually shipped in this repository
(`participants/analyst.md`, `architect.md`, `dev.md`, `qa.md`). When you
invoke the discussion arena without a `participants` argument, **all discovered
participants** take part — with just the extension installed, that means
these four. The [Installation](install.md) page explains how project and
user participants take precedence over the bundled ones.

## Your first round, from an interactive session

Inside a gsd-pi session, run:

```text
/discussion-arena Should we migrate the reporting service from MongoDB to Postgres?
```

The command handler parses the topic (everything up to the flags), resolves
the round count and prints a start notification:

```text
Avvio discussion-arena su: "Should we migrate the reporting service from MongoDB to Postgres?" — 4 partecipanti, 2 round(s) da eseguire (totale sessione: 2).
```

After each round it prints the cumulative transcript, and at the end the
final notification with the transcript:

```text
Discussion arena completata (esito: complete) — analyst, architect, dev, qa — 2 round(s) totali (2 nuovi) — costo cumulato $0.0120.

Session salvata: <cwd>/.gsd/discussion-arena/transcripts/<hash8>-should-we-migrate-the-reporting-service-from-mongo-db-to-pos.md

Transcript finale:

### Round 1 — analyst (Business Analyst)
…
```

You can pass the number of rounds explicitly — it is clamped to the
maximum, so an oversized value is safe:

```text
/discussion-arena Should we migrate the reporting service? 3
```

The default is **2 rounds**, the maximum is **5** (`DEFAULT_ROUNDS`,
`MAX_ROUNDS` in `index.ts`); values above the cap are clamped, values below
1 are ignored and fall back to the default.

## The same round, through the tool (auto mode)

In auto mode the active agent decides when a round is useful and calls the
`discussion_arena` tool itself — the extension registers it in every phase,
so the round works identically:

```text
discussion_arena {
  topic: "Should we migrate the reporting service from MongoDB to Postgres?"
}
```

Two optional parameters change the shape of the round:

| Parameter | Type | Meaning |
| --- | --- | --- |
| `participants` | string[] | Names to involve; unknown names are dropped. Omitted → all discovered participants |
| `rounds` | integer 1–5 | Default 2; clamped to `MAX_ROUNDS` (5) |

The tool returns the transcript as text, prefixed by a deterministic header
(the `## Discussion Arena — …` line), and saves the session file (below).

To make the discussion arena **forced** — the auto orchestrator requires a round before
the plan is decided — configure the `discussion_arena:` section in
`.gsd/PREFERENCES.md`:

```yaml
discussion_arena:
  enabled: true
```

This minimal section is validated against the production parser
(`parseDiscussionArenaBlock`, strict mode) by
`tests/user-guide-snippets.test.ts`, exactly like every other snippet in
this guide. The [Configuration](configuration.md) page documents the full
schema, the three activation tiers and the four parser states.

## What the expected output looks like

The transcript shape is deterministic: every turn is a `### Round N — name
(role)` heading followed by that participant's text. A run of two rounds
with all four bundled participants therefore looks like:

```text
## Discussion Arena — "Should we migrate the reporting service from MongoDB to Postgres?"
Partecipanti: analyst, architect, dev, qa | Round: 2 | Costo totale stimato: $0.0120 | Esito: complete

### Round 1 — analyst (Business Analyst)
[analyst's position on the migration, based on requirements…]

### Round 1 — architect (Software Architect)
[architect's structural trade-offs, reacting to the analyst…]

### Round 1 — dev (Senior Developer)
[dev's feasibility estimate, reacting to both…]

### Round 1 — qa (QA / Reviewer)
[qa's failure modes and verification questions…]

### Round 2 — analyst (Business Analyst)
[analyst's reply, seeing the full round 1…]

### Round 2 — architect (Software Architect)
…

### Round 2 — dev (Senior Developer)
…

### Round 2 — qa (QA / Reviewer)
[…]

Session salvata: <cwd>/.gsd/discussion-arena/transcripts/<hash8>-<slug>.md
```

Two properties of this output are worth knowing before the first run:

- **Rounds are sequential on purpose.** In round 1 each participant sees the
  turns already given by the others in the same round (real dialogue, in
  the order analyst → architect → dev → qa); in round 2 each participant
  sees the entire transcript so far. The prompt for each turn is built by
  `buildRoundPrompt` (`index.ts`): round 1 asks for the initial position,
  later rounds ask to reply to the others.
- **The content is produced by real model calls, the shape is not.** The
  header line, the `### Round N — name (role)` entries and the session path
  are deterministic; the text of each turn depends on the model and can
  differ between runs. If the shape is wrong — no header, no headings, no
  session path — the extension is broken or stale, not the model.

## Where the transcript is saved

Every invocation (command and tool) saves the cumulative transcript to a
session file:

```text
<cwd>/.gsd/discussion-arena/transcripts/<cwd-hash8>-<topic-slug>.md
```

The filename combines a short hash of the working directory and a slug of
the topic (lowercase, alphanumeric plus dashes, max 50 chars). The file is
YAML frontmatter + markdown body:

```markdown
---
topic: Should we migrate the reporting service from MongoDB to Postgres?
participants: analyst, architect, dev, qa
startedAt: <ISO timestamp>
lastUpdatedAt: <ISO timestamp>
rounds: 2
---

### Round 1 — analyst (Business Analyst)
…
```

This is the full transcript — the one shown in the session may be truncated
for the prompt budget, but the file is complete. The session file is what
`--continue` uses to append rounds with continuous numbering (see the
Usage page of this guide).

## What happens under the hood

Each participant turn is an isolated `gsd` subprocess in print mode, with
no session state:

```text
gsd --mode json -p --no-session [--model <participant model>] [--tools <list>] --append-system-prompt <role prompt file> <turn prompt>
```

- The role's system prompt (the markdown body of the participant file) is
  written to a temp file and injected with `--append-system-prompt`.
- `participants.model` from the frontmatter is passed as `--model` (for the
  bundled participants: `<inference provider>`).
- The turn prompt is built by `buildRoundPrompt` and passed as the final
  argument.
- The result of the whole run — transcript, participants used, estimated
  cost, outcome (`complete` when no participant died mid-run, `partial`
  otherwise) — is returned to the calling agent, which stays the
  coordinator: gsd-pi's orchestrator does not know the discussion arena
  exists, it sees a long tool call.

The `[discussion-arena]` diagnostics you may see on stderr (limits per
participant, structured `discussionArena.complete`) are logging only: they
never change the outcome.

## If the first round fails

The two most common first-run failures and their signals:

- **`discussion_arena` is not a registered tool.** The extension did not
  load — re-check the [installation](install.md) and restart gsd-pi.
  Extension load errors appear as `[gsd]` warnings on stderr at session
  start.
- **`Nessun partecipante valido trovato. Disponibili: …`** — no participant
  was discovered in any tier (project, user, bundled). With the extension
  installed this should not happen; it means the bundled `participants/`
  directory is missing or the discovery failed.

## Next steps

- [Configuration](configuration.md) — the `discussion_arena:` schema, the
  three activation tiers and the four parser states, including what happens
  when the section is malformed.
- The Usage page of this guide — `--model` override, `--continue` / `--new`
  session flags and runtime limits.
- [Installing the discussion arena extension](install.md) — user vs project
  scope, post-install verification and removal.

## Related documentation

- [User Guide](index.md) — installation, configuration, usage, troubleshooting
- [README](../../README.md) — overview, quickstart and known limitations
- [Contributor Guide](../contributor-guide/index.md) — adding roles and contributing to the extension
- [Architecture Reference](../architecture/index.md) — how participants are discovered and run
