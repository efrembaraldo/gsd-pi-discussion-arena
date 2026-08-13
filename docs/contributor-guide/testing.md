**Languages:** [English](testing.md) · [Italiano](testing.it.md)

[Contributor Guide](index.md) — Testing

# Testing

The repository uses Node's built-in test runner (`node:test`) and imports
TypeScript source through a tiny ESM resolve hook — no bundler, no Jest, no
extra dependencies (D004). This page explains how to run the suite, what
each group of files guards, and how to add a test without breaking the
enforcement contract.

## Running the suite

```bash
npm test                                 # full suite (node:test discovery)
npm run typecheck                        # tsc --noEmit over production sources
node scripts/check-links.mjs             # zero broken local markdown links
node --import ./tests/ts-esm-loader.mjs --test tests/<file>.test.ts   # single file
```

| Command | What it does |
| --- | --- |
| `npm test` | Runs `node --import ./tests/ts-esm-loader.mjs --test`: `node:test` discovers every `*.test.ts` under `tests/` and executes it |
| `npm run typecheck` | Runs `scripts/setup-types.mjs` first (it vendors the SDK `.d.ts` files), then `tsc --noEmit --pretty false` over the production sources |
| `node scripts/check-links.mjs` | Verifies every local markdown link in the repository resolves; exit 0 means clean, a broken link prints `file:line: target` and exits 1 |
| `node --import ./tests/ts-esm-loader.mjs --test tests/<file>.test.ts` | Runs one test file in isolation — the fast loop while you develop a guard |

## The TS ESM loader

Tests import production code with the same specifiers the runtime uses —
e.g. `import { discoverParticipants } from "../participants.js"` — and the
hook maps the `.js` specifier to the `.ts` source. `tests/ts-esm-loader.mjs`
registers `tests/ts-hooks.mjs` through `module.register`; besides the `.js`
→ `.ts` remapping it redirects the bare specifier `@gsd/pi-coding-agent` to
the local stub in `tests/fixtures/`. This is why every command that runs the
suite passes `--import ./tests/ts-esm-loader.mjs`: without the hook the
imports would fail with `ERR_MODULE_NOT_FOUND` and the bare specifier would
never resolve (it is a workspace package of gsd-pi, not a published npm
package).

## What the suites guard

The enforcement suites are the executable part of the documentation
conventions:

| File | Contract |
| --- | --- |
| `tests/docs-links.test.ts` | Bilingual convention over the whole docs corpus: every `.md` has its `.it.md` pair, cross links are bilateral, no document links the deliberation archive (D069), the minimal document set stays present |
| `tests/contributor-guide-snippets.test.ts` | Every copyable snippet fenced as `participant` / `coordination` in the contributor guide loads through the production loaders (`discoverParticipants`, `loadDiscussionArenaCoordination`) with zero warnings; `*-invalid` fences produce exactly the registered behavior (skip or D053 warning) |
| `tests/examples-validation.test.ts` | Every `.example.md` under `examples/` loads through its production loader; the `COVERED_EXAMPLE_FILES` guard refuses example files without an owner |
| `tests/naming-residue.test.ts` | No legacy naming residue in tracked and untracked `.ts` / `.md` / `.json` files: the legacy token is allowed only when preceded by the `discussion` qualifier |
| `tests/user-guide-snippets.test.ts` | The same snippet-harness pattern applied to the user guide pages |
| `tests/check-links.test.ts` | The link checker itself: broken-link detection, target classification and CLI behavior, on fixtures |

The behavioural suites cover the production modules directly:
`participants.test.ts`, `participants-override.test.ts`,
`discussion-arena-coordination.test.ts`, `parse-discussion-arena-block.test.ts`,
`discussion-arena-cli.test.ts`, `discussion-arena-session.test.ts`,
`discussion-arena-loop.test.ts`, `index.test.ts`, `helpers.test.ts`,
`metrics.test.ts`, `replay.test.ts`, `trigger-resolver.test.ts`,
`preferences-writer.test.ts`, `tui-wizard.test.ts`, `event-log.test.ts`,
`timeout-watchdog.test.ts`, `hooks-planning.test.ts` and the acceptance
scenarios (`acceptance-scenario-1/2/3.test.ts`, `e2e-auto-mode.test.ts`).

## Adding a test or guard

- Use `node:test` and `node:assert/strict` — no test framework dependencies.
- Import the production function and exercise it; a test must prove behavior
  through the real loader, not through a reimplementation (proof by
  production loader, MEM137).
- Fixtures that need filesystem state live in `os.tmpdir()` and are cleaned
  in `afterEach` — never in repository paths that tests must not touch.
- Make failure messages self-explanatory: name the offending file and line
  (for example `page:line` of a markdown fence) so a red test points at the
  fix without bisection.
- For a new guard, mirror the negative cases: each enforcement dimension has
  a fixture-based test proving the guard actually fires — an enforcement
  that can never fail is not an enforcement.

## Avoiding regressions

Before closing a change, run the full triple: `npm test`, `npm run typecheck`
and `node scripts/check-links.mjs`. The M006 baseline requires at least 359
passing tests; the enforcement suites listed above are what keeps the
bilingual corpus, the example files and the copyable snippets loadable.

## Related documentation

- [Contributor Guide](index.md) — navigation and conventions
- [Project layout](project-layout.md) — where each suite and module lives
- [Participants](participants.md) — participant files, precedence and overrides
- [Coordination file](coordination-file.md) — defaults, virtual roles, loader warnings
- [User Guide](../user-guide/index.md) — installing and using the extension
- [README](../../README.md) — overview, quickstart and known limitations
