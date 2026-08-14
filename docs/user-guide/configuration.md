**Languages:** [English](configuration.md) · [Italiano](configuration.it.md)

[User Guide](index.md) — Configuration

# Configuring the discussion arena

The discussion arena decides when it is **forced** — the auto
orchestrator requires you to run a round before deciding the plan — versus
merely **available** — the `discussion_arena` tool stays registered in every
phase, but nothing is injected into the prompt. The decision is evaluated in
a deterministic order and reads two sources:

* the `activation:` section of the coordination file
   `<cwd>/.gsd/discussion-arena/discussion-arena-coordination.md`
   (canonical, written by the TUI wizard);
* the legacy `discussion_arena:` section in
   `<cwd>/.gsd/PREFERENCES.md` (deprecated, still read for backward
   compatibility and emits a one-shot warning).

If you still configure the legacy section, follow
[Migrating from PREFERENCES.md](#migrating-from-preferencesmd) below.

This page documents the schema, the three activation tiers and the four
parser states exactly as the production code implements them
(`trigger-resolver.ts`, `src/parse-discussion-arena-block.ts`). Every `yaml`
snippet below is validated against the production parser by
`tests/user-guide-snippets.test.ts` in `strict:true`: if a snippet is wrong,
the test suite fails and names the page and the offending key.

## Migrating from PREFERENCES.md

The `discussion_arena:` section in `<cwd>/.gsd/PREFERENCES.md` is
**deprecated**: gsd-pi still reads it for backward compatibility, but shows
a one-shot warning on stderr:

```
[discussion-arena] DEPRECATION: discussion_arena: section in PREFERENCES.md is deprecated — move to .gsd/discussion-arena/discussion-arena-coordination.md under activation:.
```

New setups — and the TUI wizard — configure the discussion arena in the `activation:`
section of the coordination file
`<cwd>/.gsd/discussion-arena/discussion-arena-coordination.md`. The two
sections share the same keys and the same 2/4/6-space indentation contract
(D025), so the migration is a straight copy:

**Before — legacy, in `PREFERENCES.md`:**

```yaml
discussion_arena:
  enabled: true
  mode: per-milestone
  milestones:
    M001:
      enabled: true
```

**After — canonical, in `.gsd/discussion-arena/discussion-arena-coordination.md`:**

```markdown
activation:
  enabled: true
  mode: per-milestone
  milestones:
    M001:
      enabled: true
```

> The `activation:` fragment above is shown under a `markdown` fence tag on
> purpose: every `yaml` fence in this guide is contractually a
> `discussion_arena:` block validated by `tests/user-guide-snippets.test.ts`,
> so this non-`yaml` tag keeps the harness from misreading it.

## The (legacy) `discussion_arena:` section in PREFERENCES.md

Add the section inside the frontmatter of `<cwd>/.gsd/PREFERENCES.md`:

```yaml
discussion_arena:
  enabled: true
  mode: per-milestone
  milestones:
    M001:
      enabled: true
    M002:
      enabled: false
    M003:
      enabled: true
```

The indentation shape is part of the schema contract (D025). The parser is a
zero-dependency YAML-subset parser: sub-keys at 2 spaces, milestone IDs at 4,
milestone keys at 6.

| Key | Indent | Allowed values | Meaning |
| --- | --- | --- | --- |
| `discussion_arena:` | 0 | — | Root marker of the section |
| `enabled:` | 2 | `true`, `false` | Global flag; absent behaves like `false` |
| `mode:` | 2 | `per-milestone`, `always-on`, `availability-only` | Metadata for the TUI wizard — the trigger does not read it |
| `milestones:` | 2 | — | Opens the per-milestone table |
| `<MID>:` | 4 | letters, digits, `_`, `.`, `-` | Milestone ID (permissive form: `M001`, `M_002`, `M.003`, `M-003` are all valid) |
| `enabled:` | 6 | `true`, `false` | Per-milestone override |

The two other modes, written explicitly (the default is `availability-only`):

```yaml
discussion_arena:
  enabled: true
  mode: always-on
```

```yaml
discussion_arena:
  enabled: false
  mode: availability-only
```

A section that enables only specific milestones — with no global flag — also
forces for those milestones:

```yaml
discussion_arena:
  mode: per-milestone
  milestones:
    M004:
      enabled: true
```

## Semantics of the keys

* `enabled: true` at level 2 forces the discussion arena for the current
  milestone, unless a milestone entry below overrides it.
* `milestones.<MID>.enabled` is a per-milestone switch that can only **add**
  forcing: the trigger forces when `milestones.<MID>.enabled` is `true` **or**
  the global `enabled` is `true`. A milestone `enabled: false` does NOT cancel
  a global `enabled: true` — with both present, the decision is still
  `forced`.
* `mode` is metadata for the interactive wizard: the trigger never reads it.
  The choice between `per-milestone` and `always-on` only changes how the
  wizard writes the section, not how the trigger decides.

## The three activation tiers

The decision is a pure function (`resolveTrigger`): it never throws and always
returns one of two decisions. The order is deterministic:

1. **Tier 1 — environment variable.** `GSD_DISCUSSION_ARENA_AUTO=1` →
   `forced`, source `env`. Only the exact string `1` forces; `0` or unset do
   not.
2. **Tier 2 — PREFERENCES.md.** For the **current** milestone: if
   `milestones.<MID>.enabled` is `true`, or the global `enabled` is `true` →
   `forced`, source `preferences`.
3. **Tier 3 — fallback.** Otherwise → `available-only`, source `fallback`.

The `forced` decision only affects the `planning` phase: the phase hook fires
when the phase is `planning` **and** the decision is `forced`. In every other
phase, or with decision `available-only`, the tool stays registered but is
never forced.

| Configuration (current milestone `M005`) | Decision | Source |
| --- | --- | --- |
| No `discussion_arena:` section | `available-only` | `fallback` |
| `milestones.M005.enabled: true` | `forced` | `preferences` |
| `milestones.M005.enabled: false` (only entry) | `available-only` | `fallback` |
| Global `enabled: true` | `forced` | `preferences` |
| `milestones.M005.enabled: false` + global `enabled: true` | `forced` | `preferences` |
| `GSD_DISCUSSION_ARENA_AUTO=1` (any config) | `forced` | `env` |

## The four parser states

The parser (and the trigger around it) distinguishes four states. The first
two produce the same outcome, but for different reasons:

| State | What happens | Trigger outcome |
| --- | --- | --- |
| 1. File missing | `<cwd>/.gsd/PREFERENCES.md` does not exist; `ENOENT` is absorbed with no warning. Other read errors produce a warning and still fall back | Tier 3 → `available-only`, source `fallback` |
| 2. Section missing | File exists, no `discussion_arena:` root marker; config stays empty | Tier 3 → `available-only`, source `fallback` |
| 3. Section valid | All lines match the schema; the parsed config is honored | Tier 2 → `forced` if a flag survives, otherwise Tier 3 |
| 4. Section malformed | Unknown key or out-of-schema indentation; see below | Depends on what survives the skip, see below |

**State 4 in detail.** The trigger parses the section in `strict:false`
(lenient) mode, exactly like the two legacy parsers: an offending line is
skipped **silently** — no warning, no error — and the remaining well-formed
lines are still honored. `parseErrors` is collected but never checked: the
decision is never blocked by a parse problem.

| What you type (hand-edited) | Parser behavior (`strict:false`) | Decision |
| --- | --- | --- |
| `bogus_key: 1` after `enabled: true` | skips `bogus_key`, keeps `enabled: true` | `forced` (`preferences`) |
| `bogus_key: 1` as the only line | skips it; the section is empty | `available-only` (`fallback`) |
| `enabled: true` at 4 spaces, outside `milestones:` | skipped (out of schema) | `available-only` (`fallback`) |
| `M001!: x` inside `milestones:` | skipped; `M001` is not registered | `available-only` (`fallback`) |

There is **no warning in any of these cases**: the lenient mode is silent by
design for backwards compatibility. If you edit the section by hand and the
trigger "does nothing", re-read the section against the schema table above
instead of searching the logs for a warning that is never emitted.

In `strict:true` — the mode used by the writer to validate override files —
the first offending line instead throws `DiscussionArenaParseError` with the
offending `key`, its indentation level and the raw line. The troubleshooting
page of this guide shows a deliberately malformed snippet and the exact error
it raises.

## Choosing the mode with the TUI wizard

At the `milestone_start` event, when the session has a TUI, the extension
proposes a 3-choice picker and persists the choice **atomically**
(read-modify-write) in the `activation:` section of the coordination file
`<cwd>/.gsd/discussion-arena/discussion-arena-coordination.md`:

| Choice | Written to the coordination file (`activation:`) |
| --- | --- |
| `per-milestone` | `activation.milestones.<MID>.enabled: true` |
| `always-on` | `activation.enabled: true` |
| `availability-only` | `activation.enabled: false` (default) |

With `hasUI === false` (CI, print mode, no TUI), the wizard is a strict no-op:
it emits a `[discussion-arena]` diagnostic on stderr and returns, never
blocking the pipeline. Configure the section by hand in that case.

## Related documentation

* [User Guide](index.md) — install, quickstart, usage, troubleshooting
* [README](../../README.md) — overview, quickstart and known limitations
* [Contributor Guide](../contributor-guide/index.md) — roles, participants and repository conventions
* [Architecture Reference](../architecture/index.md) — trigger resolution and phase hooks internals
