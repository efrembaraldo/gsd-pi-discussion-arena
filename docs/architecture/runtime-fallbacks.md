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
