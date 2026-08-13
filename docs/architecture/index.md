**Languages:** [English](index.md) · [Italiano](index.it.md)

# Architecture Reference

The architecture reference explains how the discussion arena works internally:
how a single `/discussion-arena` invocation becomes a panel of isolated agent
subprocesses, how the trigger decides whether the discussion arena is forced
or merely available, and where the runtime limits live. It is written for people who need
to understand or modify the extension's internals.

## What this section covers

- Tool registration and the end-to-end flow of one invocation
- The participant subprocess model (one `gsd` process per participant, isolated session)
- Sequential rounds and how participants see each other's turns
- Trigger resolution tiers 1-2-3 (`resolveTrigger`) and phase detection
- The auto-mode hooks that force or expose the discussion arena
- Runtime limits and their enforcement points

## When to read this

Read this reference when you need to reason about the extension's behavior:
before changing `index.ts`, adding a hook, or diagnosing why a session behaves
the way it does.

## Prerequisites

- The repository cloned, with `npm run typecheck` passing
- Working knowledge of TypeScript and of the gsd-pi extension API
- The Contributor Guide as a starting point for repository conventions

## Topics in this guide

The full reference, added in slice S04, covers these pages:

- **Invocation flow** — from the registered tool to the returned transcript
- **Participant subprocesses** — `runParticipantTurn`, session isolation, per-round cost and latency
- **Round orchestration** — sequential rounds, transcript assembly, prompt truncation (~100KB)
- **Trigger resolution** — `resolveTrigger` tiers 1-2-3, deterministic fallback, phase detection on `unit_start`
- **Hooks** — `adjust_tool_set` and `before_agent_start` behavior in the planning phase
- **Runtime limits** — `MAX_PARTICIPANTS`, `MAX_ROUNDS`, `DEFAULT_ROUNDS` and their enforcement points

## Related documentation

- [README](../../README.md) — overview, quickstart and limitations
- [User Guide](../user-guide/index.md) — installing and using the extension
- [Contributor Guide](../contributor-guide/index.md) — adding roles and contributing

---

Detailed content will be added in slice S04. This index is the stable
navigation contract: every page added to this section ships with its
`.it.md` counterpart and cross links back here.
