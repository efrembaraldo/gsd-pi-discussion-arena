**Languages:** [English](round-orchestration.md) · [Italiano](round-orchestration.it.md)

[Architecture Reference](index.md) — Round orchestration

# Round orchestration

This page documents how the engine composes participant turns into a
discussion: the round loop in `runDiscussionArena` (`index.ts:440`), the
four-level round-count resolution, the prompt budget that keeps the
transcript within argv limits, and the session persistence that makes
`--continue` appends possible. Every symbol, line and value cited here is
verified against the current code by
`tests/architecture-refs.test.ts`, so a renamed function or a moved
declaration makes the suite fail instead of letting this page rot.

The per-turn subprocess mechanics (spawn, event parsing, timers) are on
the *Participant subprocesses* page; the hard limits around them are on
the *Runtime limits* page.

## The round loop (`index.ts:440`)

`runDiscussionArena` (`index.ts:440`) runs `rounds` iterations of the
discussion. Inside each round every selected participant takes one turn,
**sequentially and deliberately** — each participant sees the
interventions the others have already given in the same round (a real
dialogue, not N independent answers). The source comment at
`index.ts:440` notes that a truly simultaneous debate would require
building all the round prompts before executing them and launching with
`Promise.all`; the sequential order is the production behavior.

Round numbering is continuous across continuations: the engine computes
`roundNumber = round + 1 + roundOffset`, where `roundOffset` comes from a
resumed session. The first round of a session uses `buildRoundPrompt`
with `roundIndex === 0`, which asks for an initial position based on the
role only; later rounds receive the cumulative transcript and ask the
participant to respond to the others.

Per-turn failures do not abort the round: a dead participant is skipped
with `[PARTICIPANT SKIPPED: <id>]`, and if **all** selected participants
are dead at the end of a round, the loop breaks early (`allDead`). The
result reports `outcome: "complete" | "partial"` depending on whether any
participant died.

## Round-count resolution: `resolveRoundsDefault` (`participants.ts:585`)

The number of rounds is resolved through a four-level hierarchy, applied
by `resolveRoundsDefault` (`participants.ts:585`):

```text
tool param (1) > participant frontmatter (2, N/A) >
coordination.rounds_default (3) > code DEFAULT_ROUNDS (4)
```

- level 1 — the tool's `rounds` parameter (or the explicit `N` in
  `/discussion-arena <topic> N`);
- level 2 — the participant frontmatter: reserved, `N/A` today (`rounds`
  is a property of the discussion arena, not of a single participant);
- level 3 — `rounds_default` from the coordination file
  `discussion-arena-coordination.md`, read by the walk-up in
  `discoverParticipants`;
- level 4 — the code default `DEFAULT_ROUNDS` (`2`).

`resolveRoundsDefault` is a pure function that never throws: an invalid
value at one level degrades to the next. The clamp to `MAX_ROUNDS` is
deliberately **not** inside it — `participants.ts` cannot import
`MAX_ROUNDS` from `index.ts` without a circular dependency — so the caller
in `index.ts` applies `Math.min(result, MAX_ROUNDS)` as the last wiring
step (see *Runtime limits*, enforcement point 2).

## Prompt budget: `truncateTranscriptForPrompt` (`index.ts:203`)

The transcript grows with every round, and a `--continue` run appends to
it. Feeding the full transcript into the prompt would eventually exceed
the argv limit of `spawn` (typically ~2 MB on Linux, ~256 KB on macOS) and
fail with `E2BIG`. `truncateTranscriptForPrompt` (`index.ts:203`) caps the
prompt copy at `maxBytes: number = 100_000` by default:

```ts
function truncateTranscriptForPrompt(
 transcript: string,
 maxBytes: number = 100_000,
): string {
```

It splits the transcript at round boundaries (the regex
`\n\n(?=### Round \d+)`), keeps the most recent rounds that fit within
`maxBytes`, and prefixes the result with `[...round più vecchi omessi per
limite prompt...]`. If a single round alone is larger than the budget, the
last block is cut with the `[...troncato per limite prompt...]` marker.
This is a prompt-only truncation: the session file on disk always keeps
the full transcript, so nothing is lost for the user.

## Session persistence (`discussion-arena-session.ts`)

The cumulative transcript is persisted per project so that later
invocations of `/discussion-arena "topic" --continue` can append rounds
with continuous numbering (1, 2 → 3, 4 → 5, …). The storage layout:

```text
<cwd>/.gsd/discussion-arena/transcripts/<cwdHash>-<topic-slug>.md
```

- `getSessionFilePath` (`discussion-arena-session.ts:50`) computes the
  path: the literal `"transcripts"` directory under
  `<cwd>/.gsd/discussion-arena/`, with a short SHA-256 hash of the cwd
  (`cwdHashShort`) and a slugified topic (`topicSlug`, max 50 chars) to
  disambiguate topics across projects;
- `loadSession` (`discussion-arena-session.ts:61`) reads and parses an
  existing session, returning `null` if the file is missing or corrupt —
  the caller then starts from scratch;
- `saveSession` (`discussion-arena-session.ts:78`) writes the session,
  creating the directory if needed, as minimal YAML frontmatter (`topic`,
  `participants`, `startedAt`, `lastUpdatedAt`, `rounds`) plus the
  markdown body with the full transcript.

The engine's `--continue` flow loads the session, then passes
`continuation = { transcript, roundOffset: existing.rounds }` to
`runDiscussionArena`: the transcript resumes where it stopped and the new
rounds continue the numbering. Persistence is non-fatal: a failed
`saveSession` produces a warning on stderr, never an error in the run.

## What this page does not cover

- **Per-turn subprocess mechanics** — spawn, event parsing, timers,
  termination: see *Participant subprocesses*.
- **The limits and their enforcement** — `MAX_ROUNDS`, the round clamp and
  the per-turn timers: see *Runtime limits*.
- **How the discussion arena is entered and activated** — invocation flow, trigger
  and planning hooks: see *Invocation flow*, *Trigger resolution* and
  *Planning hooks*.

## Related documentation

- [Architecture Reference](index.md) — index of the internal reference
- [Invocation flow](invocation-flow.md) — where the engine is entered and the round loop is wired
- [Trigger resolution](trigger-resolution.md) — how the discussion arena is activated
- [Planning hooks](hooks.md) — how the tool is exposed during planning
- [Runtime limits](runtime-limits.md) — the limits enforced around each round
- [Participant subprocesses](participant-subprocesses.md) — how a single participant turn is executed
- [User Guide](../user-guide/index.md) — installing and using the extension
- [Contributor Guide](../contributor-guide/index.md) — repository conventions
- [README](../../README.md) — overview, quickstart and known limitations
