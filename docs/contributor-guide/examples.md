**Languages:** [English](examples.md) · [Italiano](examples.it.md)

[Contributor Guide](index.md) — Examples

# Examples

`examples/` is the template shelf of the repository: the files you copy
into your project to configure the discussion arena. The rule that governs
them is proof by production loader, not by prose: every file in `examples/`
is loaded by the same function the extension runs at runtime — no reviewer
looks at them by eye. The suite that enforces this is
`tests/examples-validation.test.ts`, and the coverage guard
`COVERED_EXAMPLE_FILES` refuses any `.example.md` that has no loader owner.

## Why the extension ignores `examples/`

None of the production loaders reads `examples/`. `discoverParticipants`
collects participants from the bundled directory, the user directory
(`~/.pi/agent/discussion-arena/participants/`), the project directory
(`.gsd/discussion-arena/participants/`), the virtual roles and the override
directory; `loadDiscussionArenaCoordination` reads
`.gsd/discussion-arena/discussion-arena-coordination.md`;
`parseDiscussionArenaBlock` parses the `discussion_arena:` block of
`.gsd/PREFERENCES.md`. The `.example.md` suffix is the marker that keeps a
file a template. Once you copy it to a production path the suffix is
harmless: the loaders read `*.md`, and overrides are matched by the
frontmatter `name`, not by the file name.

## The five example files

| File | Production loader | What it demonstrates |
| --- | --- | --- |
| `participants/architect.example.md` | `discoverParticipants` | A realistic participant: the copy of the bundled `architect` role (`participants/architect.md`), with `role: Software Architect`, `tools` and `model`, no per-participant limits |
| `participants/_skeleton.example.md` | `discoverParticipants` | The template for a new role: the three required fields plus all five optional limit fields |
| `participants-overrides/architect.example.md` | `discoverParticipants` with `options.overridesDir` | A total override of a bundled role (`source: "override"`), changing `tools` and limits without merging |
| `discussion-arena-coordination.example.md` | `loadDiscussionArenaCoordination` | The coordination file: `rounds_default`, `model_default` and a virtual role (`scribe`) parsed with zero warnings |
| `PREFERENCES.example.md` | `parseDiscussionArenaBlock` (strict) + `resolveTrigger` | The `discussion_arena:` block that forces the arena per milestone (`decision: forced`, `source: preferences`) |

## How the suite validates them

Each test loads the real file through the production loader, in an isolated
project tree under `os.tmpdir()` (never a gitignored repository path):

- the participant examples are symlinked into an isolated user directory
  and discovered with `skipBundled: true`: the example must come back
  exactly once with `source: "user"` and its declared `name`; the architect
  example must resolve the same `role`, `tools` and `model` declared in the
  frontmatter;
- the override example is copied into `options.overridesDir` and discovered
  **without** `skipBundled` (MEM107): the bundled `architect` base must stay
  in the map so the override is not an orphan, the result reports
  `source: "override"`, `orphanOverrides: []`, the new `tools` list (with
  `rg`) and the per-participant limits;
- the coordination example is passed to `loadDiscussionArenaCoordination`:
  zero warnings, `roundsDefault: 2`, `modelDefault` and the virtual role
  `scribe` present in the parsed config;
- the preferences example is parsed with `strict: true` (an unknown key
  would throw `DiscussionArenaParseError`) and, copied to
  `.gsd/PREFERENCES.md` of a temporary project, drives `resolveTrigger` to
  `forced` with `source: "preferences"` for the active milestone `M001`.

## The coverage guard

`COVERED_EXAMPLE_FILES` in `tests/examples-validation.test.ts` lists the
five files. A separate test walks `examples/` recursively, collects every
`.example.md` and fails if any of them is not registered — with a message
naming the uncovered file. Adding a new example without a validation case
and without the guard entry breaks the suite: an example without a loader
owner is impossible.

## Adding an example

1. Write a **realistic** file — the shape of the production file, not a
   placeholder. The exception is the template `_skeleton.example.md`, whose
   placeholders are its purpose.
2. Choose the production loader that will read it once copied into a
   project: a participant → `discoverParticipants`; an override →
   `discoverParticipants` with `options.overridesDir` (the base role must
   exist — never `skipBundled` in the test); a coordination file →
   `loadDiscussionArenaCoordination`; a preferences block →
   `parseDiscussionArenaBlock` + `resolveTrigger`.
3. Add a validation case in `tests/examples-validation.test.ts` that loads
   the real file through that loader, with fixtures in `os.tmpdir()`.
4. Register the file in `COVERED_EXAMPLE_FILES`.

## The enforcement is sensitive

The suite also proves the loaders would reject a broken example, by running
the same production loaders on mutated copies in temporary directories:

- `rounds_default: 0` in a coordination copy → the D053 warning and no
  default applied;
- an unknown key in the preferences block → `DiscussionArenaParseError`
  under `strict: true`;
- a participant copy without `role` → excluded from discovery (zero
  participants found);
- an override whose base does not exist → the blocking orphan error of the
  loader.

These negative cases are what makes the validity of the real files
non-tautological: the guard fires.

Examples are not part of the bilingual documentation corpus: they carry no
`.it.md` variant (`tests/docs-links.test.ts` applies the convention to the
docs and README pairs only).

## Related documentation

- [Contributor Guide](index.md) — navigation and conventions
- [Participants](participants.md) — the copyable participant file and its frontmatter schema
- [Coordination file](coordination-file.md) — the copyable coordination file and loader warnings
- [Testing](testing.md) — running the suite and adding guards
- [User Guide](../user-guide/index.md) — installing and using the extension
- [Architecture Reference](../architecture/index.md) — how the discussion arena works internally
- [README](../../README.md) — overview, quickstart and known limitations
