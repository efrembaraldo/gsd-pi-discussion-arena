**Languages:** [English](troubleshooting.md) · [Italiano](troubleshooting.it.md)

[User Guide](index.md) — Troubleshooting

# Troubleshooting the discussion arena

This page documents what the discussion arena actually does when
configuration goes wrong, and what it does **not** do. Every claim below is
anchored to production code, and every snippet in this guide — valid and
deliberately malformed — is passed to the production parser
`parseDiscussionArenaBlock` in `strict:true` by
`tests/user-guide-snippets.test.ts`. If a documented error message does not
match what the parser raises, the suite fails naming the page and the
offending key.

## At a glance

| Symptom | Likely cause | Where to look |
| --- | --- | --- |
| The trigger never forces a round in the `planning` phase | The decision for the current milestone is `available-only` | [Check the three tiers](#the-trigger-does-nothing--check-the-three-tiers) |
| A line of the `discussion_arena:` section seems ignored | Malformed line in lenient mode, skipped silently | [Silently ignored section](#a-malformed-section-is-silently-ignored-lenient-mode) |
| You get an error naming a key and an indent | `strict:true` validation rejected the first offending line | [The `DiscussionArenaParseError`](#the-strict-mode-error-discussionarenaparseerror) |
| The command stops before a round with an error message | Fatal configuration problem (orphan override, no participants) | [Fatal configuration errors](#fatal-configuration-errors) |
| `--continue` starts a new session | No session file exists for that topic | [Sessions, replay and transcripts](#sessions-replay-and-transcripts) |
| A participant's reply is missing or truncated | Timeout, budget, or output limit | [Sessions, replay and transcripts](#sessions-replay-and-transcripts) |

## The trigger "does nothing" — check the three tiers

The trigger decision is a pure function (`resolveTrigger`): it never throws
and always returns one of two decisions, `forced` or `available-only`. When
the discussion arena is not forced, the tool stays registered but nothing is
injected into the prompt. Check the three tiers in order:

1. **Environment variable.** Only the exact string `GSD_DISCUSSION_ARENA_AUTO=1`
   forces. `0`, unset, or any other value does not.
2. **`<cwd>/.gsd/PREFERENCES.md` for the *current* milestone.** The decision
   is `forced` when `milestones.<MID>.enabled: true` for the current milestone,
   or when the global `enabled: true` is set. A section that enables only
   *another* milestone does not force the current one.
3. **Fallback.** If neither applies, the decision is `available-only`.

Remember that forcing only has an effect in the `planning` phase: outside
that phase, even a `forced` decision leaves the tool registered but never
injects anything.

There is **no command and no log** to query the decision: production calls
`resolveTrigger` without logging the outcome, so do not search stderr for a
trigger line — read the configuration instead and walk the tiers above.

## A malformed section is silently ignored (lenient mode)

The trigger parses the `discussion_arena:` section in `strict:false`
(lenient), exactly like the two legacy parsers. An offending line is skipped
**in silence** — no warning, no error — and the remaining well-formed lines
are honored. Parse errors are collected but never checked: the decision is
never blocked by a parse problem. This is intentional, for backwards
compatibility.

Consequence: if you edit the section by hand and the trigger "does nothing",
do not look for a warning in the logs — none is ever emitted for a lenient
skip. Compare your section against the schema table in
[Configuration](configuration.md) instead. The four parser states
(missing file, missing section, valid section, malformed section) and their
trigger outcomes are documented there in full.

## The strict-mode error: `DiscussionArenaParseError`

`strict:true` is the validation mode used to prove that a `discussion_arena:`
block is well-formed: the snippet harness of this guide runs every snippet
through the production parser in `strict:true`, and the writer validates
override files with the same entry point. The runtime never uses
`strict:true` — it is lenient only — but the error below is exactly what you
get when a block is rejected.

In `strict:true`, the **first** offending line raises
`DiscussionArenaParseError` carrying three fields: `key` (the offending key),
`indent` (its indentation level) and `line` (the raw line). The message has
this shape:

```
unknown key "<key>" at indent <indent> in discussion_arena block (line: <line>)
```

Snippet 1 — an unknown key, deliberately malformed:

```yaml-invalid
discussion_arena:
  enabled: true
  bogus_key: 1
```

Validated in `strict:true`, this raises exactly:

```
DiscussionArenaParseError: unknown key "bogus_key" at indent 2 in discussion_arena block (line: bogus_key: 1)
```

`bogus_key` is not part of the schema (the valid keys are `enabled`, `mode`
and `milestones` at indent 2). Fix: remove the line, or check the spelling
against the schema table in [Configuration](configuration.md).

Snippet 2 — a valid key at the wrong indentation, deliberately malformed:

```yaml-invalid
discussion_arena:
  enabled: true
    enabled: true
```

Validated in `strict:true`, this raises exactly:

```
DiscussionArenaParseError: unknown key "enabled" at indent 4 in discussion_arena block (line: enabled: true)
```

`enabled` is only valid at indent 2 (global flag) or at indent 6 (inside
`milestones.<MID>`). At indent 4 the parser expects a milestone ID line
(`M001:` and similar) *inside* the `milestones:` section; outside that
section a 4-space line is out of schema. Fix: put the flag at indent 2, or
move it under a milestone entry at indent 6.

The same section, corrected — this is the valid shape and it passes
`strict:true`:

```yaml
discussion_arena:
  enabled: true
  mode: per-milestone
  milestones:
    M001:
      enabled: true
```

## The `[discussion-arena]` warning prefix

Warnings that are actually emitted use the `[discussion-arena]` prefix on
stderr. The following surfaces are real and documented:

- **Coordination file** (`<cwd>/.gsd/discussion-arena/discussion-arena-coordination.md`):
  invalid `rounds_default` produces
  `[discussion-arena] rounds_default must be a positive integer (got <value>) — using code defaults`;
  an unparsable file produces
  `[discussion-arena] coordination parse error: <reason> — using code defaults`;
  an incomplete virtual role produces
  `[discussion-arena] virtual role '<key>' missing required field <field> — skipped`.
  In every case the code falls back to its defaults and keeps going.
- **Participant overrides** (`participants/`): `[discussion-arena] override applied: <role> from <path>` on success; `[discussion-arena] override skipped: incomplete (<role> from <path>)` and `[discussion-arena] using default for '<role>' (override skipped: incomplete)` when the override file is incomplete.
- **Runtime warnings**: `[discussion-arena] warning: impossibile salvare sessione in <path>: <err>` (session persistence failed, non-fatal), `[discussion-arena] warning: outputLimitChars=<n> < marker length, troncatura saltata per <name>` (invalid output limit, truncation skipped), `[discussion-arena] warning: appendEvent fallito: <err>` (event log failure, fail-safe), and `[discussion-arena] error resolving trigger during activate: <msg>` (startup problem, non-blocking).
- **Wizard without a TUI**: when `hasUI === false` (CI, print mode), the milestone wizard emits a `[discussion-arena]` diagnostic on stderr and returns without ever blocking the pipeline.

The prefix does **not** appear in two cases that users often search for:
the trigger decision (not logged in production) and lenient parse skips
(silent by design). If you are looking for a warning about a malformed
`discussion_arena:` section, there is none to find.

## Fatal configuration errors

Two configuration problems **stop** the command with an error, instead of
being downgraded to a warning:

- **Orphan override**: an override file in `participants/` whose target has
  no base role file. The command throws:
  `override target '<role>' not found in participants/ — create participants/<role>.md or remove the override file`.
  Fix: create the base role file, or remove the override.
- **No valid participants**: the command throws with the available list:
  `Nessun partecipante valido trovato. Disponibili: <list>.` Fix: define at
  least one role in `participants/` whose id matches the requested set.

Everything else is caught at the tool boundary: the command returns
`Errore nell'esecuzione della discussion-arena: <message>` as a tool reply
and never crashes the session — check stderr for the `[discussion-arena]`
prefix to see the underlying problem.

## Sessions, replay and transcripts

- **`--continue` without a session.** If no session file exists for the
  topic, the command notifies `Nessuna sessione esistente per "<topic>" — avvio da zero.`
  and starts from round 1. This is an informational notice, not an error.
  Sessions live in `<cwd>/.gsd/discussion-arena/transcripts/<cwdHash>-<topic-slug>.md`
  and are plain markdown with a small YAML frontmatter.
- **Replay with an unknown id.** The command replies
  `Nessun event log trovato per la discussion-arena <id> — verifica che la run originale sia stata eseguita con eventLog: true (log in <cwd>/.gsd/discussion-arena/events/).`
  Event logs live in `<cwd>/.gsd/discussion-arena/events/`.
- **Session save failure.** A failed save emits the
  `[discussion-arena] warning: impossibile salvare sessione` warning and the
  round output is still returned — persistence is never allowed to kill the
  round.
- **Very long transcripts.** For a single prompt the transcript is truncated
  to 100 000 bytes, keeping the most recent rounds, with the markers
  `[...round più vecchi omessi per limite prompt...]` or
  `[...troncato per limite prompt...]`. The session file on disk keeps the
  full transcript — check the file, not the prompt, for the complete record.
- **Participant failure markers.** Failures are recorded in the transcript
  with bracketed markers: `[PARTICIPANT FAILED: <id> <reason> <ts>]`,
  `[TIMEOUT: <id> round_timeout <ts>]` (or `event_watchdog`),
  `[BUDGET EXHAUSTED: <id> at round <N>]`, `[PARTICIPANT SKIPPED: <id>]`, and
  `[OUTPUT TRUNCATED at <N> chars]` for an over-limit reply (the reply still
  counts as delivered). The outcome of a round with failures is `partial`.

## Related documentation

- [User Guide](index.md) — all pages of this guide
- [Configuration](configuration.md) — the schema and the four parser states
- [Usage](usage.md) — command flags and session flags
- [README](../../README.md) — overview, quickstart and known limitations
