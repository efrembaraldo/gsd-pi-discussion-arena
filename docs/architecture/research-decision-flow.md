**Languages:** [English](research-decision-flow.md) · [Italiano](research-decision-flow.it.md)

[Architecture Reference](index.md) — Research-decision flow

# Research-decision flow

The research-decision flow turns a `discussion_arena` run in the research
phase into durable GSD requirements and decisions. It is the delivery
surface of milestone M008: a gate asks the user to approve a research
deliberation, the agent launches the discussion arena, and — once approved —
the structure the Scribe produced is persisted and then ingested into the
project's requirement and decision registers (`gsd_requirement_save` /
`gsd_decision_save`).

This page documents the nine-step pipeline end to end. Every symbol and line
cited here is anchored to the current source by
`tests/architecture-refs.test.ts`, so a rename or a move makes the suite
fail instead of letting the page rot.

## Pipeline overview

```text
 research-decision       1. gate research-decision opens
 ──► discussion arena    2. hook injects the discussion_arena tool
     ──► Scribe          3. agent launches the discussion arena
     ──► transcript      4. Scribe produces the markdown transcript
     ──► structured      5. extractor parses the transcript
     ──► pending       6. writer persists pending-research.json
     ──► approved        7. user approves the gate
     ──► ingest          8. ingestion reads pending → gsd_requirement_save / gsd_decision_save
     ──► cleanup         9. pending files are removed
```

Each step is owned by one module, documented in the sections below.

## Step 1 — the research-decision gate opens

When the milestone enters the research phase, the `depth_verification`
research gate is offered to the user. Nothing in this flow runs before the
gate is opened — the presence of a research deliberation to extract is a
precondition for every later step.

## Step 2 — the hook injects the discussion arena

Once the gate is engaged, a lifecycle hook exposes `discussion_arena` to
the agent so the deliberation can actually happen. This is the same
trigger/hook machinery described in the
[*Hooks*](hooks.md) and [*Trigger resolution*](trigger-resolution.md)
pages — the flow reuses it rather than duplicating it.

## Step 3 — the agent launches the discussion arena

The agent calls `discussion_arena` with the research topic. The discussion arena runs
its participant panel over the configured rounds and returns a transcript —
see [*Round orchestration*](round-orchestration.md) for how the transcript
is assembled.

## Step 4 — the Scribe produces the transcript

At the end of the run the Scribe participant produces a markdown transcript
with three structured sections: `## Ipotesi`, `## Decisioni` and
`## Requisiti`. This canonical shape is what the extractor consumes.

## Step 5 — the extractor parses the transcript

`extractResearchDecisions` (`src/discussion-arena-research-extractor.ts:211`)
parses the transcript into a typed `ResearchDecisions` structure
with `hypotheses`, `decisions` and `requirements`. The parser is
deterministic and failure-safe: if the transcript is not structured enough it
returns a `fallback: "model-call-needed"` marker instead of throwing, so a
model call becomes an explicit downstream decision rather than a silent
crash.

## Step 6 — the writer persists pending-research

Once a typed structure is available, `writePendingResearch`
(`src/discussion-arena-pending-research.ts:182`) writes the two files under
`cwd/.gsd/discussion-arena/` atomically (write-then-rename):

- `pending-research.json` — the typed structure, wrapped as
  `{ version: 1, structured }` (filename from the constant
  `PENDING_RESEARCH_JSON_FILENAME`,
  `src/discussion-arena-pending-research.ts:46`);
- `pending-research.md` — the human-readable complete transcript.

Both files live in the same directory as the coordination file, so the
`ingestion` opt-in described in Step 8 reads them from there.

## Step 7 — the user approves the gate

The pending-research files are inert until the user approves the gate. The
approval is the trigger that authorizes ingestion; until then nothing is
written to the GSD requirement or decision registers.

## Step 8 — ingestion reads pending and saves

Ingestion runs the `milestone_end` event (registered in `index.ts` through
the hook `attachIngestionHooks`, `src/discussion-arena-ingestion.ts:514`)
**before** the cleanup hook, so it reads the pending files while they still
exist. It is opt-in: only projects whose coordination file has
`ingestion.enabled: true` run it.

`ingestPendingResearch` (`src/discussion-arena-ingestion.ts:404`) reads
`pending-research.json`, builds an ordered plan of requirements and
decisions, and for each entry not yet in the idempotency ledger emits a
*save intent* through two injected adapters:

- every `requirement` → `gsd_requirement_save`;
- every `decision` → `gsd_decision_save`.

The default adapters (`createFileOutboxAdapters`,
`src/discussion-arena-ingestion.ts:361`) append each intent as a JSON line
to `ingestion-outbox.jsonl` — a durable handoff for whoever then executes
the real `gsd_requirement_save`/`gsd_decision_save`. Because the module
accepts injected adapters with a stable extractor shape, the harness can
also supply adapters that call the tools directly and the logic stays the
same.

## Step 9 — cleanup

Once ingestion has read the pending files, the milestone-end cleanup hook
removes them so no stale research artifacts survive. `cleanupPendingResearch`
(`src/discussion-arena-pending-research.ts:236`) deletes both files
(ENOENT is ignored), and a `unit_start` TTL fallback covers the case where
`milestone_end` never arrives (a crashed session, for example).

## Idempotency

Ingestion is idempotent by construction: `ingestPendingResearch` keeps an
`ingestion-ledger.json` alongside the pending files and records a
deterministic key for every entry already saved (requirement: its `id` or a
stable hash of title+description; decision: a stable hash of the statement).
Re-running the ingestion on the same tree skips everything already in the
ledger, and an outbox append never duplicates. This holds across processes
because the key is a pure function of the input — no timestamps.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Ingestion did nothing | `ingestion.enabled` is `false` or missing in the coordination file | Set `ingestion: { enabled: true }` |
| "no pending-research file" | `pending-research.json` was never written or already cleaned up | Re-run the discussion arena and approve the gate |
| Requirements/decisions duplicated | Ledger was cleared or the source content changed key | Confirm `ingestion-ledger.json` exists; do not clear it manually |
| Decision intent missing | Extract statement was not a first-level bullet of `## Decisioni` | Check the Scribe transcript shape |
| Nothing appears in REQUIREMENTS.md | The harness adapter that calls the real `gsd_*` tools has not consumed the outbox | Consume `ingestion-outbox.jsonl` or inject the real adapters |

## Related documentation

- [Architecture Reference](index.md) — index of the internal reference
- [Hooks](hooks.md) — how the tool is injected and the hooks are attached
- [Round orchestration](round-orchestration.md) — how the Scribe transcript is assembled
- [User Guide](../user-guide/index.md) — installing and using the extension
- [README](../../README.md) — overview, quickstart and known limitations
