**Languages:** [English](runtime-limits.md) · [Italiano](runtime-limits.it.md)

[Architecture Reference](index.md) — Runtime limits

# Runtime limits

This page documents the limits that bound a discussion-arena run: three
hard constants at the engine level (`index.ts:105-107`), a set of
participant-level limits with their defaults (`helpers.ts:85-91`), and the
enforcement points where each of them actually bites. Everything on this
page is anchored to the source: every symbol, line and value cited here is
verified against the current code by `tests/architecture-refs.test.ts`, so
a renamed constant or a moved function makes the suite fail instead of
letting this page rot.

## The three hard limits (`index.ts:105-107`)

| Constant | Value | What it bounds |
| --- | --- | --- |
| `MAX_PARTICIPANTS` | `8` | number of participants selected in a single run |
| `MAX_ROUNDS` | `5` | number of discussion rounds per run |
| `DEFAULT_ROUNDS` | `2` | round count used when nothing else overrides it |

```ts
export const MAX_PARTICIPANTS = 8;
export const MAX_ROUNDS = 5;
export const DEFAULT_ROUNDS = 2;
```

The suite imports these three values from the real module and asserts the
numbers (8, 5, 2) against `index.ts:105-107`, so the documentation cannot
silently drift from the code.

`MAX_PARTICIPANTS` and `MAX_ROUNDS` are ceilings: the defaults are lower
than the caps, and every entry point converges on the same capped values
(see *Enforcement points* below). `DEFAULT_ROUNDS` is what a run uses when
no explicit round count, command flag or coordination default is present.

## Participant-level limits: `DEFAULT_PARTICIPANT_LIMITS` (`helpers.ts:85-91`)

Each participant turn is additionally bounded by five limits, whose
defaults are a single constant:

```ts
export const DEFAULT_PARTICIPANT_LIMITS: ResolvedLimits = {
  roundTimeoutMs: 300_000,
  eventTimeoutMs: 60_000,
  outputLimitChars: 16_000,
  costBudgetUsd: 1.0,
  termination: "soft",
};
```

| Field | Default | Bounds |
| --- | --- | --- |
| `roundTimeoutMs` | `300_000` (5 min) | absolute cap on one turn, independent of subprocess activity |
| `eventTimeoutMs` | `60_000` (1 min) | no parsed JSON event for this long → subprocess considered hung |
| `outputLimitChars` | `16_000` | a turn's transcript text is truncated beyond this length |
| `costBudgetUsd` | `1.0` | cumulative cost per participant that trips the budget guard |
| `termination` | `"soft"` | how a timed-out subprocess is killed |

## Resolution chain: tool > frontmatter > defaults (`index.ts:363`, `helpers.ts:313`)

For every selected participant the engine resolves the effective limits
once with `resolveParticipantLimitsForParticipant` (`index.ts:363`), which
wires the tool-level params and the participant's frontmatter into
`resolveParticipantLimits` (`helpers.ts:313`):

```text
toolParams (highest) > participant.limits frontmatter > DEFAULT_PARTICIPANT_LIMITS
```

Each numeric field is picked along that chain with per-field rules:

- `roundTimeoutMs`, `eventTimeoutMs` — minimum 1 ms, not clamped: an
  invalid or below-minimum value falls back to the next level;
- `outputLimitChars` — minimum 1, clamped to 1;
- `costBudgetUsd` — minimum 0, clamped to 0 (a budget of 0 means "no
  budget" for zero-cost turns, see the budget guard);
- `termination` — only `"soft"` or `"hard"` are accepted; anything else
  falls back to the next level.

Invalid values never throw: they fall back to the lower level (or to the
default) and produce a warning on stderr.

## Enforcement point 1 — schema validation (`index.ts:124`)

The tool's TypeBox schema embeds the engine constants, so a call that
violates a hard limit never reaches the engine:

```ts
rounds: Type.Optional(
  Type.Integer({
    minimum: 1,
    maximum: MAX_ROUNDS,
  }),
),
```

`maximum: MAX_ROUNDS` is the same constant as the declaration, not a
copy — if `MAX_ROUNDS` changes, the schema follows. The tool-level limit
params (`roundTimeoutMs`, `eventTimeoutMs`, `outputLimitChars`,
`costBudgetUsd`, `termination`) are optional in the schema: omitting them
just drops the merge to the frontmatter or the defaults.

## Enforcement point 2 — the round clamp (`index.ts:307-318`)

The clamp is applied as the *last* step of round resolution, at two call
sites:

- `parseCommandArgs` clamps an explicit round count:
  `rounds = Math.min(parsed, MAX_ROUNDS)` (`index.ts:307` and
  `index.ts:318`);
- the tool path clamps after the four-level hierarchy
  (`resolveRoundsDefault`):
  `rounds = Math.min(resolveRoundsDefault(params.rounds, coordination.roundsDefault, DEFAULT_ROUNDS), MAX_ROUNDS)`.

The clamp is deliberately outside `resolveRoundsDefault`: that function
lives in `participants.ts`, which cannot import `MAX_ROUNDS` from
`index.ts` without a circular dependency (comment at `index.ts:975-977`).
Consequence: a coordination `roundsDefault` above the cap can never
produce more than `MAX_ROUNDS` rounds.

## Enforcement point 3 — the participant cap (`index.ts:348-349`)

`selectParticipants` keeps the requested names in request order and, when
more than `MAX_PARTICIPANTS` survive, truncates:

```ts
selected = selected.slice(0, MAX_PARTICIPANTS);
```

`selected.slice(0, MAX_PARTICIPANTS)` is the last step of the selection:
the first `MAX_PARTICIPANTS` in the resolved order win, the rest are
dropped without error.

## Enforcement point 4 — per-turn timers and termination (`run-participant.ts:131`, `run-participant.ts:57`)

`runParticipantTurn` (`run-participant.ts:131`) protects each turn with
two independent timers and one termination mode, resolved from the
participant's `ResolvedLimits`:

- **round_timeout** (`roundTimeoutMs`) — absolute cap on the whole turn,
  independent of subprocess activity;
- **event_watchdog** (`eventTimeoutMs`) — if no parsed JSON line arrives
  within the threshold, the subprocess is considered hung (polling every
  `max(25 ms, eventTimeoutMs / 4)`, capped at 500 ms);
- **termination** — `"soft"` = SIGTERM, then a grace period of
  `SOFT_TERMINATION_GRACE_MS = 5_000` ms, then SIGKILL; `"hard"` =
  immediate SIGKILL.

```ts
const SOFT_TERMINATION_GRACE_MS = 5_000;
```

A timeout does **not** throw: it produces a `ParticipantTurnResult` with
`failureKind` = `"timeout_round"` | `"timeout_event"` and a
`failureReason`, while `durationMs` records spawn-to-close. The consumer
marks the participant dead and emits the canonical marker (see below).

## Enforcement point 5 — output truncation (`helpers.ts:150`)

After a turn, if `turn.text.length > limits.outputLimitChars`, the engine
applies `truncateOutput` (`helpers.ts:150`) and the transcript entry ends
with `[OUTPUT TRUNCATED at N chars]`. Truncation is **not** a crash: the
turn stays complete, the participant is not marked dead, and `outcome` is
unaffected. If `outputLimitChars` is smaller than the marker itself, the
truncation is skipped with a warning on stderr (the config is unusable for
truncation and the text passes through intact).

## Enforcement point 6 — the budget guard

Costs accumulate per participant and are updated *before* the guard runs
(`costByParticipant`). After truncation, if `participantCost > 0 &&
participantCost >= limits.costBudgetUsd`, the turn ends with the canonical
marker `[BUDGET EXHAUSTED: <id> at round <N> <ts>]`, the participant is
marked dead (`"budget_exhausted"`) and later rounds skip it with
`[PARTICIPANT SKIPPED: <id>]` — the run then reports
`outcome: "partial"`. Three details are pinned:

- the turn that crosses the budget pays its own cost;
- the condition is `cost > 0 && cost >= limit`, so at `costBudgetUsd: 0`
  a zero-cost turn does not trip the guard;
- the order is fixed: truncation first (over-limit stays a success),
  budget guard second (over-budget is a distinct failure).

## Failure kinds and markers (`helpers.ts:203`)

All limit outcomes surface in the transcript as markers produced by the
pure helper `formatFailureMarker` (`helpers.ts:203`):

| `FailureKind` | Marker |
| --- | --- |
| `failed` | `[PARTICIPANT FAILED: <id> <reason> <ts>]` |
| `skipped` | `[PARTICIPANT SKIPPED: <id>]` |
| `timeout_round` | `[TIMEOUT: <id> round_timeout <ts>]` |
| `timeout_event` | `[TIMEOUT: <id> event_watchdog <ts>]` |
| `budget_exhausted` | `[BUDGET EXHAUSTED: <id> at round <N> <ts>]` |
| `output_truncated` | `[OUTPUT TRUNCATED at N chars]` |

An unrecognized kind throws an explicit `Error` from
`formatFailureMarker` — there is no silent fallback, so a new failure kind
cannot go unnoticed by the transcript format.

## What these limits do not cover

- **No global cost cap** — `costBudgetUsd` is per participant; there is no
  ceiling on the sum across participants.
- **No whole-run wall clock** — the timers bound individual turns, not the
  overall run.
- **Transcript byte budget** — `truncateTranscriptForPrompt` caps the
  prompt at `maxBytes: number = 100_000`; the round hierarchy
  (`resolveRoundsDefault`, four levels) is treated on the *Round
  orchestration* page.
- **Subprocess mechanics** — spawn, event parsing and crash classification
  are treated on the *Participant subprocesses* page.

## Related documentation

- [Architecture Reference](index.md) — index of the internal reference
- [Invocation flow](invocation-flow.md) — where the limits are wired into the tool and the engine
- [Trigger resolution](trigger-resolution.md) — how the discussion arena is activated
- [Planning hooks](hooks.md) — how the tool is exposed during planning
- [User Guide](../user-guide/index.md) — installing and using the extension
- [Contributor Guide](../contributor-guide/index.md) — repository conventions
- [README](../../README.md) — overview, quickstart and known limitations
