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

Seven pages, each with its Italian counterpart (`.it.md`), describe the extension internals:

- [Invocation flow](invocation-flow.md) — from the registered tool to the returned transcript
- [Trigger resolution](trigger-resolution.md) — `resolveTrigger` tiers 1-2-3, deterministic fallback, phase detection on `unit_start`
- [Hooks](hooks.md) — `adjust_tool_set` and `before_agent_start` behavior in the planning phase
- [Runtime limits](runtime-limits.md) — `MAX_PARTICIPANTS`, `MAX_ROUNDS`, `DEFAULT_ROUNDS` and their enforcement points
- [Participant subprocesses](participant-subprocesses.md) — `runParticipantTurn`, session isolation, per-round cost and latency
- [Round orchestration](round-orchestration.md) — sequential rounds, transcript assembly, prompt truncation (~100KB)
- [Research-decision flow](research-decision-flow.md) — gate → discussion arena → extract → pending → ingest → cleanup, the S04 ingestion pipeline

The paths, symbols and constants cited on these pages are not illustrative:
`tests/architecture-refs.test.ts` anchors them to the current sources. The
suite verifies (source-side) that every file, symbol, line and value mentioned
resolves, and (doc-side) that every page actually cites the references
declared for it. When code and documentation drift, the test suite fails and
names the page where the divergence lives.

## Related documentation

- [README](../../README.md) — overview, quickstart and limitations
- [User Guide](../user-guide/index.md) — installing and using the extension
- [Contributor Guide](../contributor-guide/index.md) — adding roles and contributing

---

Every page in this section ships with its `.it.md` counterpart and links back
here. To add a page, add its entries to the reference table in
`tests/architecture-refs.test.ts` and link it from both index files: the
doc-side guard fails until the index lists every page the table declares.
