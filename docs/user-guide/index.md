**Languages:** [English](index.md) · [Italiano](index.it.md)

# User Guide

The user guide explains how to install, configure and use the `discussion_arena`
tool and the `/discussion-arena` command in your gsd-pi projects. It is written
for people who consume the extension — not for people who modify its source
code.

## What this section covers

- Installing the extension (npm, interactive session, manual copy)
- Running your first `/discussion-arena` round with the bundled participants
- Configuring when the discussion arena is forced vs. merely available, through
  the `discussion_arena:` section in `.gsd/PREFERENCES.md`
- Using session flags such as `--model`, `--continue` and `--new`
- Understanding where transcripts are stored and how to resume a session
- Troubleshooting malformed configuration and parser warnings

## When to read this

Read this guide when you want to use the discussion arena in a real project:
you have gsd-pi installed, and you want a panel of agents with custom roles to
deliberate on a topic before you take a decision.

## Prerequisites

- gsd-pi installed and running (Node 20+)
- The `@efrembaraldo/gsd-pi-discussion-arena` extension installed
- A gsd-pi project where you can create `.gsd/PREFERENCES.md`

## Topics in this guide

The full guide, added in slice S02, covers these pages:

- **Installation** — npm install, interactive session, manual copy, post-install verification
- **Quickstart** — a first `/discussion-arena "topic"` round with the bundled participants
- **Configuration** — the `discussion_arena:` schema (`enabled`, `mode`, `milestones.<MID>.enabled`) and the four parser states
- **Usage** — command flags, `--model` override, persistent sessions with `--continue` / `--new`
- **Troubleshooting** — `DiscussionArenaParseError` in strict mode, `[discussion-arena]` warnings, deterministic fallbacks

## Related documentation

- [README](../../README.md) — overview, quickstart and limitations
- [Contributor Guide](../contributor-guide/index.md) — adding roles and contributing to the extension
- [Architecture Reference](../architecture/index.md) — how the discussion arena works internally

---

Detailed content will be added in slice S02. This index is the stable
navigation contract: every page added to this section ships with its
`.it.md` counterpart and cross links back here.
