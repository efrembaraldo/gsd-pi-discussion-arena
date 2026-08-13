**Languages:** [English](invocation-flow.md) · [Italiano](invocation-flow.it.md)

[Architecture Reference](index.md) — Invocation flow

# Invocation flow

This page traces what happens between a user asking for a discussion and the
returned transcript. There are three entry points — the `discussion_arena`
tool in auto mode, the `/discussion-arena` command in interactive sessions,
and the standalone `--dump-participants` CLI — and they all converge on one
engine: `runDiscussionArena` (`index.ts:440`). Everything on this page is
anchored to the source: every symbol and line cited here is verified against
the current code by `tests/architecture-refs.test.ts`, so a rename or a
move of a function makes the suite fail instead of letting this page rot.

## Entry points

| Entry point | Surface | Where it is wired |
| --- | --- | --- |
| `discussion_arena` tool | auto mode, agent-invoked | `api.registerTool(...)` inside `activate` (`index.ts:947`) |
| `/discussion-arena` command | interactive session | `api.registerCommand("discussion-arena", ...)` inside `activate` |
| `--dump-participants` CLI | standalone process, no gsd-pi runtime | `src/discussion-arena-cli-main.ts` → `dumpParticipantsCli` (`src/discussion-arena-cli.ts:124`) |
| `main(argv, cwd)` | programmatic API, no gsd-pi runtime | exported from `index.ts:101` |

The tool and the command share the same engine; the CLI is a diagnostic
surface that never runs a discussion. The programmatic `main` is the API
counterpart of the CLI entry point: it delegates to the same
`dumpParticipantsCli` but returns the exit code instead of terminating the
process.

## Extension activation: `activate` (`index.ts:903`)

When gsd-pi loads the extension it calls the default export once,
synchronously, at load time:

```ts
export default function activate(api: ExtensionAPI) {
```

Inside `activate` the extension:

1. resolves the trigger decision with `resolveTrigger(...)` — the result
   decides whether the planning hooks force the discussion arena or merely
   expose it (fire-and-forget: a failure writes
   `[discussion-arena] error resolving trigger during activate` on stderr
   and does not block activation);
2. attaches the planning hooks (`attachDiscussionArenaHooks`) with that
   decision;
3. attaches the milestone-start TUI wizard
   (`attachDiscussionArenaWizard`), which writes
   `.gsd/PREFERENCES.md` when the user picks an activation strategy;
4. registers the tool and the command.

The trigger decision and the hooks are covered in their own pages
(*Trigger resolution* and *Hooks*); here the point is that the
registration surface is `activate`, so any new entry point or parameter
starts there.

## Tool registration and the parameter schema (`index.ts:947`, `index.ts:109`)

The tool is registered with:

```ts
api.registerTool({
  name: "discussion_arena",
  label: "Discussion Arena",
  ...
  parameters: DiscussionArenaParamsSchema,
  execute: async (_toolCallId, params, signal, onUpdate, ctx) => { ... },
});
```

The parameter contract is the TypeBox schema, declared just above the hard
limits in the same file:

```ts
const DiscussionArenaParamsSchema = Type.Object({
  topic: Type.String({ ... }),
  participants: Type.Optional(Type.Array(Type.String(), { ... })),
  rounds: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_ROUNDS, ... })),
  ...
});
```

Validation happens before `execute` runs: a call with an out-of-range
`rounds` or a missing `topic` never reaches the engine. The schema embeds
the code constants — the `rounds` maximum is `MAX_ROUNDS` from the same
file — so the schema cannot drift from the limits it documents.

## The tool path in auto mode

One invocation of the tool goes through the `execute` callback in this
order:

1. **Replay short-circuit** — if `params.replay` is set, the tool re-derives
   the transcript from the persisted JSONL event log (`replayDiscussionArena`)
   and returns it without spawning any subprocess. An unknown id produces an
   explicit "no event log found" response.
2. **Round resolution** — `rounds` starts at `DEFAULT_ROUNDS` (level 4 of
   the rounds hierarchy), then the four-level resolution
   (`resolveRoundsDefault`) is applied and the result is clamped with
   `Math.min(parsed, MAX_ROUNDS)` — the clamp is the last step, so a
   coordination default above the cap can never produce more rounds than
   the limit.
3. **Engine call** — `runDiscussionArena` is invoked with the topic, the
   requested participants, the resolved rounds, `ctx.cwd`, the abort signal,
   the progress callback (`onUpdate`), the tool-level limits and the
   `eventLog` flag.
4. **Session persistence** — the returned transcript is saved via
   `getSessionFilePath` / `loadSession` / `saveSession` (covered on the
   *Round orchestration* page); a save failure is non-fatal
   (`[discussion-arena] warning` on stderr).
5. **Response** — a text block with a header line
   (`Partecipanti: ... | Round: ... | Costo totale stimato: ... | Esito: ...`),
   the full transcript, the session path and, when `eventLog` was on, the
   event-log path; `details` carries `participantsUsed`, `totalCost`,
   `rounds`, `outcome` and the `discussionArenaId`.

## The command path

The interactive command is registered in the same `activate` call:

```text
/discussion-arena <topic> [N rounds] [--continue|--new] [--model <id>]
```

The handler parses the line with `parseCommandArgs` (the explicit `N` plays
the role of level 1 of the rounds hierarchy, also clamped), reads the
coordination file for the level-3 default, loads the existing session for
`--continue`, then calls the same `runDiscussionArena` engine. Progress and
the final result are surfaced through `ctx.ui.notify`; without a topic it
prints the usage line together with the discovered participants.

## The shared engine: `runDiscussionArena` (`index.ts:440`)

```ts
export async function runDiscussionArena(
  topic: string,
  requestedNames: string[] | undefined,
  rounds: number,
  cwd: string,
  signal: AbortSignal | undefined,
  onProgress: (partialTranscript: string) => void,
  ...
): Promise<{ transcript: string; participantsUsed: string[]; totalCost: number; outcome: "complete" | "partial"; discussionArenaId?: string }>
```

The engine is the single place where a discussion actually happens:

1. **Discovery** — `discoverParticipants(cwd)` walks the participant tiers
   (project, user, bundled) and loads the coordination file.
2. **Selection** — `selectParticipants` keeps the requested names and caps
   the result at `MAX_PARTICIPANTS`; an empty selection throws an explicit
   error listing the available participants.
3. **Per-participant limits** — `resolveParticipantLimits` is applied once
   per participant (tool > frontmatter > defaults) and logged on stderr.
4. **Round loop** — for each round, every alive participant runs one turn in
   an isolated subprocess (`runParticipantTurn`, covered on the
   *Participant subprocesses* page); the cumulative transcript is assembled
   and passed to the next round so later participants see the earlier
   turns.
5. **Result** — the cumulative transcript, the used participant names, the
   total cost, the outcome (`complete` when no participant died mid-run,
   `partial` otherwise) and, with `eventLog`, the `discussionArenaId`.

A continuation seeds `transcript` and `roundOffset` into the engine, which
is how `--continue` appends rounds with continuous numbering.

## The standalone CLI and `main` (`src/discussion-arena-cli-main.ts`, `src/discussion-arena-cli.ts:124`, `index.ts:101`)

The CLI is deliberately isolated from the gsd-pi runtime. The process entry
point is `src/discussion-arena-cli-main.ts`, whose entire body is:

```ts
import { dumpParticipantsCli } from "./discussion-arena-cli.js";

dumpParticipantsCli(process.argv, process.cwd());
```

`dumpParticipantsCli` (`src/discussion-arena-cli.ts:124`) parses `argv` for
the boolean flag `--dump-participants`: with the flag it writes the
participant dump to stdout (exit code 0) or stderr (exit code 1) and
terminates the process; without the flag it is a no-op returning 0. The
programmatic counterpart `main(argv, cwd)` (`index.ts:101`) is exported from
the extension module and delegates to the same function without the
`process.exit`.

```text
node --import ./tests/ts-esm-loader.mjs src/discussion-arena-cli-main.ts --dump-participants
```

## Failure and partial paths

- **No valid participants** — the engine throws an error whose message lists
  the available roles; the tool catch block turns it into an error text
  response (`Errore nell'esecuzione della discussion-arena: ...`) with
  empty `details`.
- **Trigger resolution failure during activation** — logged on stderr,
  activation continues (see `activate` above).
- **Session save failure** — non-fatal warning on stderr, the run result is
  still returned.
- **Subprocess death / budget exhaustion / timeouts** — handled inside the
  engine and reflected in the outcome and markers; covered on the
  *Participant subprocesses* and *Runtime limits* pages.
- **CLI discovery error** — `dumpParticipantsCli` writes the error to stderr
  and exits 1.

## Related documentation

- [Architecture Reference](index.md) — index of the internal reference (trigger resolution, hooks, participant subprocesses, round orchestration and runtime limits are covered on their own pages)
- [User Guide](../user-guide/index.md) — installing and using the extension
- [Contributor Guide](../contributor-guide/index.md) — repository conventions
- [README](../../README.md) — overview, quickstart and known limitations
