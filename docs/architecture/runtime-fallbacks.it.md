**Languages:** [English](runtime-fallbacks.md) · [Italiano](runtime-fallbacks.it.md)

[Architecture Reference](index.md) — Runtime fallbacks

# Runtime fallbacks

Questa pagina è lo spazio di atterraggio per i sette fallback runtime
(R1–R7) elencati nella Vision v2 §10 relativamente all'integrazione con
`gsd-pi`. Le sezioni sottostanti sono scheletri volutamente vuoti: saranno
compilate dai milestone che implementano ciascuna mitigazione. Una
intestazione `## Rn` vuota significa "mitigazione non ancora implementata" —
un segnale onesto, mai una chiusura della questione.

## R1

## R2

## R3

## R4

## R5

## R6

**Rischio:** Race tra `writePendingResearch` eseguito dal callback
`discussion_arena.execute` (unità `research-decision`) e l'ingestion su
`milestone_end` (lifecycle hook `attachPendingResearchLifecycleHooks`)
quando più processi operano in concorrenza sullo stesso `<cwd>`.

### Registro del rischio

| Campo | Valore |
| ------- | -------- |
| Probability | Medium |
| Impact | High |
| Mitigation type | Cross-process lock file + serial critical section |
| PR candidacy | candidate |
| Upstream issue | TBD |

### Mitigazione attuale

Lock file `<cwd>/.gsd/discussion-arena/pending-research.lock` con claim
atomico `open(path, "wx")` (POSIX `O_CREAT|O_EXCL`), attesa bounded
(`timeoutMs=5000` di default), stale recovery (`staleAfterMs=30000`),
corrupt recovery, release ownership-safe (rifiuta l'unlink se il lock
corrente ha `(pid, createdAtMs)` diversi dal proprio handle;
idempotente su doppia release), wrapper
`withPendingResearchLock(cwd, fn, opts?)` che garantisce `try/finally`
anche su throw. Le primitive sono esportate da
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
   { stderr })`; il flag `details.pendingResearchWritten` riflette se
   il write ha mutato i file (idempotente per stesso payload).
2. `src/discussion-arena-ingestion.ts` —
   `attachPendingResearchLifecycleHooks(api, options)` registra un
   UNICO listener `milestone_end` che esegue
   `ingestPendingResearch(cwd)` → `cleanupPendingResearch(cwd)` nella
   STESSA sezione critica di `withPendingResearchLock`: l'ingestion
   osserva i file pending, il cleanup li rimuove, un writer successivo
   arriva DOPO il rilascio e non viene rimosso dal cleanup precedente.
   Su `PendingResearchLockTimeoutError` il lifecycle preserva i file
   pending (TTL logico: retry alla prossima `milestone_end` o recovery
   stale-based). Log stderr strutturato con prefisso canonico
   `[discussion-arena]` per acquisizione, attesa (singolo evento,
   niente spam), stale-recovery, corrupt-recovery, timeout e rilascio.

### Contratto comportamentale

Due processi distinti sullo stesso `<cwd>` NON entrano MAI
simultaneamente nella sezione critica del lock. La proprietà è
garantita dal kernel (POSIX `O_CREAT|O_EXCL`), non da primitive
in-process. I log strutturati permettono di diagnosticare
serializzazione, attesa, recovery e timeout senza ispezione manuale
del file system. I fallimenti di estrazione o persistenza restano
non-fatali ma osservabili (`details.pendingResearchWritten === false`
segnala il mancato write senza abortire il tool). Un timeout del
lifecycle preserva i file pending per retry/TTL — la pulizia non viene
forzata a costo di perdita dati.

### Test

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

**Rischio:** Payload `BeforeAgentStartEvent` espone solo `phase: string`, non la union typed `unitType`.

### Registro del rischio

| Campo | Valore |
| ------- | -------- |
| Probability | Low |
| Impact | High |
| Mitigation type | Internal compile-time data (no upstream) |
| PR candidacy | rejected |
| Upstream issue | TBD (zero-PR strategy D102) |

### Mitigazione attuale

Matrice compile-time `ACTIVE_UNIT_TYPES` (congelata) e mapping biiettivo `PHASE_TO_UNIT_TYPES` dichiarati in `src/phase-mapping.ts:61-91` (`Object.freeze` sul record esterno e su ciascun `Set` interno). `phaseToUnitTypes(phase)` (`src/phase-mapping.ts:151-153`) restituisce il set congelato di unitType attivi per la fase; `unitTypeToArenaGroup(unitType)` (`src/phase-mapping.ts:160-169`) itera `Object.entries(ACTIVE_UNIT_TYPES)` per determinare il gruppo della arena. Tre proprietà sono garantite:

- (a) la matrice è FREEZE-d in compile-time: `Object.freeze` su `ACTIVE_UNIT_TYPES` e su ciascun `Set` interno impedisce mutazioni runtime.
- (b) un nuovo `unitType` introdotto da gsd-pi richiede un bump di release e un aggiornamento locale della matrice — niente drift silenzioso (lo snapshot test controlla lo shape).
- (c) `unitTypeToArenaGroup` itera `Object.entries` su `ACTIVE_UNIT_TYPES` e si estende automaticamente quando la matrice acquisisce nuovi gruppi, ritornando `null` per unit-type fuori dai gruppi della arena.

### Contratto comportamentale

Il routing della discussion arena è deterministico anche quando il payload `BeforeAgentStartEvent` espone `phase: string` invece di una union typed `unitType`. La matrice locale Phase→UnitType è la singola fonte di verità per l'attivazione della arena; i consumer difendono da `null` per gli unit-type fuori dai gruppi della arena.

### Test

- `tests/phase-mapping.test.ts` — unit test su `phaseToUnitTypes` / `unitTypeToArenaGroup` (membership, mapping biettivo, unit-type fuori dai gruppi → `null`).
- `tests/property-phase-mapping.test.ts` — snapshot 24+ sulla partizione (iniettività, `activeMemberships=20`, copertura dei 6 gruppi).

## W1.2

**Rischio:** `api.getCapabilities()` non esiste su `ExtensionAPI`.

### Registro del rischio

| Campo | Valore |
| ------- | -------- |
| Probability | Low |
| Impact | High |
| Mitigation type | Internal probe + semver fingerprint |
| PR candidacy | rejected |
| Upstream issue | TBD |

### Mitigazione attuale

Il classifier in `src/runtime-classifier.ts` esegue un probe sequenziale su una lista congelata di 4 hook noti (`PROBE_HOOKS`, `src/runtime-classifier.ts:89-94`), con `safeProbe` che avvolge ciascuna chiamata in `try/catch` (`src/runtime-classifier.ts:139-150`). La classificazione di tier (`classifyRuntime`, `src/runtime-classifier.ts:161-208`) combina i probe con un fingerprint di versione `parseSemver(process.env.GSD_VERSION)`. Tre proprietà sono garantite:

- (a) Probe sequenziale di 4 hook (ordine di registrazione deterministico da `PROBE_HOOKS`).
- (b) `parseSemver(process.env.GSD_VERSION)` come fingerprint di versione (tollerante al prefisso `v` e al suffisso prerelease/build).
- (c) Il `Set` di `capabilities` ritornato è `Object.freeze`-d per impedire mutazioni successive.

### Contratto comportamentale

La classificazione di tier (F/A/D) è disponibile senza `api.getCapabilities()`; il runtime è classificato probeando i suoi 4 hook noti e fingerprintizzando la versione tramite `process.env.GSD_VERSION`.

### Test

- `tests/runtime-classifier.test.ts` sezione 2 — tre mock F/A/D verificano l'algoritmo probe + fingerprint.
