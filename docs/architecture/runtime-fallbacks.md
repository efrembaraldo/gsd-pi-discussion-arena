**Languages:** [English](runtime-fallbacks.md) · [Italiano](runtime-fallbacks.it.md)

[Architecture Reference](index.md) — Runtime fallbacks

# Runtime fallbacks (gsd-pi integration)

This page is the landing place for the seven runtime risks (R1–R7) that the
Vision v2 §10 table enumerates for the integration with `gsd-pi`. The
sections below are deliberately empty skeletons: they will be populated by
the milestones that actually implement each mitigation. Treat a blank `## Rn`
section as "risk identified, mitigation not yet implemented" — an honest
placeholder, never a closure claim.

## R1

## R2

## R3

## R4

## R5

## R6

**Risk:** Race tra `writePendingResearch` eseguito dal callback
`discussion_arena.execute` (unit `research-decision`) e l'ingestion
`milestone_end` (lifecycle hook `attachPendingResearchLifecycleHooks`)
quando più processi operano in concorrenza sullo stesso `<cwd>`.

### Risk register

| Field | Value |
| ------- | ------- |
| Probability | Medium |
| Impact | High |
| Mitigation type | Cross-process lock file + serial critical section |
| PR candidacy | candidate |
| Upstream issue | TBD |

### Current mitigation

Lock file `<cwd>/.gsd/discussion-arena/pending-research.lock` con claim
atomico `open(path, "wx")` (POSIX `O_CREAT|O_EXCL`), attesa bounded
(`timeoutMs=5000` default), stale recovery (`staleAfterMs=30000`),
corrupt recovery, release ownership-safe (rifiuta l'unlink se il lock
corrente ha `(pid, createdAtMs)` diversi dal proprio handle; idempotente
su doppia release), wrapper `withPendingResearchLock(cwd, fn, opts?)`
che garantisce `try/finally` anche su throw. Primitive esportate da
`src/discussion-arena-pending-research.ts`:
`acquirePendingResearchLock`, `releasePendingResearchLock`,
`withPendingResearchLock`, `pendingResearchLockPath`,
`PendingResearchLockTimeoutError`, `PENDING_RESEARCH_LOCK_FILENAME`.

Il wiring è applicato in due punti:

1. `index.ts` — `buildDiscussionArenaExecute(api, { stderr })`
   cattura `getCurrentUnitType(api)` (fornito da T01 in
   `src/hooks-unit-aware.ts`) all'inizio dell'invoke; quando l'unità è
   `research-decision` e l'extractor NON cade in fallback, esegue
   `writePendingResearch` dentro `withPendingResearchLock(ctx.cwd, ...,
   { stderr })`; il flag `details.pendingResearchWritten` riflette se il
   write ha mutato i file (idempotente per stesso payload).
2. `src/discussion-arena-ingestion.ts` —
   `attachPendingResearchLifecycleHooks(api, options)` registra un
   UNICO listener `milestone_end` che esegue `ingestPendingResearch(cwd)`
   → `cleanupPendingResearch(cwd)` nella STESSA sezione critica di
   `withPendingResearchLock`: ingestion osserva i file pending, cleanup
   li rimuove, un writer successivo arriva DOPO il rilascio e non viene
   rimosso dal cleanup precedente. Su `PendingResearchLockTimeoutError`
   il lifecycle preserva i file pending (TTL logico: retry alla
   prossima `milestone_end` o recovery stale-based). Log stderr
   strutturato con prefisso canonico `[discussion-arena]` per
   acquisizione, attesa (singolo evento, niente spam),
   stale-recovery, corrupt-recovery, timeout e rilascio.

### Behavioral contract

Due processi distinti sullo stesso `<cwd>` NON entrano MAI
simultaneamente nella sezione critica del lock. La proprietà è
garantita dal kernel (POSIX `O_CREAT|O_EXCL`), non da primitive
in-process. I log strutturati permettono di diagnosticare
serializzazione, attesa, recovery e timeout senza ispezione manuale del
file system. I fallimenti di estrazione o persistenza restano
non-fatali ma osservabili (`details.pendingResearchWritten === false`
segnala il mancato write senza abort del tool). Un timeout del
lifecycle preserva i file pending per retry/TTL — la pulizia non viene
forzata a costo di perdita dati.

### Tests

- `tests/unit/pending-research-lock.test.ts` — 16 test: acquire con
  prefisso canonico, mkdir ricorsivo, release idempotente, release
  ownership-safe (lock rubato), stale recovery, corrupt recovery,
  timeout strutturato, `withPendingResearchLock` su success / throw /
  acquire-timeout, e due test cross-process (main attende child +
  due child distinct che serializzano un contatore condiviso e
  producono `2`).
- `tests/integration/s01-tool-call-site.test.ts` — 7 test del
  call-site cablato: research-decision scrive, planning/unknown/
  fallback/replay non scrivono, lock timeout non propaga al return,
  run throw → error details; `details.pendingResearchWritten`
  osservabile.
- `tests/integration/s01-race-condition.test.ts` — 4 test
  cross-process: RC-1 due execute concorrenti serializzati dal lock
  con lock events in ordine strict + idempotenza osservata sul
  secondo execute; RC-2 ingestion-then-cleanup dentro lo stesso lock;
  RC-3 cleanup-only quando ingestion è disattivata; RC-4 no-op su
  pending assenti.
- `tests/runtime-fallbacks-r6.test.ts` — guardia bilingue: asserisce
  che questa sezione `## R6` sia presente con i campi obbligatori in
  EN e IT in modo speculare.

## R7

## W1.1

**Risk:** `BeforeAgentStartEvent` payload exposes only `phase: string`, not the typed union `unitType`.

### Risk register

| Field | Value |
| ------- | ------- |
| Probability | Low |
| Impact | High |
| Mitigation type | Internal compile-time data (no upstream) |
| PR candidacy | rejected |
| Upstream issue | TBD (zero-PR strategy D102) |

### Current mitigation

Compile-time matrix `ACTIVE_UNIT_TYPES` (frozen) and bijective `PHASE_TO_UNIT_TYPES` declared in `src/phase-mapping.ts:61-91` (`Object.freeze` on the outer record and on each inner `Set`). `phaseToUnitTypes(phase)` (`src/phase-mapping.ts:151-153`) returns the frozen set of active unitTypes for the phase; `unitTypeToArenaGroup(unitType)` (`src/phase-mapping.ts:160-169`) iterates `Object.entries(ACTIVE_UNIT_TYPES)` to determine the arena group. Three properties hold:

- (a) The matrix is FREEZE-d at compile time: `Object.freeze` on `ACTIVE_UNIT_TYPES` and on each inner `Set` prevents runtime mutation.
- (b) A new `unitType` introduced by gsd-pi requires a release bump and a local matrix update — no silent drift (snapshot test guards the shape).
- (c) `unitTypeToArenaGroup` iterates `Object.entries` on `ACTIVE_UNIT_TYPES` and extends automatically when the matrix gains new groups, returning `null` for unit-type outside any arena group.

### Behavioral contract

Discussion arena routing is deterministic even when the `BeforeAgentStartEvent` payload exposes `phase: string` instead of a typed `unitType` union. The local Phase→UnitType matrix is the single source of truth for arena activation; consumers defend against `null` for unit-type outside the arena groups.

### Tests

- `tests/phase-mapping.test.ts` — unit tests on `phaseToUnitTypes` / `unitTypeToArenaGroup` (membership, bijective mapping, unit-type outside groups → `null`).
- `tests/property-phase-mapping.test.ts` — snapshot 24+ on the partition (injectivity, `activeMemberships=20`, coverage of all 6 groups).

## W1.2

**Risk:** `api.getCapabilities()` does not exist on `ExtensionAPI`.

### Risk register

| Field | Value |
| ------- | ------- |
| Probability | Low |
| Impact | High |
| Mitigation type | Internal probe + semver fingerprint |
| PR candidacy | rejected |
| Upstream issue | TBD |

### Current mitigation

The classifier in `src/runtime-classifier.ts` performs a sequential probe on a frozen list of 4 known hooks (`PROBE_HOOKS`, `src/runtime-classifier.ts:89-94`), with `safeProbe` wrapping each call in a `try/catch` (`src/runtime-classifier.ts:139-150`). Tier classification (`classifyRuntime`, `src/runtime-classifier.ts:161-208`) then combines the probes with a `parseSemver(process.env.GSD_VERSION)` version fingerprint. Three properties hold:

- (a) Sequential probe of 4 hooks (deterministic registration order from `PROBE_HOOKS`).
- (b) `parseSemver(process.env.GSD_VERSION)` used as version fingerprint (tolerant of `v` prefix and prerelease/build suffix).
- (c) The returned `capabilities` `Set` is `Object.freeze`-d to prevent downstream mutation.

### Behavioral contract

Tier classification (F/A/D) is available without `api.getCapabilities()`; the runtime is classified by probing its 4 known hooks and fingerprinting the version via `process.env.GSD_VERSION`.

### Tests

- `tests/runtime-classifier.test.ts` section 2 — three F/A/D mocks verify the probe + fingerprint algorithm.

## W1.3

**Risk:** A cross-repo PR proposing a composable `adjust_tool_set` API (`addTools` / `removeTools` methods on the event payload) was rejected; the upstream event exposes only `activeToolNames: string[]` and offers no helpers for delta composition.

### Risk register

| Field | Value |
| ------- | ------- |
| Probability | Low |
| Impact | Medium |
| Mitigation type | Internal idempotent adjust_tool_set hook + deterministic append |
| PR candidacy | rejected |
| Upstream issue | TBD (zero-PR strategy D102) |

### Current mitigation

The `adjust_tool_set` handler is registered inside `attachUnitAwareHooks` (`src/hooks-unit-aware.ts:168-178`) as Hook 2 of the unit-aware registration triplet. When the predicate `isActive()` holds (`forced` decision AND `currentUnitType ∈ options.activeUnitTypes`), the listener spreads `event.activeToolNames` into a fresh array, guards with `Array.prototype.includes` before appending `UNIT_AWARE_TOOL_NAME` (`discussion_arena`), and returns `{ toolNames }` as the event mutation. The extension manifest declares the hook as offered (`extension-manifest.json` → `provides.events` includes `adjust_tool_set`). Three properties hold:

- (a) **Idempotent append via `.includes()` guard** — `[...event.activeToolNames]` followed by `if (!toolNames.includes(UNIT_AWARE_TOOL_NAME)) toolNames.push(UNIT_AWARE_TOOL_NAME)`: a second invocation on the same `unit_start` cycle does NOT duplicate the entry, because the `.includes` check short-circuits the append (no upstream `addTools` API needed).
- (b) **Deterministic activation** — `isActive()` is a pure conjunction (`options.resolveTrigger.decision === "forced" && options.activeUnitTypes.has(currentUnitType)`); the same `(currentUnitType, activeSet, decision)` triple produces the same `{toolNames}` array on every run, in the same insertion order.
- (c) **No upstream `addTools` / `removeTools` API consumed** — composition is performed directly on the event payload (`event.activeToolNames`), not via methods that do not exist upstream; this keeps the handler compatible with the current `ExtensionAPI` shape and makes the contract a local invariant, immune to upstream payload changes that would have broken a method-based composition.

### Behavioral contract

Arena tool composition is deterministic and idempotent without an upstream `addTools`/`removeTools` API: `discussion_arena` is appended to `event.activeToolNames` exactly once per active `(unitType, forced)` tuple, regardless of how many times the framework replays the hook within the same cycle. The order of `toolNames` reflects upstream's existing order plus the appended tool, never a reshuffled list.

### Tests

- `tests/tier-matrix.test.ts` — capability matrix and one-shot idempotency section (T02) verify that repeated calls on the same `(api, unitType)` tuple do not duplicate the `discussion_arena` tool in the resulting tool set.
- `tests/extension-manifest.test.ts` — declares `adjust_tool_set` in `provides.events` (shape anti-drift guard, anti-regression on `phase_change` and on the removed `priority` field per D083).

## W1.4

**Risk:** The `phase_change` event does NOT exist on the `ExtensionAPI.on` API of `gsd-pi` (verified: it does not appear in `vendor/pi-coding-agent/dist/core/extensions/extension-upstream-types.d.ts:821-871` — D084). A naive probe of `phase_change` would silently fall through the `try/catch` and produce a false-negative capability that breaks Tier F classification.

### Risk register

| Field | Value |
| ------- | ------- |
| Probability | High |
| Impact | High |
| Mitigation type | Internal exclude-list do-not-probe |
| PR candidacy | not candidate |
| Upstream issue | TBD (zero-PR strategy D102) |

### Current mitigation

The closed enumeration of probeable hooks is declared in `src/runtime-classifier.ts` as the `CapabilityName` union (the type declaration near line 41-46, JSDoc block) and materialized into a frozen array `PROBE_HOOKS` at `src/runtime-classifier.ts:89-94`. `phase_change` is intentionally excluded from both: the union does not list it, the array does not enumerate it. The `safeProbe(api, event)` helper (`src/runtime-classifier.ts:138-150`) accepts a `CapabilityName` parameter, so passing `"phase_change"` is a TYPE error at compile time, not a runtime silent failure. The JSDoc comment at `src/runtime-classifier.ts:36` (D084) explicitly documents that `phase_change` is NOT a registrable event on `ExtensionAPI.on` and is therefore never probed. Three properties hold:

- (a) **Exclude-list do-not-probe** — `PROBE_HOOKS` includes only 4 known hooks (`before_agent_start`, `adjust_tool_set`, `unit_start`, `tool_call`); `phase_change` is NOT in the list, and adding it would be a TypeScript compile error against the closed `CapabilityName` union (the type alias declaration near line 41-46).
- (b) **Type-level guarantee, not runtime guard** — `safeProbe` accepts only `CapabilityName`, so a contributor who tries `safeProbe(api, "phase_change")` gets a compile-time `Type '"phase_change"' is not assignable to type 'CapabilityName'` error rather than a runtime silent failure; the JSDoc at line 36 (D084) documents the constraint and links it to the verified absence in the upstream `.d.ts`.
- (c) **Tier decisions independent of `phase_change`** — `classifyRuntime` (`src/runtime-classifier.ts:161-208`) derives the tier from the 4-hook probe + `parseSemver(process.env.GSD_VERSION)` fingerprint only; no path in the classifier reads, registers, or schedules a listener for `phase_change`.

### Behavioral contract

Runtime tier classification (F/A/D) is independent of the absence of a `phase_change` event: tier decisions are derived exclusively from the 4 known probeable hooks (`before_agent_start`, `adjust_tool_set`, `unit_start`, `tool_call`) and the `process.env.GSD_VERSION` version fingerprint. The closed `CapabilityName` union prevents accidental probing of `phase_change` (or any other non-existent event) at compile time, eliminating an entire class of silent regressions where a missing event would be indistinguishable from an event rejected at runtime.

### Tests

- `tests/runtime-classifier.test.ts` — section W1.4 (added in T05): asserts that `PROBE_HOOKS` does NOT contain `phase_change`, and that `safeProbe(api, "phase_change" as any)` degrades to `false` via the `try/catch` when a stub `api.on` throws on an unknown event name.
