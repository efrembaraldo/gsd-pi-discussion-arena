**Languages:** [English](project-layout.md) · [Italiano](project-layout.it.md)

[Contributor Guide](index.md) — Project layout

# Project layout

This repository is a gsd-pi extension: it adds a `discussion_arena` tool
that the active agent can invoke from any phase of the auto cycle, plus a
`discussion-arena` command and the auxiliary modules that discovery, session
persistence and the coordination file need. Before you change code, tests or
documentation, know where each surface lives and what the enforcement
scripts expect of it.

## Repository map

```text
gsd-pi-discussion-arena/
├── index.ts                  # extension entry: tool + command, hard limits
├── participants.ts           # discoverParticipants, resolveRoundsDefault
├── run-participant.ts        # runParticipantTurn (single role subprocess)
├── discussion-arena-session.ts  # session file path + save/load
├── trigger-resolver.ts       # when the discussion arena runs
├── helpers.ts                # resolveParticipantLimits, cost/truncation
├── metrics.ts                # counters and histograms
├── replay.ts                 # transcript reconstruction from the event log
├── participants/             # bundled roles: analyst, architect, dev, qa
├── examples/                 # example files validated by production loaders
├── src/                      # coordination loader, CLI, parser, wizard, hooks
├── docs/                     # bilingual documentation (EN + .it.md)
├── tests/                    # node:test suite, fixtures, TS ESM loader
├── scripts/                  # check-links.mjs, setup-types.mjs
├── vendor/pi-coding-agent/   # vendored SDK type declarations
├── package.json / tsconfig.json / extension-manifest.json
└── README.md (+ README.it.md)
```

## Top-level entries

| Path | Purpose |
| --- | --- |
| `index.ts` | Extension entry point. Registers the `discussion_arena` tool and the `discussion-arena` command; holds the hard limits `MAX_PARTICIPANTS` (8), `MAX_ROUNDS` (5), `DEFAULT_ROUNDS` (2) and the round prompt builder |
| `participants.ts` | Participant discovery. `discoverParticipants` collects roles from the five sources (override > virtual > project > user > bundled, D052); `resolveRoundsDefault` implements the 4-level round hierarchy |
| `run-participant.ts` | Runs a single participant turn as a subprocess (`runParticipantTurn`) with the limits resolved by `helpers.ts` |
| `discussion-arena-session.ts` | Session persistence: derives the session file path from `cwd` and topic, saves and loads transcripts |
| `trigger-resolver.ts` | Decides when the discussion arena should run: reads the preferences (`per-milestone`, `always-on`, `availability-only`) and resolves the trigger |
| `helpers.ts` | Shared runtime helpers: `resolveParticipantLimits` merges defaults < frontmatter < overrides, plus cost accumulation, output truncation and failure markers |
| `metrics.ts` | Counters and histograms recorded during runs |
| `replay.ts` | Reconstructs a transcript from the event log and replays a session |
| `participants/` | Bundled participant roles (`analyst`, `architect`, `dev`, `qa`) — tier 4 of the precedence map. Never edit them to customize: override instead |
| `examples/` | Example files validated by the production loaders (participant files, overrides, coordination file, preferences block) |
| `docs/` | Bilingual documentation: contributor guide, user guide, architecture — every page ships as an EN `.md` plus its `.it.md` counterpart |
| `tests/` | The `node:test` suite: test files, shared fixtures, the TS ESM loader |
| `scripts/` | Dev tools: `check-links.mjs` (link checker) and `setup-types.mjs` (vendors the SDK `.d.ts` files into `vendor/`) |
| `vendor/pi-coding-agent/` | Vendored type declarations of the gsd-pi SDK, populated by `npm run setup-types` |

## The `src/` module directory

| File | Purpose |
| --- | --- |
| `discussion-arena-coordination.ts` | Loader of the coordination file: `loadDiscussionArenaCoordination` (never throws, D053 diagnostics on stderr) |
| `parse-discussion-arena-block.ts` | `parseDiscussionArenaBlock`: parses the preferences block written by the wizard |
| `preferences-writer.ts` | `writeDiscussionArenaPreference`: persists preferences atomically |
| `tui-wizard.ts` | `attachDiscussionArenaWizard`: interactive setup wizard |
| `hooks-planning.ts` | `attachDiscussionArenaHooks`: hooks that inject the planning marker |
| `discussion-arena-cli.ts` / `discussion-arena-cli-main.ts` | CLI: participant dump and main entry |
| `log-prefix.ts` | `LOG_PREFIX` = `[discussion-arena]`, the D053 diagnostic surface |
| `markers.ts` | Planning instruction marker |
| `shared-parser.ts` | Re-exports the block parser for compatibility |

## Where things go

- **A new participant role** is a Markdown file with frontmatter; bundled
  examples live in `participants/`, project roles in
  `.gsd/discussion-arena/participants/`. If the role is meant to be
  distributed, add a realistic copy to `examples/participants/` so it is
  covered by `tests/examples-validation.test.ts`.
- **An override example** lives in `examples/participants-overrides/` and
  must point at a base role by `name` (never `skipBundled` in tests).
- **A documentation page** must ship as a bilingual pair: the EN file plus
  the `.it.md` counterpart, with the cross link in the first line of both.
- **A new example file** under `examples/` must load through its production
  loader and be registered in `COVERED_EXAMPLE_FILES` — the guard refuses
  example files without an owner.

## What the link checker enforces

`node scripts/check-links.mjs` walks every `*.md` file from the repository
root (excluding hidden directories, `node_modules/`, `vendor/` and the
deliberation archive) and verifies that every local link resolves to an
existing file:

- inline links (Markdown's square-bracket-plus-parenthesis syntax) and images, plus autolinks with a URI
  scheme or a document extension;
- content inside code fences is **not** inspected;
- a fragment (`#...`) is stripped before resolution; external targets
  (`http:`, `mailto:`, `//host`, `/abs`) and bare anchors are skipped;
- a broken link prints `file:line: target` on stdout and the script exits
  with 1; zero broken links exits 0.

`tests/docs-links.test.ts` extends the same checker over the documentation
corpus with four additional, non-negotiable rules:

1. every document has its `.it.md` variant (and vice versa);
2. the cross link between the two variants is bilateral;
3. no document links the deliberation archive (`docs/discussion-arena-deliberation-archive.md`, D069);
4. the minimal document set (README pair + the six section indexes) stays present.

## The bilingual documentation convention

English is the canonical language; the Italian version is a translation of
the same content, not a separate document. The pair shares the stem
(`project-layout.md` ↔ `project-layout.it.md`), the first line carries the
cross links, and **technical identifiers are never translated**:
`discoverParticipants`, `npm test`, `participants/` and `rounds_default`
stay as they are in both languages. If you add a page, you add both files in
the same change — the suite fails otherwise.

## Related documentation

- [Contributor Guide](index.md) — navigation and conventions
- [Participants](participants.md) — participant files, precedence and overrides
- [Coordination file](coordination-file.md) — defaults, virtual roles, loader warnings
- [Testing](testing.md) — running the suite and adding guards
- [User Guide](../user-guide/index.md) — installing and using the extension
- [Architecture Reference](../architecture/index.md) — how the discussion arena works internally
- [README](../../README.md) — overview, quickstart and known limitations
