**Languages:** [English](runtime-tier-matrix.md) · [Italiano](runtime-tier-matrix.it.md)

[Architecture Reference](index.md) — Runtime tier matrix

# Runtime tier matrix

`classifyRuntime` (`src/runtime-classifier.ts:161`) is the deterministic
two-axis classifier that decides whether the discussion arena is allowed
to **force** its tool into a planning session or only sits in
**availability-only** mode. This page is the canonical reference for the
matrix an operator consults when asking "for this `Phase` and this group
of unit-types, what does the runtime actually do?". Everything below is
anchored to the source: every symbol and line cited here is verified
against the current code by `tests/architecture-refs.test.ts`, so a
rename or a move makes the suite fail instead of letting this page rot.

The matrix is the projection of two pure modules onto a single grid:

- `src/runtime-classifier.ts` exports `classifyRuntime`, `parseSemver`,
  the union `RuntimeTier` (`src/runtime-classifier.ts:54`), the union
  `CapabilityName` (`src/runtime-classifier.ts:61`), and freezes the
  `PROBE_HOOKS` tuple (`src/runtime-classifier.ts:89`) that drives the
  probe sequence.
- `src/phase-mapping.ts` exports the union `Phase`
  (`src/phase-mapping.ts:23`), the frozen record `ACTIVE_UNIT_TYPES`
  (`src/phase-mapping.ts:61`), the frozen record `PHASE_TO_UNIT_TYPES`
  (`src/phase-mapping.ts:126`), and the two lookup helpers
  `phaseToUnitTypes` (`src/phase-mapping.ts:151`) and
  `unitTypeToArenaGroup` (`src/phase-mapping.ts:160`).

Both modules are pure (D085): no I/O, no stderr, no observable side
effect at import time. The Tier D stderr/ledger side effects live in the
caller (`index.ts:activate()`); the modules themselves only return data.

## Two-axis model

The classifier is built around **two independent axes**, codified as
decision D081. The decision tree in `classifyRuntime` is small enough
that the entire grid below is a direct projection:

- **Axis 1 — fingerprint** — does `parseSemver(process.env.GSD_VERSION)`
  return a `ParsedSemver`? This is the version fingerprint that the
  loader (`gsd-pi/src/loader.ts:141-142`) sets on every run. A missing or
  malformed value sends the runtime to Tier D with reason `no_GSD_VERSION`
  before any probe runs.
- **Axis 2 — capability probes** — do the three critical hooks
  (`before_agent_start`, `adjust_tool_set`, `unit_start`) accept a noop
  registration on `api.on(...)`? The probes are wrapped in `safeProbe`,
  so a stub that throws becomes `false` rather than a propagated error.

`parseSemver` (`src/runtime-classifier.ts:109`) is intentionally tolerant:
`v1.15.0`, `1.15.0-dev.69075e6e` (the real gsd-pi fingerprint shape),
and `1.15` (without patch, `patch === null`) all parse. Anything else
returns `null`, which forces Tier D regardless of probe results.

The capabilities vector is the **frozen** `ReadonlySet<CapabilityName>`
returned alongside the tier; the calling code (the planning hooks, the
trigger resolver) reads it instead of re-probing the API. `tool_call` is
probed but is **not** part of the tier decision — it is only carried in
`capabilities` for observability and downstream gating. The exact probe
order is the iteration order of `PROBE_HOOKS`, which is frozen at the
top of `src/runtime-classifier.ts`.

## Tier F — full forcing

Tier F is the happy path: the runtime is operating against a real
gsd-pi instance whose API exposes every hook the extension relies on,
and the version fingerprint parses cleanly.

| Property | Value |
| --- | --- |
| Fingerprint (axis 1) | `parseSemver(process.env.GSD_VERSION)` returns a `ParsedSemver` |
| Critical hooks (axis 2) | `before_agent_start`, `adjust_tool_set`, `unit_start` all return `true` from `safeProbe` |
| `reasons` returned by `classifyRuntime` | `[]` (empty) |
| `capabilities` returned | a frozen `Set` containing all four entries of `PROBE_HOOKS` |
| Behavior of the planning hooks | joint condition holds for every active `(Phase, group)` cell: the discussion arena tool is **forced**, instruction is injected |
| Caller side effects (`index.ts:activate()`) | none beyond the normal `attachDiscussionArenaHooks` invocation |

Tier F is the only tier where every cell of the matrix in the next
section is meaningful: the runtime is honest about every capability it
advertises, so the discussion arena can be trusted to intervene without
suppressing other tools.

## Tier A — availability-only (no `unit_start`)

Tier A is the operational norm on gsd-pi **today**: the two synchronous
hooks (`before_agent_start`, `adjust_tool_set`) accept a noop, the
version fingerprint parses, but `unit_start` does not. The research
note that backs this up is in M010-RESEARCH.md §3: `emitUnitStart` has
no call-site in `gsd-pi/dist`, so even though the runtime advertises the
hook, the call never fires.

| Property | Value |
| --- | --- |
| Fingerprint (axis 1) | `parseSemver(process.env.GSD_VERSION)` returns a `ParsedSemver` |
| Critical hooks (axis 2) | `before_agent_start` and `adjust_tool_set` accept; `unit_start` rejects (or throws in `safeProbe`) |
| `reasons` returned by `classifyRuntime` | `["no_unit_start"]` |
| `capabilities` returned | a frozen `Set` containing only the two synchronous hooks of `PROBE_HOOKS` |
| Behavior of the planning hooks | the discussion arena is **availability-only**: the tool is callable, but it is not surfaced as forced in the planning session |
| Caller side effects (`index.ts:activate()`) | `recordDegraded({ reason: "no_unit_start" })` once; no stderr one-shot |

The label `A` for "Available" is deliberately chosen to distinguish it
from the F (Full) tier and the D (Degraded) tier: Tier A is **not** a
failure mode, it is the operational reality of the current gsd-pi, and
the runtime continues to drive every other mechanism (capability probe,
phase tracking, planning instruction injection on supported hooks)
normally.

## Tier D — degraded (everything else)

Tier D is the catch-all: any reason that disqualifies the runtime from F
or A lands here. The classifier accumulates reasons cumulatively, so a
single run can produce multiple entries; the caller (`index.ts:activate()`)
emits a one-shot stderr line **and** calls `recordDegraded` for each.

| Property | Value |
| --- | --- |
| Fingerprint (axis 1) | either missing (`process.env.GSD_VERSION` unset) or malformed (`parseSemver` returns `null`) — reason `no_GSD_VERSION` is appended |
| Critical hooks (axis 2) | at least one of `before_agent_start` / `adjust_tool_set` rejects; if both accept but `unit_start` rejects, the classifier still falls through to D only because the F branch above was not satisfied (the F→A transition is gated on both synchronous hooks being accepted) |
| `reasons` returned by `classifyRuntime` | `["no_GSD_VERSION"]` and/or `["no_before_agent_start"]`, `["no_adjust_tool_set"]`, `["no_unit_start"]`, in the order they are detected |
| `capabilities` returned | a frozen `Set` containing exactly the hooks that accepted; can be empty |
| Behavior of the planning hooks | the discussion arena is fully bypassed; no tool is added; no instruction is injected |
| Caller side effects (`index.ts:activate()`) | one structured stderr line per reason, one `recordDegraded({ reason, ... })` per reason, deduplicated |

`runtime-classifier.ts` itself never writes to stderr and never calls
`recordDegraded`: it is a pure function returning a structured result.
This is what lets the test suite exercise every combination without
mocking the global `console.error` or `recordDegraded` counters.

## 18-phase × 6-group matrix

The matrix below is the projection of `PHASE_TO_UNIT_TYPES` onto the
six groups of `ACTIVE_UNIT_TYPES`. There are exactly **18 phases** in
the `Phase` union (`src/phase-mapping.ts:23`) and exactly **6 groups**
in `ACTIVE_UNIT_TYPES` (`src/phase-mapping.ts:61`); the bijective
mapping is what produces the six "force" cells.

Cell semantics:

- `force` — `phaseToUnitTypes(phase)` returns a frozen `Set` containing
  this group's key, so for any `unitType` that belongs to this group
  the planning hooks run the joint condition `currentPhase === phase &&
  resolveTrigger.decision === "forced"` and **force** the discussion
  arena into the session.
- `availability-only` — `phaseToUnitTypes(phase)` returns either the
  empty shared set `EMPTY_UNIT_TYPES` or a frozen `Set` belonging to a
  *different* group: the discussion arena is reachable as a callable
  tool but is not surfaced as forced for any `unitType` of this group
  in this phase.
- `n/a` — the phase is not one of the six "active" phases of
  `PHASE_TO_UNIT_TYPES`; `phaseToUnitTypes(phase)` returns the empty
  shared set and no `unitType` of this group ever runs through the
  discussion arena while the session sits in this phase.

| `Phase` ↓ / Group → | `research-decision` | `research` | `discussing` | `planning` | `executing` | `verifying` |
| --- | --- | --- | --- | --- | --- | --- |
| `pre-planning` | n/a | n/a | n/a | n/a | n/a | n/a |
| `needs-discussion` | n/a | n/a | n/a | n/a | n/a | n/a |
| `discussing` | availability-only | availability-only | **force** | availability-only | availability-only | availability-only |
| `researching` | **force** | availability-only | availability-only | availability-only | availability-only | availability-only |
| `planning` | availability-only | availability-only | availability-only | **force** | availability-only | availability-only |
| `refining` | availability-only | **force** | availability-only | availability-only | availability-only | availability-only |
| `evaluating-gates` | n/a | n/a | n/a | n/a | n/a | n/a |
| `executing` | availability-only | availability-only | availability-only | availability-only | **force** | availability-only |
| `verifying` | availability-only | availability-only | availability-only | availability-only | availability-only | **force** |
| `summarizing` | n/a | n/a | n/a | n/a | n/a | n/a |
| `advancing` | n/a | n/a | n/a | n/a | n/a | n/a |
| `validating-milestone` | n/a | n/a | n/a | n/a | n/a | n/a |
| `completing-milestone` | n/a | n/a | n/a | n/a | n/a | n/a |
| `replanning-slice` | n/a | n/a | n/a | n/a | n/a | n/a |
| `escalating-task` | n/a | n/a | n/a | n/a | n/a | n/a |
| `complete` | n/a | n/a | n/a | n/a | n/a | n/a |
| `paused` | n/a | n/a | n/a | n/a | n/a | n/a |
| `blocked` | n/a | n/a | n/a | n/a | n/a | n/a |

There are exactly **six "force" cells** — one per active phase — and
**12 "n/a" rows** for the inactive phases (`pre-planning`,
`needs-discussion`, `evaluating-gates`, `summarizing`, `advancing`,
`validating-milestone`, `completing-milestone`, `replanning-slice`,
`escalating-task`, `complete`, `paused`, `blocked`). All 12 phases map
to the shared empty set `EMPTY_UNIT_TYPES`, which is why the row is
entirely `n/a` rather than a mixture of `availability-only` and
`n/a`.

The 30 `availability-only` cells (5 per active phase × 6 active phases)
are the cells where the discussion arena **could** intervene if the
session happened to land in the right combination of `unitType` and
group, but the bijective design of `PHASE_TO_UNIT_TYPES` makes that
impossible by construction.

## 20 unit-type → group mapping

Below is the table the runtime uses when the session actually arrives
at a unit-type. `unitTypeToArenaGroup` (`src/phase-mapping.ts:160`) walks
`Object.entries(ACTIVE_UNIT_TYPES)` and returns the **key** of the
group whose frozen `Set` contains the unit-type, or `null` if the
unit-type is not in any of the six groups.

The table lists **20 active memberships** (`activeMemberships === 20` in
the combinatorics test `tests/property-phase-mapping.test.ts`):

| Group | `unitType` (key returned by `unitTypeToArenaGroup`) |
| --- | --- |
| `research-decision` | `research-decision` |
| `research` | `research-milestone` |
| `research` | `research-project` |
| `research` | `research-slice` |
| `discussing` | `discuss-milestone` |
| `discussing` | `discuss-project` |
| `discussing` | `discuss-requirements` |
| `planning` | `plan-milestone` |
| `planning` | `plan-slice` |
| `planning` | `refine-slice` |
| `planning` | `replan-slice` |
| `planning` | `replan-task` |
| `planning` | `gate-evaluate` |
| `executing` | `execute-task` |
| `executing` | `reactive-execute` |
| `executing` | `run-uat` |
| `executing` | `reassess-roadmap` |
| `verifying` | `validate-milestone` |
| `verifying` | `complete-milestone` |
| `verifying` | `complete-slice` |

`unitTypeToArenaGroup` is total over the string type: every possible
input returns either a key of `ACTIVE_UNIT_TYPES` or `null`. The
helper is invoked from `trigger-resolver.ts` (see the *Trigger
resolution* page) to populate `ResolveTriggerOutput.groupEligibility`,
which the planning hooks read before deciding whether to surface the
tool as forced.

## By-design exclusions

The `ACTIVE_UNIT_TYPES` record partitions exactly **24** `primary`
unit-types of gsd-pi (per D102). Of those 24, **20** are mapped to a
group and **4** are intentionally excluded:

| Excluded `unitType` | Reason |
| --- | --- |
| `quick-task` | operational variant; the prompt deliberativo would slow it down without adding structure |
| `rewrite-docs` | documentation rewrite; the discussion arena is not the right artefact producer for this surface |
| `triage-captures` | inbox-triage variant; the deliverable is a set of decisions, not a plan |
| `workflow-preferences` | user-preferences variant; it should not be gated behind any deliberation |

For these four unit-types, `unitTypeToArenaGroup` returns `null` (the
input is not in any frozen `Set`), the planning hooks see
`groupEligibility === null`, and the joint condition
`currentPhase === phase && resolveTrigger.decision === "forced"`
short-circuits without forcing the discussion arena into the session.
The tool itself remains registered and callable: a `quick-task`
operator who wants the discussion arena can still invoke it explicitly.

The combinatorics invariant
(`tests/property-phase-mapping.test.ts`) enforces `activeMemberships ===
20` (not 24) and the disjointness of the partition; renaming any of
the four excluded unit-types or adding a fifth exclusion is therefore a
**breaking change** for that test, which is the desired safety floor.

## How it works in practice

Three worked examples — one per tier — show how the matrix collapses
into a runtime decision. Each example starts from a fresh
`process.env.GSD_VERSION` and a fresh `ExtensionAPI` stub.

### Tier F — full forcing in the planning phase

`process.env.GSD_VERSION` is `"v1.15.0-dev.69075e6e"`; the runtime API
exposes all three critical hooks. `parseSemver` returns
`{ major: 1, minor: 15, patch: 0 }`; `safeProbe` returns `true` for
each entry of `PROBE_HOOKS`. The classifier returns:

```text
{ tier: "F", capabilities: {before_agent_start, adjust_tool_set, unit_start, tool_call}, reasons: [] }
```

When the session enters the `planning` phase with `unitType =
"plan-milestone"`, the planning hook reads `groupEligibility =
"planning"` from `unitTypeToArenaGroup`, the trigger decision is
`forced`, and the joint condition holds: the discussion arena tool is
added to the active tool set and the planning instruction is injected.

### Tier A — availability-only in the discussing phase

`process.env.GSD_VERSION` is `"1.15.0-dev.69075e6e"`; the runtime API
exposes `before_agent_start` and `adjust_tool_set` but **not**
`unit_start`. `parseSemver` returns the same `ParsedSemver`; the two
synchronous probes return `true`; the `unit_start` probe returns
`false` (or throws). The classifier returns:

```text
{ tier: "A", capabilities: {before_agent_start, adjust_tool_set}, reasons: ["no_unit_start"] }
```

When the session enters the `discussing` phase with `unitType =
"discuss-milestone"`, the joint condition `currentPhase === "planning"
&& resolveTrigger.decision === "forced"` evaluates to `false` (the
phase is not `planning`). The discussion arena stays available as a
callable tool but is not surfaced as forced, and the call site invokes
it explicitly rather than via the forced-injection path.

### Tier D — degraded because the fingerprint is missing

`process.env.GSD_VERSION` is unset; the runtime API exposes only
`tool_call`. `parseSemver` returns `null`; only the `tool_call` probe
returns `true`. The classifier returns:

```text
{ tier: "D", capabilities: {tool_call}, reasons: ["no_GSD_VERSION"] }
```

The caller (`index.ts:activate()`) emits a structured stderr line
prefixed with `[discussion-arena]` and calls `recordDegraded({ reason:
"no_GSD_VERSION", ... })` once. The planning hooks are not attached:
no tool is added, no instruction is injected. The discussion arena
tool itself may still be registered (that decision is taken by the
trigger resolver, not by the classifier), but no unit-type of any
group is forced through it for this run.

## Why this is pure

Both `classifyRuntime` and the `phase-mapping` helpers are pure
functions over their inputs. The classifier reads
`process.env.GSD_VERSION` directly (the only ambient dependency), but
it never writes anything back: no `console.error`, no `recordDegraded`,
no I/O. `phaseToUnitTypes` and `unitTypeToArenaGroup` are pure
lookups over frozen records. This is what lets the suite exercise
every combination without an `ExtensionAPI` real implementation, and
what lets the matrix above be reasoned about as a static projection.

The caller in `index.ts:activate()` is responsible for the side
effects: it consumes the `reasons` array, deduplicates the
`recordDegraded` calls, and writes the structured stderr line once per
session. Splitting "decide" from "report" is what keeps
`runtime-classifier.ts` under fifty logical lines and `phase-mapping.ts`
under one hundred, and what keeps this page under two hundred lines
without losing fidelity.

## Related documentation

- [Architecture Reference](index.md) — index of the internal reference
- [Trigger resolution](trigger-resolution.md) — how `forced` / `available-only` is decided from `groupEligibility` and the tier
- [Planning hooks](hooks.md) — the joint condition `currentPhase === "planning" && resolveTrigger.decision === "forced"`
- [Runtime limits](runtime-limits.md) — the ceilings that apply to every tier (round count, transcript length, participant panel)
- [Invocation flow](invocation-flow.md) — when `classifyRuntime` is called during `activate`
- [Participant subprocesses](participant-subprocesses.md) — how the discussion arena is launched once the tier is known
- [Round orchestration](round-orchestration.md) — how the rounds and the Scribe transcript are assembled
- [Research-decision flow](research-decision-flow.md) — the canonical pipeline that consumes Tier F / A / D output
