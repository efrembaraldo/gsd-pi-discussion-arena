**Languages:** [English](participant-subprocesses.md) · [Italiano](participant-subprocesses.it.md)

[Architecture Reference](index.md) — Participant subprocesses

# Participant subprocesses

This page documents how the discussion arena executes a single participant
turn: the discovery of who is available, the spawn of an isolated `gsd`
subprocess in JSON/print mode, the event parsing on stdout and the
post-processing that turns the raw turn into the transcript entry. Every
symbol, line and value cited here is verified against the current code by
`tests/architecture-refs.test.ts`, so a renamed function or a moved
declaration makes the suite fail instead of letting this page rot.

The per-turn limits themselves (timers, termination mode, truncation
threshold, budget) are documented on the *Runtime limits* page; this page
focuses on the process mechanics around them.

## Discovery: `discoverParticipants` (`participants.ts:438`)

Before any turn runs, the engine resolves the participant roster with
`discoverParticipants` (`participants.ts:438`), which loads every role
definition from five sources, merged by name with a fixed precedence
(highest wins):

```text
override > virtual > project > user > bundled
```

- **override** — `.gsd/discussion-arena/participants-overrides/*.md`,
  walk-up towards the git root; a file `<role>.md` replaces the matching
  base entirely. An override without a base is an orphan and makes
  `discoverParticipants` throw a blocking error — no silent fallback;
- **virtual** — roles defined in the coordination file
  `discussion-arena-coordination.md` (`roles_virtuals`); first-class
  participants without any file in `participants/`;
- **project** — `.gsd/discussion-arena/participants/*.md`, walk-up towards
  the git root;
- **user** — `~/.gsd/agent/discussion-arena/participants/*.md`;
- **bundled** — `participants/*.md` next to the installed module.

The coordination file also supplies `roundsDefault` (level 3 of the round
hierarchy, see *Round orchestration*) and `modelDefault`, which is applied
to every participant that does not declare an explicit `model`.

## Spawn of the turn subprocess: `runParticipantTurn` (`run-participant.ts:131`)

Each turn is executed by `runParticipantTurn` (`run-participant.ts:131`),
which spawns a single `gsd` subprocess in isolated print/JSON mode with a
blank session context:

```ts
const args: string[] = ["--mode", "json", "-p", "--no-session"];
```

`["--mode", "json", "-p", "--no-session"]` (`run-participant.ts:139`) is the
base argument vector. The resolved model and the participant's tool
allowlist are appended when present:

- `--model <id>` — the effective model (`modelOverride ?? participant.model`);
- `--tools <comma-separated list>` — the participant's tool subset;
- `--append-system-prompt <tempfile>` — the role's system prompt is written
  to a temporary file first (`writePromptToTempFile`) to avoid argv length
  limits, then appended;
- finally, the turn prompt itself (topic + cumulative transcript built by
  `buildRoundPrompt`) is passed as the trailing argument.

The subprocess is spawned with `shell: false`, `cwd` inherited from the
engine and `stdio: ["ignore", "pipe", "pipe"]` — stdin is closed, stdout
carries the JSON event stream, stderr is captured for diagnostics.

## Event parsing on stdout

The subprocess emits one JSON event per line on stdout. The turn runner
buffers the stream, splits on newlines and parses each complete line;
malformed lines are ignored (they are not a failure):

- any parsed JSON line re-arms the event watchdog (`lastEventAt`), so any
  activity counts as liveness;
- a `message_end` event with `message.role === "assistant"` increments
  `usage.turns`, accumulates `usage.{input,output,cost}` (defensively
  coerced to numbers, since some providers emit strings) and collects the
  text parts as the assistant's answer;
- the accumulated stderr is kept in `result.stderr` for post-mortem
  diagnosis.

## Turn lifecycle, timers and termination

The whole turn is guarded by an `AbortController` that merges three abort
sources — the external gsd-pi cancel signal, the round timeout and the
event watchdog. The first abort wins (`abortReason` is checked before each
abort); the termination mode resolved from the participant's limits decides
how the subprocess is killed:

- `"soft"` — SIGTERM, then a grace period, then SIGKILL;
- `"hard"` — immediate SIGKILL.

A timeout does **not** throw: `runParticipantTurn` returns a
`ParticipantTurnResult` with `failureKind` = `"timeout_round"` |
`"timeout_event"` and a human-readable `failureReason`, while `durationMs`
records spawn-to-close. A subprocess killed by an external fatal signal or
exiting with a non-zero code — with no timeout or external abort having
acted — is classified as `failureKind: "failed"` with a reason of
`"crash <signal>"` or `"crash exit=<code>"`. Branch order matters: a
timeout that escalated to SIGKILL stays a timeout, never a crash.

## Post-processing: cost, truncation and limits

After a successful turn the engine applies three pure helpers from
`helpers.ts`, all anchored here:

- `accumulateCost` (`helpers.ts:132`) — extracts a cost from `usage`
  (accepting `usage.cost` as number, string or `{total}`, clamping to >= 0)
  and sums it into the running total;
- `truncateOutput` (`helpers.ts:150`) — if the turn text exceeds
  `limits.outputLimitChars`, truncates it and appends the marker
  `[OUTPUT TRUNCATED at N chars]`; truncation is not a crash. A limit
  smaller than the marker itself throws `RangeError` (invalid config);
- `resolveParticipantLimits` (`helpers.ts:313`) — merges the three levels
  `toolParams > frontmatter > defaults` with runtime validation per field;
  invalid values fall back to the lower level with a warning on stderr and
  never throw.

The engine wires the participant's frontmatter and the tool params into
`resolveParticipantLimits` once per participant before the round loop via
`resolveParticipantLimitsForParticipant` (`index.ts:363`), so every turn of
a run uses stable, pre-resolved limits.

## What this page does not cover

- **Per-turn limits and their enforcement points** — timers, termination
  grace, truncation threshold and budget guard: see *Runtime limits*.
- **The round loop and the transcript** — how turns compose into rounds,
  prompt truncation and session persistence: see *Round orchestration*.
- **When the discussion arena runs** — activation trigger and planning hooks: see
  *Trigger resolution* and *Planning hooks*.

## Related documentation

- [Architecture Reference](index.md) — index of the internal reference
- [Invocation flow](invocation-flow.md) — where the engine is entered and the turn runner is wired
- [Trigger resolution](trigger-resolution.md) — how the discussion arena is activated
- [Planning hooks](hooks.md) — how the tool is exposed during planning
- [Runtime limits](runtime-limits.md) — the limits enforced around each turn
- [Round orchestration](round-orchestration.md) — the round loop and session persistence
- [User Guide](../user-guide/index.md) — installing and using the extension
- [Contributor Guide](../contributor-guide/index.md) — repository conventions
- [README](../../README.md) — overview, quickstart and known limitations
