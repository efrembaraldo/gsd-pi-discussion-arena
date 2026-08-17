**Languages:** [English](trigger-resolution.md) · [Italiano](trigger-resolution.it.md)

[Architecture Reference](index.md) — Trigger resolution

# Trigger resolution

`resolveTrigger` (`trigger-resolver.ts:178`) is the pure function that
decides whether the discussion arena is *forced* into the planning session
or merely *available*. It implements a three-tier fallback — environment
variable, then `PREFERENCES.md`, then a safe default — and, by contract,
**never throws**: every path through the function returns a decision, and
malformed input surfaces as `warnings` and `parseErrors` instead of an
exception. Everything on this page is anchored to the source: every symbol
and line cited here is verified against the current code by
`tests/architecture-refs.test.ts`, so a rename or a move of a function makes
the suite fail instead of letting this page rot.

## The decision contract: `ResolveTriggerOutput` (`trigger-resolver.ts:62`)

```ts
export interface ResolveTriggerOutput {
 decision: "forced" | "available-only";
 source: "env" | "coordination" | "preferences" | "fallback";
 warnings: string[];
 parseErrors: string[];
 // v2 (S01/M010): runtime context propagated from the caller.
 tier: "F" | "A" | "D";                       // default "A" when caller doesn't classify
 capabilities: ReadonlySet<CapabilityName>;    // default ∅ when caller doesn't classify
 groupEligibility: string | null;             // null when unitType not provided
}
```

The decision is binary and the source explains where it came from. The three
tiers below map onto exactly three combinations:

| Tier | Trigger | `decision` | `source` |
| --- | --- | --- | --- |
| 1 | `GSD_DISCUSSION_ARENA_AUTO === "1"` in the environment | `forced` | `env` |
| 2 | `PREFERENCES.md` enables the discussion arena for this milestone or globally | `forced` | `preferences` |
| 3 | fallback, when tiers 1–2 did not force anything | `available-only` | `fallback` |

`warnings` collects soft problems (an unreadable preferences file, an
unexpected error while reading it); `parseErrors` collects malformed lines
found while parsing the `discussion_arena:` block. Neither array is ever
thrown: callers that want visibility read them, callers that do not ignore
them safely.

## Tier 1 — the environment variable

The environment check is a strict equality on the raw string
(`trigger-resolver.ts:204`):

```ts
if (input.env.GSD_DISCUSSION_ARENA_AUTO === "1") {
```

Only the exact string `"1"` forces the discussion arena. Anything else — `"0"`, an
empty string, an unset variable — falls through to tier 3: the extension
never tries to interpret `"0"` as a negative override, and never treats any
other value as an enablement. The env object is passed explicitly in the
`input` (`{ cwd, milestoneId, env }`), which is what makes the function
pure and unit-testable without touching the real process environment.

## Tier 2 — `PREFERENCES.md`

If the environment did not force anything, `parsePreferences`
(`trigger-resolver.ts:108`) reads `.gsd/PREFERENCES.md` under `cwd`,
extracts the `discussion_arena:` block, and evaluates two enablement
levels, in this order:

1. **Milestone-specific** — `discussion_arena.milestones.<milestoneId>.enabled === true`;
2. **Global** — `discussion_arena.enabled === true`.

The first hit wins: a milestone entry takes precedence over the global flag,
and an explicit `enabled: false` for a milestone *suppresses* the global
default for that milestone. A file that is missing, has no
`discussion_arena:` section, or only contains negative entries produces no
force and falls through to tier 3. The `mode` field that the TUI wizard
writes (`per-milestone` / `always-on` / `availability-only`) is carried by
the block but is **not** consulted by the resolver: the decision is driven
exclusively by `enabled` flags.

The preferences file is the same one that `attachDiscussionArenaWizard`
writes when the user picks an activation strategy at milestone start (see
the [Invocation flow](invocation-flow.md) page) — the resolver is the read
side of that write.

## Tier 3 — the fallback

When neither the environment nor the preferences forced the discussion arena, the
resolver returns `{ decision: "available-only", source: "fallback" }`. The
discussion arena tool remains registered and callable, but the planning
hooks will not inject the instruction and will not surface the tool as
forced. This is the *safe* default: auto-mode never blocks on a missing or
broken preferences file.

## The shared parser: `parseDiscussionArenaBlock` (`src/parse-discussion-arena-block.ts:103`)

Parsing the `discussion_arena:` block is delegated to the shared parser in
`src/`, not to a parser owned by the trigger module. The block shape is:
2-space sub-keys, 4-space milestone IDs, 6-space milestone keys, and
milestone IDs match the permissive `[A-Za-z0-9_.-]+` form — the same form
the TUI wizard writes, so IDs containing `_` or `.` make a round-trip
through `resolveTrigger` instead of being silently ignored (the historical
drift between the two pre-refactor parsers on exactly this regex is the
reason the shared parser exists).

The trigger consumes it in the default `strict: false` mode, so unknown keys
and malformed indentation are skipped silently — identical semantics to the
pre-refactor parsers. The strict mode (which throws
`DiscussionArenaParseError`) exists for the override-file validation path in
S02 and is not used by the trigger. The import goes through
`src/shared-parser.ts`, the lexical-neutral re-export point that keeps
`trigger-resolver.ts` decoupled from the `src/` module layout (D004: zero
dependencies, plain line manipulation, no YAML package).

## Errors and observability

The never-throw contract has two visible sides:

- **Missing preferences file** — `ENOENT` is swallowed and treated as
  "no configuration": the resolver falls through to tier 3 without a
  warning. This is what keeps the extension usable in a repository that
  never wrote a `.gsd/PREFERENCES.md`.
- **Anything else** — unexpected read errors are collected in `warnings`;
  malformed lines are collected in `parseErrors`. Neither stops the
  resolution.

For callers that want a log line, `resolveTriggerWithLogging`
(`trigger-resolver.ts:326`) wraps the pure function and writes to stderr
with the structured prefix `LOG_PREFIX` (`src/log-prefix.ts:12`), whose
value is the literal `[discussion-arena]`:

```text
[discussion-arena] trigger resolved: decision=forced source=env
```

## Where the decision is consumed

`activate` (`index.ts:903`) calls `resolveTrigger` during extension load
(`index.ts:918`) as a fire-and-forget: the result is passed to
`attachDiscussionArenaHooks` on success, and on failure a message is written
to stderr (`[discussion-arena] error resolving trigger during activate: ...`
at `index.ts:931`) without blocking activation. The milestone id used for
the tier-2 lookup comes from `process.env.GSD_MILESTONE_ID`, falling back
to the literal `"unknown"`. How the decision drives the planning hooks —
instruction injection and tool-set exposure — is covered on the
[*Hooks*](hooks.md) page.

## Related documentation

- [Architecture Reference](index.md) — index of the internal reference
- [Invocation flow](invocation-flow.md) — activation, registration and the entry points that lead into the engine
- [Hooks](hooks.md) — what the `forced` decision does once it reaches the planning session
- [User Guide](../user-guide/index.md) — installing and using the extension
- [Contributor Guide](../contributor-guide/index.md) — repository conventions
- [README](../../README.md) — overview, quickstart and known limitations
