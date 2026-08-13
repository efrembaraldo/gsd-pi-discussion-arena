**Languages:** [English](hooks.md) · [Italiano](hooks.it.md)

[Architecture Reference](index.md) — Planning hooks

# Planning hooks

`attachDiscussionArenaHooks` (`src/hooks-planning.ts:34`) is the single
registration point that turns the trigger decision (see the
[*Trigger resolution*](trigger-resolution.md) page) into runtime behavior:
it registers three gsd-pi lifecycle hooks — `unit_start`,
`adjust_tool_set` and `before_agent_start` — on the extension API. All
three share one closure that tracks the current phase, and the two that
mutate the session act under one joint condition: `currentPhase ===
"planning"` **and** `resolveTrigger.decision === "forced"`. When that
condition does not hold, the hooks return nothing and change nothing.
Everything on this page is anchored to the source: every symbol and line
cited here is verified against the current code by
`tests/architecture-refs.test.ts`, so a rename or a move of a function
makes the suite fail instead of letting this page rot.

## Registration contract (`src/hooks-planning.ts:34`)

The attach function receives the API, a context and the already-resolved
trigger output, and registers the hooks in a fixed order:

```ts
export function attachDiscussionArenaHooks(
 api: ExtensionAPI,
 ctx: ExtensionContext,
 resolveTrigger: ResolveTriggerOutput,
): void
```

The `ResolveTriggerOutput` type is imported from `trigger-resolver.ts` —
the same decision contract documented on the *Trigger resolution* page —
and `PLANNING_INSTRUCTION_MARKER` is imported from `./markers.js`
(`src/markers.ts:17`). The closure variable `currentPhase` starts as the
literal `"unknown"` (`src/hooks-planning.ts:40`) and is updated by the
first hook; the second and third hooks read it.

## Hook 1 — `unit_start`: phase tracking

```ts
api.on("unit_start", (event) => { ... });
```

When a unit starts, the hook reads `event.unitType` and maps it onto the
phase the other hooks react to:

| `event.unitType` | `currentPhase` becomes |
| --- | --- |
| `planning` | `planning` |
| `execution` | `execution` |
| `verifying` | `verifying` |
| `closeout` | `closeout` |
| anything else | `unknown` |

This hook never mutates anything but the closure: its only job is to keep
`currentPhase` in sync with the session so the two mutating hooks know
whether they are inside a planning unit.

## Hook 2 — `adjust_tool_set`: tool exposure

```ts
api.on("adjust_tool_set", (event) => { ... });
```

The hook runs the joint condition `currentPhase === "planning" &&
resolveTrigger.decision === "forced"`. Only when both hold does it:

1. copy `event.activeToolNames` into a new array;
2. append `discussion_arena` if the name is not already present;
3. return `{ toolNames }` so the runtime applies the updated set.

Three properties are worth noting:

- **Additive only** — the hook never removes a tool, so exposing the
  discussion arena can never take another tool away from the agent.
- **Idempotent** — if `discussion_arena` is already in the active set, the
  returned set is identical to the input.
- **Non-interfering** — in every other phase, and when the decision is
  `available-only`, the hook returns nothing, so the tool set passes
  through unchanged. The tool remains callable in those cases, it is
  simply not *forced* into the set.

## Hook 3 — `before_agent_start`: instruction injection

```ts
api.on("before_agent_start", (event) => { ... });
```

Under the same joint condition, the hook appends an idempotent planning
instruction to the agent's system prompt. The appended block is built from
two constants:

```ts
const marker = `\n\n${PLANNING_INSTRUCTION_MARKER}\n${DISCUSSION_ARENA_INSTRUCTION}`;
```

- `PLANNING_INSTRUCTION_MARKER` (`src/markers.ts:17`) is the literal
  `<!-- gsd-pi-discussion-arena-planning-instruction -->` — an HTML
  comment that anchors the injected text;
- `DISCUSSION_ARENA_INSTRUCTION` is the Italian instruction
  "Usa discussion_arena prima di decidere il piano".

The injection is guarded by the marker: if
`event.systemPrompt.includes(PLANNING_INSTRUCTION_MARKER)` is already true,
the hook returns nothing. This is what makes the injection **idempotent
across turns**: the system prompt evolves between units, but the marker
never appears twice, so a planning unit that runs after a previous planning
unit does not accumulate duplicate instructions.

## When the hooks do nothing

Both mutating hooks are gated on the joint condition. In every other
combination — `available-only` with any phase, or any non-planning phase
with `forced` — the session passes through unmodified:

- no tool is added to the active set;
- no instruction is appended to the system prompt;
- no hook returns a value.

This is the *availability* contract of the trigger: `available-only` means
the tool exists and can be called, not that the agent is told to use it.
The `unit_start` hook still runs and tracks the phase regardless, because
the phase bookkeeping is always useful.

## The marker as a runtime contract

`PLANNING_INSTRUCTION_MARKER` is deliberately a stable literal rather than
a generated value: `tests/hooks-planning.test.ts` asserts the idempotence
behavior of the hooks (a second `before_agent_start` after a first one does
not duplicate the instruction), and the marker is the string those
assertions rely on. Renaming the marker silently would make the guard
stop matching — the test catches that, because a fresh injection would be
appended to a prompt that already carries the old marker.

## Related documentation

- [Architecture Reference](index.md) — index of the internal reference
- [Trigger resolution](trigger-resolution.md) — how the `forced` / `available-only` decision is produced
- [Invocation flow](invocation-flow.md) — how the hooks are attached during `activate`
- [User Guide](../user-guide/index.md) — installing and using the extension
- [Contributor Guide](../contributor-guide/index.md) — repository conventions
- [README](../../README.md) — overview, quickstart and known limitations
