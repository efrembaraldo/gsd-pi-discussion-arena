**Languages:** [English](usage.md) · [Italiano](usage.it.md)

[User Guide](index.md) — Usage

# Using the discussion arena

The discussion arena has two entry points: the `/discussion-arena` command
for interactive sessions and the `discussion_arena` tool for auto mode. They
share the same engine (`runDiscussionArena` in `index.ts`) but differ in how
you pass parameters: the command parses a compact command line, the tool
receives structured parameters validated against the TypeBox schema
(`DiscussionArenaParamsSchema` in `index.ts`). Everything on this page is
anchored to that schema and to the command handler, not to a description of
them: if a parameter name, a default or a cap differs here, the schema or
the handler changed and this page is stale.

The [Quickstart](quickstart.md) page shows the minimum path to a first
round; this page covers the full parameter surface, the command flags,
session persistence (`--continue` / `--new`) and the runtime limits that
bound a run.

## The command: `/discussion-arena`

The command syntax, parsed by `parseCommandArgs` (`index.ts`), is:

```text
/discussion-arena <topic> [N rounds] [--continue|--new] [--model <id>]
```

- `<topic>` is everything before the flags; it may contain spaces.
- `N rounds` is an optional trailing integer — the last numeric token not
  consumed by `--model`. Values below 1 are ignored (the default applies);
  values above the cap are clamped to the maximum.
- `--continue` / `-c` resumes the existing session for the topic (see
  [Sessions](#sessions)).
- `--new` starts a fresh session, even if `--continue` is present.
- `--model <id>` / `-m <id>` overrides the model for **every** turn of this
  session, whatever each participant's frontmatter says.

The default round count comes from the project's coordination file
(`coordination.rounds_default`, level 3 of the rounds hierarchy below) or
falls back to the code default of 2 (`DEFAULT_ROUNDS`). Without a topic the
command prints the usage line together with the discovered participants.

Examples:

```text
/discussion-arena Should we migrate the reporting service? 3
/discussion-arena Should we migrate the reporting service? --continue
/discussion-arena Should we migrate the reporting service? -c -m gpt-4o
/discussion-arena Should we migrate the reporting service? --new
```

## The tool: `discussion_arena` parameters

In auto mode the tool is called with structured parameters. The full set is
defined by `DiscussionArenaParamsSchema` (TypeBox, `index.ts`) — this table
is the schema's perimeter, read from the schema itself:

| Parameter | Type | Default | Meaning |
| --- | --- | --- | --- |
| `topic` | string | — (required) | The theme or question the participants discuss or deliberate on |
| `participants` | string[] | all discovered | Names to involve; must match a participant file in one of the three tiers. Unknown names are dropped; omitted → all discovered participants, capped at `MAX_PARTICIPANTS` (8) |
| `rounds` | integer | 2 | Number of rounds, 1–5. Clamped to `MAX_ROUNDS` (5); see the rounds hierarchy below |
| `contTopic` | string | — | Declared in the schema as the path of an existing session file to continue from (`--continue`). The current command implementation derives the session path automatically from the working directory and the topic (`getSessionFilePath`), so this parameter is not consumed yet |
| `model` | string | — | Declared in the schema as the model that overrides `participant.model` for all turns. Consumed on the command surface via `--model` / `-m` |
| `roundTimeoutMs` | number | 300 000 | Max time (ms) for a participant to complete a round. Overrides the participant's `round_timeout_ms` frontmatter and the default; enforced as a hard timeout (see [Runtime limits](#runtime-limits)) |
| `eventTimeoutMs` | number | 60 000 | Max time (ms) between one event and the next (watchdog) during a participant turn. Overrides `event_timeout_ms`; enforced as a hard timeout |
| `outputLimitChars` | number | 16 000 | Max characters of a participant's output before truncation. Overrides `output_limit_chars`; over-limit output is truncated with a marker, not discarded as a failure |
| `costBudgetUsd` | number | 1.00 | Max USD budget for a participant's turns. Overrides `cost_budget_usd`; once the participant reaches it, the turn ends with a budget-exhausted marker and the participant is dropped |
| `termination` | "soft" \| "hard" | "soft" | What happens when a threshold is exceeded: `soft` = controlled degradation (SIGTERM, then SIGKILL after a grace period), `hard` = immediate SIGKILL |
| `eventLog` | boolean | false | Persist the JSONL event log (see [Event log and replay](#event-log-and-replay)) |
| `replay` | string | — | Re-derive the transcript of a previous `eventLog: true` run from its persisted log, without running any subprocess (see [Event log and replay](#event-log-and-replay)) |

The five limit parameters (`roundTimeoutMs`, `eventTimeoutMs`,
`outputLimitChars`, `costBudgetUsd`, `termination`) form the top level of a
three-level merge applied per participant: **tool parameter > participant
frontmatter > built-in default** (`resolveParticipantLimits` in
`helpers.ts`). The frontmatter keys are the snake_case forms
(`round_timeout_ms`, `event_timeout_ms`, `output_limit_chars`,
`cost_budget_usd`, `termination`); a missing level falls through to the next.

### The rounds hierarchy

`rounds` is resolved in four levels (`resolveRoundsDefault`,
`participants.ts`, wiring in `index.ts`):

1. tool parameter `rounds`;
2. participant frontmatter — not applicable: rounds are a property of the
   discussion arena, not of a single participant;
3. `coordination.rounds_default` from the project coordination file
   (`.gsd/discussion-arena/discussion-arena-coordination.md`, walk-up);
4. code default `DEFAULT_ROUNDS` (2).

The result is clamped to `MAX_ROUNDS` (5) as the last step, so a
`rounds_default` above the cap can never produce more than 5 rounds. The
command applies the same hierarchy — its explicit `N` plays the role of
level 1, clamped in `parseCommandArgs`.

## Sessions

Every invocation — command and tool — saves the cumulative transcript to a
session file:

```text
<cwd>/.gsd/discussion-arena/transcripts/<cwd-hash8>-<topic-slug>.md
```

The filename combines an 8-hex SHA-256 hash of the working directory and a
slug of the topic (lowercase, alphanumeric plus dashes, max 50 chars;
`untitled` if empty). The file is YAML frontmatter plus the full markdown
transcript — never truncated on disk:

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

The [Quickstart](quickstart.md) page shows the same file in context. What
matters here is what the discussion arena does with it across invocations.

### `--continue`: appending rounds to an existing session

With `--continue` the command loads the session file for the topic:

```text
/discussion-arena Should we migrate the reporting service? --continue
```

The existing transcript is seeded into the run and the rounds are appended
with **continuous numbering**: after a 2-round session, `--continue` with
2 more rounds runs round 3 and round 4 (the round number is
`round + 1 + roundOffset`, where `roundOffset` is the previous session's
round count). The start notification makes the totals explicit:

```text
Avvio discussion-arena su: "Should we migrate the reporting service?" — 4 partecipanti, 2 round(s) da eseguire (totale sessione: 4).
```

and the final notification reports both numbers:

```text
Discussion arena completata (esito: complete) — analyst, architect, dev, qa — 4 round(s) totali (2 nuovi) — costo cumulato $0.0120.

Session salvata: <cwd>/.gsd/discussion-arena/transcripts/<hash8>-should-we-migrate-the-reporting-service.md

Transcript finale:

### Round 3 — analyst (Business Analyst)
…
```

The session file is saved with `rounds` set to the total and the original
`startedAt` preserved; `lastUpdatedAt` is refreshed. If `--continue` finds
no session for the topic, the command says so and starts from scratch:

```text
Nessuna sessione esistente per "Should we migrate the reporting service?" — avvio da zero.
```

### `--new`: forcing a fresh session

`--new` makes the command ignore any existing session even when
`--continue` is present on the same line (`explicitNew` bypasses
`continueSession`). The run starts from an empty transcript and the session
file is overwritten. Use it when you want a clean slate for a topic that
already has a session.

### The tool path

The tool always runs fresh (it has no continuation flag yet) but it does
read the existing session file to preserve `startedAt`, so repeated tool
calls on the same topic keep the original start date and overwrite the
transcript body. Session-save failures on the tool path are non-fatal: the
run result is returned and a `[discussion-arena] warning` is printed on
stderr.

## Runtime limits

The run-time envelope, all enforced in code:

| Limit | Value | Where |
| --- | --- | --- |
| `MAX_ROUNDS` | 5 | rounds are clamped to this; a larger request never runs more |
| `MAX_PARTICIPANTS` | 8 | the participant selection is truncated to this (`selectParticipants`) |
| `DEFAULT_ROUNDS` | 2 | code fallback when no parameter and no coordination default apply |
| round timeout | 300 000 ms | a participant turn that exceeds it is killed (see below) |
| event watchdog | 60 000 ms | no JSON progress line within this time kills the turn |
| output limit | 16 000 chars | over-limit output is truncated with `[OUTPUT TRUNCATED at N chars]` |
| cost budget | $1.00 | reaching it drops the participant with `[BUDGET EXHAUSTED: <id> at round <N> <ts>]` |
| termination | `soft` | soft = SIGTERM + 5 s grace + SIGKILL; `hard` = immediate SIGKILL |

The default values come from `DEFAULT_PARTICIPANT_LIMITS` (`helpers.ts`);
each of them can be overridden per participant (frontmatter) or per call
(tool parameters), as described in the parameter table above.

What actually happens when a guardrail trips (S04–S06 in
`run-participant.ts` and `index.ts`):

- **round timeout / event watchdog** — the turn is aborted (the first
  abort wins between the two timers and an external cancel) and the
  participant is marked dead with the canonical marker
  `[TIMEOUT: <id> round_timeout|event_watchdog <ts>]`; in later rounds the
  participant is skipped (`[PARTICIPANT SKIPPED: <id>]`).
- **output over the limit** — the output is truncated with
  `[OUTPUT TRUNCATED at N chars]`; this is *not* a failure: the turn is
  kept and the participant stays alive.
- **budget exhausted** — the turn ends with
  `[BUDGET EXHAUSTED: <id> at round <N> <ts>]` and the participant is
  dropped.
- **hard termination** — on abort, SIGKILL is sent immediately (not
  interceptable); `soft` sends SIGTERM first and escalates to SIGKILL if
  the process does not exit within the grace period.

If **all** selected participants are dead at the end of a round, the run
stops early (`allDead` break in `runDiscussionArena`). The outcome is
`complete` when no participant died mid-run, `partial` otherwise; both are
reported in the header line and in the final notification.

### Transcript truncation for the prompt

The transcript passed to each turn's prompt is truncated to 100 000 bytes,
keeping the most recent rounds (`truncateTranscriptForPrompt` in
`index.ts`; default `maxBytes = 100_000`), with a marker line when older
rounds are omitted. This exists to avoid `spawn E2BIG` when `--continue`
has accumulated many rounds — the argv limit is roughly 2 MB on Linux and
256 KB on macOS. The **session file on disk always contains the full
transcript**, so truncation is purely a prompt-size concern.

## Event log and replay

With `eventLog: true` the run persists an append-only JSONL event log:

```text
<cwd>/.gsd/discussion-arena/events/<discussionArenaId>.jsonl
```

The `discussionArenaId` is returned in the tool `details`, and the response
text points to the log:

```text
## Discussion Arena — "Should we migrate the reporting service?"
Partecipanti: analyst, architect, dev, qa | Round: 2 | Costo totale stimato: $0.0120 | Esito: complete

…

Session salvata: <cwd>/.gsd/discussion-arena/transcripts/<hash8>-should-we-migrate-the-reporting-service.md

Event log (replay): <cwd>/.gsd/discussion-arena/events/<discussionArenaId>.jsonl — rileggi con discussion_arena { replay: "<discussionArenaId>" }
```

With `replay: "<discussionArenaId>"` the tool re-derives the transcript
from the persisted event log **without running any subprocess** (pure
reconstruction over the recorded events) and returns it with the event
count. An unknown id produces an explicit, actionable response instead of
silence:

```text
Nessun event log trovato per la discussion-arena <discussionArenaId> — verifica che la run originale sia stata eseguita con eventLog: true (log in <cwd>/.gsd/discussion-arena/events/).
```

## Diagnostics

The discussion arena writes `[discussion-arena]` lines to stderr: the resolved limits
per participant, the structured `discussionArena.complete` log and
non-fatal warnings (e.g. a session save failure on the tool path). They are
logging only — they never change the outcome of a run. If you see a
`[discussion-arena] warning` about limits, it means a frontmatter or
parameter value was invalid and the code fell back to the default for that
level (see the parameter table).

## Related documentation

- [User Guide](index.md) — installation, configuration, quickstart, troubleshooting
- [Quickstart](quickstart.md) — the minimum path to a first round
- [Configuration](configuration.md) — the `discussion_arena:` schema in `.gsd/PREFERENCES.md`
- The Troubleshooting page of this guide — malformed configuration, parser warnings and deterministic fallbacks
- [README](../../README.md) — overview, quickstart and known limitations
- [Architecture Reference](../architecture/index.md) — how participants are discovered and run
