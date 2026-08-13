**Languages:** [English](coordination-file.md) · [Italiano](coordination-file.it.md)

[Contributor Guide](index.md) — Coordination file

# The coordination file

The per-project coordination file defines the "shape" of the discussion
arena. It lives at `.gsd/discussion-arena/discussion-arena-coordination.md`
and is read with a walk-up search from `cwd` towards the git root, exactly
like the project participants directory. It is the canonical source for
three things:

| Key | Effect |
| --- | --- |
| `rounds_default` | Default round count when neither the tool nor the command passes an explicit value (level 3 of the 4-level hierarchy in `resolveRoundsDefault`, `participants.ts`) |
| `model_default` | Fallback model applied to participants without an explicit `model` (including virtual roles) |
| `roles_virtuals` | One-off roles defined entirely here, without a file in `participants/` |

The loader is `loadDiscussionArenaCoordination`
(`src/discussion-arena-coordination.ts`), the same function the extension
runs at runtime. Its contract: **never throws** — every parse error produces
an empty config with a `[discussion-arena]` diagnostic on stderr (D053), and
a missing file is a silent no-op. The copyable snippet on this page is
validated against that production loader by
`tests/contributor-guide-snippets.test.ts`: it must load with zero warnings.

## A copyable coordination file

The file is a Markdown document whose frontmatter follows an
indentation-aware YAML subset (D051): top-level keys at 0 spaces, each
virtual role key at 2, its fields at 4, the `systemPrompt` block scalar
deeper. Comments (`#`) and inline comments are stripped. Copy this file to
`.gsd/discussion-arena/discussion-arena-coordination.md` in your project:

```coordination
---
# Shape of the discussion arena: rounds, model and virtual roles.
rounds_default: 2
model_default: <inference provider>
roles_virtuals:
  scribe:
    name: scribe
    role: Scribe
    description: Consolidates the council conclusions into a final summary
    systemPrompt: |
      You are the Scribe of the agent council. Produce a final summary of
      the discussion: decisions taken, trade-offs surfaced and follow-up
      actions. Be concise and faithful to the actual contributions.
---

Copy this file to `.gsd/discussion-arena/discussion-arena-coordination.md`
and the discussion arena will apply its defaults on the next run.
```

The harness writes this snippet to a temporary file and passes it to
`loadDiscussionArenaCoordination`: it must come back with zero warnings, and
every value declared in the frontmatter (`rounds_default`, `model_default`
and the virtual role keys) must be present in the parsed config.

## Frontmatter schema

| Key | Indent | Required | Meaning |
| --- | --- | --- | --- |
| `rounds_default` | 0 | no | Positive integer (>= 1); default round count at hierarchy level 3 |
| `model_default` | 0 | no | Fallback model for participants without an explicit `model` |
| `roles_virtuals` | 0 | no | Opens the virtual roles section (dict) |
| `<key>:` | 2 | — | Virtual role key; must equal the entry's `name` field |
| `name` / `role` / `description` / `systemPrompt` | 4 | yes | The four required fields of a virtual role |

Rules of the loader:

- `rounds_default` must be an integer >= 1. A non-integer or 0 is ignored
  with a D053 warning and the code defaults apply.
- A virtual role entry missing one of the four required fields is skipped
  with a D053 warning; the other entries keep working.
- A dict key that differs from the entry's `name` field makes the single
  role skipped with the warning
  `virtual role '<key>' name field mismatch '<name>' — skipped` (the other
  roles stay applied).
- Unknown top-level keys are ignored silently (forward compatibility: a
  file written for a future version must not reset the config).
- The file without a frontmatter (no leading `---`) is a silent no-op.

`rounds_default` from the coordination file feeds `resolveRoundsDefault`
(`participants.ts`) as level 3 of the hierarchy: tool parameter (1) >
participant frontmatter (2, reserved) > coordination `rounds_default` (3) >
code default (4). `model_default` is applied by `discoverParticipants` as a
fallback on every resolved participant without an explicit `model` field —
virtual roles included.

## Virtual roles

A virtual role is a first-class participant with `source: "virtual"` and
`filePath` pointing at the coordination file. It needs no file in
`participants/`, but it participates in the precedence map exactly like a
base role: base tiers (bundled, user, project) < virtual < override (D052).
This also means an override targeting a virtual role is **not** an orphan.

## What the loader warns about

The loader never throws: a malformed value degrades the config, not the
process. The snippet below is deliberately invalid (`rounds_default: 0`)
and is used by the harness to prove the loader emits the registered warning:

```coordination-invalid
---
rounds_default: 0
---

This file is deliberately invalid: `rounds_default` must be a positive
integer, so the loader emits the D053 warning and applies code defaults.
```

The exact warning is
`rounds_default must be a positive integer (got 0) — using code defaults`.
If your defaults "are not applied", re-check the frontmatter against the
schema table above and look for the `[discussion-arena]` prefix on stderr.

## Related documentation

- [Contributor Guide](index.md) — navigation and conventions
- [Participants](participants.md) — participant files, precedence and overrides
- [User Guide](../user-guide/index.md) — installing and using the extension
- [Architecture Reference](../architecture/index.md) — how the discussion arena resolves rounds and models
- [README](../../README.md) — overview, quickstart and known limitations
