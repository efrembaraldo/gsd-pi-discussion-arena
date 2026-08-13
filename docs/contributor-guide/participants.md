**Languages:** [English](participants.md) · [Italiano](participants.it.md)

[Contributor Guide](index.md) — Participants

# Adding and overriding participants

The discussion arena loads its participants from Markdown files with a
frontmatter block, one file per role. The discovery function is
`discoverParticipants` (`participants.ts`), the same function the extension
runs at runtime: whatever you write in `participants/*.md` must survive that
loader, not a reviewer's eye. Every copyable snippet on this page is
validated against the production loader by
`tests/contributor-guide-snippets.test.ts` — if a snippet stops loading, the
test suite fails and names the page and the fence line.

## How discovery works

`discoverParticipants(cwd, options)` collects participant files from five
sources. Precedence is **highest wins** (D052):

| Tier | Source | Directory / file | `source` field |
| --- | --- | --- | --- |
| 0 | override | `.gsd/discussion-arena/participants-overrides/*.md` (walk-up to git root) | `override` |
| 1 | virtual | `roles_virtuals:` in the coordination file | `virtual` |
| 2 | project | `.gsd/discussion-arena/participants/*.md` (walk-up to git root) | `project` |
| 3 | user | `~/.pi/agent/discussion-arena/participants/*.md` | `user` |
| 4 | bundled | `participants/` next to the installed module | `bundled` |

At equal `name`, a higher tier replaces the lower one entirely: the map is
built bundled → user → project → virtual → override, each tier overwriting
the previous entry with the same name. Bundled participants are the shipped
examples (`analyst`, `architect`, `dev`, `qa`): after `npm install` the
discussion arena works without any setup, and you override them instead of
editing the package.

The project, override and coordination paths use a **walk-up** search: the
loader starts from `cwd` and climbs towards the git root until it finds the
directory (or file). This is why a participant in a subdirectory still
applies to the whole repository.

## A copyable participant file

A participant file is frontmatter plus a body. The three fields
`name`, `role` and `description` are **required** — without them the file is
silently excluded. Copy this file to
`.gsd/discussion-arena/participants/pm.md` in your project:

```participant
---
name: pm
role: Project Manager
description: Keeps the discussion focused on project goals, scope and deadlines
tools: read, grep, ls
model: freeinference_efrem/minimax-m3
round_timeout_ms: 120000
output_limit_chars: 4000
---

You are the Project Manager of the agent council. Keep the discussion
focused on the project goals and deadlines.

When you intervene:

- Remind the council of the scope, the schedule and the definition of done.
- Flag drift: proposals that solve a problem outside the current milestone.
- Summarize the decision and the assigned follow-ups at the end of each round.
- Be brief: 3-6 sentences per intervention.
```

The harness writes this snippet to an isolated temporary user directory and
calls `discoverParticipants` with `skipBundled: true`: the snippet must come
back exactly once, with `source: "user"` and the same `name` declared in the
frontmatter.

## Frontmatter schema

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | Unique identifier; key of the participant map, used to invoke the role |
| `role` | yes | Label shown in the discussion arena transcript |
| `description` | yes | Competence of the role, used by the council |
| `tools` | no | Comma-separated list of tools allowed for the subprocess |
| `model` | no | Model override; falls back to the coordination `model_default` when absent |
| `round_timeout_ms` | no | Per-participant timeout for a single round |
| `event_timeout_ms` | no | Timeout for the first event of a round |
| `output_limit_chars` | no | Cap on output characters per intervention |
| `cost_budget_usd` | no | Maximum budget for the subprocess |
| `termination` | no | `soft` (default) or `hard` |

The five limit fields are validated and merged at runtime by
`resolveParticipantLimits` (`helpers.ts`), never by the discovery loader: the
frontmatter only carries the raw values. `systemPrompt` is the body after the
frontmatter — no transformation, no placeholders: what you write is what the
role runs.

## Overrides: total replacement, no merge

An override file in `.gsd/discussion-arena/participants-overrides/<role>.md`
replaces the base participant **entirely** — frontmatter and system prompt.
No field is merged from the base. The override must match the base by the
frontmatter `name`, not by the file name: `architect.example.md` overrides
`architect`, and the `.example.md` suffix is harmless.

An override without a base is an **orphan** and discovery throws a blocking
error — there is no silent fallback:

```
override target '<role>' not found in participants/ — create participants/<role>.md or remove the override file
```

The virtual tier counts as a base: an override pointing at a role defined in
`roles_virtuals` is valid (D052, base < virtual < override).

## What the loader rejects

A participant without `name`, `role` or `description` never enters the
result: `parseParticipantContent` returns `null` and `discoverParticipants`
skips the file **silently** — no error, no log. The snippet below is
deliberately malformed (missing `role`) and is used by the harness to prove
the loader actually excludes it:

```participant-invalid
---
name: ghost
description: Missing the required role field
---

A participant file without `role` is not loadable: `discoverParticipants`
excludes it silently and the discussion arena never sees it.
```

If your participant "does not appear", re-check the frontmatter against the
schema table above before searching the logs: a missing required field
leaves no trace.

## Related documentation

- [Contributor Guide](index.md) — navigation and conventions
- [Coordination file](coordination-file.md) — `rounds_default`, `model_default` and `roles_virtuals`
- [User Guide](../user-guide/index.md) — installing and using the extension
- [Architecture Reference](../architecture/index.md) — how discovery and precedence work internally
- [README](../../README.md) — overview, quickstart and known limitations
