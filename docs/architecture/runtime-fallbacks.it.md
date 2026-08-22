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

## W1.3

**Rischio:** Una PR cross-repo che proponeva un'API componibile per `adjust_tool_set` (metodi `addTools` / `removeTools` sul payload dell'evento) è stata rifiutata; l'evento upstream espone solo `activeToolNames: string[]` e non offre helper per la composizione in delta.

### Registro del rischio

| Campo | Valore |
| ------- | -------- |
| Probability | Low |
| Impact | Medium |
| Mitigation type | Internal idempotent adjust_tool_set hook + deterministic append |
| PR candidacy | rejected |
| Upstream issue | TBD (zero-PR strategy D102) |

### Mitigazione attuale

L'handler `adjust_tool_set` è registrato in `attachUnitAwareHooks` (`src/hooks-unit-aware.ts:168-178`) come Hook 2 del tripletto di registrazione unit-aware. Quando il predicato `isActive()` è soddisfatto (decisione `forced` E `currentUnitType ∈ options.activeUnitTypes`), il listener copia `event.activeToolNames` in un array fresco, controlla con `Array.prototype.includes` prima di appendere `UNIT_AWARE_TOOL_NAME` (`discussion_arena`) e ritorna `{ toolNames }` come mutazione dell'evento. L'extension manifest dichiara l'hook come offerto (`extension-manifest.json` → `provides.events` include `adjust_tool_set`). Tre proprietà sono garantite:

- (a) **Append idempotente via guard `.includes()`** — `[...event.activeToolNames]` seguito da `if (!toolNames.includes(UNIT_AWARE_TOOL_NAME)) toolNames.push(UNIT_AWARE_TOOL_NAME)`: una seconda invocazione nello stesso ciclo `unit_start` NON duplica la entry, perché il check `.includes` cortocircuita l'append (nessuna API upstream `addTools` necessaria).
- (b) **Attivazione deterministica** — `isActive()` è una congiunzione pura (`options.resolveTrigger.decision === "forced" && options.activeUnitTypes.has(currentUnitType)`); la stessa tripla `(currentUnitType, activeSet, decision)` produce lo stesso array `{toolNames}` a ogni run, nello stesso ordine di inserimento.
- (c) **Nessuna API upstream `addTools` / `removeTools` consumata** — la composizione è eseguita direttamente sul payload dell'evento (`event.activeToolNames`), non tramite metodi inesistenti upstream; questo mantiene l'handler compatibile con l'attuale shape di `ExtensionAPI` e rende il contratto un invariante locale, immune a cambiamenti di payload upstream che avrebbero rotto una composizione basata su metodi.

### Contratto comportamentale

La composizione degli strumenti della arena è deterministica e idempotente senza un'API upstream `addTools`/`removeTools`: `discussion_arena` è accodato a `event.activeToolNames` esattamente una volta per ogni tupla `(unitType, forced)` attiva, indipendentemente da quante volte il framework replichi l'hook nello stesso ciclo. L'ordine di `toolNames` riflette l'ordine esistente upstream più il tool accodato, mai una lista rimescolata.

### Test

- `tests/tier-matrix.test.ts` — sezione T02 idempotenza one-shot e capability matrix verificano che chiamate ripetute sulla stessa tupla `(api, unitType)` non duplicano il tool `discussion_arena` nel set risultante.
- `tests/extension-manifest.test.ts` — dichiara `adjust_tool_set` in `provides.events` (guardia anti-drift di shape, anti-regressione su `phase_change` e sul campo rimosso `priority` per D083).

## W1.4

**Rischio:** L'evento `phase_change` NON esiste sull'API `ExtensionAPI.on` di `gsd-pi` (verificato: non compare in `vendor/pi-coding-agent/dist/core/extensions/extension-upstream-types.d.ts:821-871` — D084). Un probe ingenuo di `phase_change` cadrebbe silenziosamente attraverso il `try/catch`, producendo una capability false-negative che rompe la classificazione Tier F.

### Registro del rischio

| Campo | Valore |
| ------- | -------- |
| Probability | High |
| Impact | High |
| Mitigation type | Internal exclude-list do-not-probe |
| PR candidacy | not candidate |
| Upstream issue | TBD (zero-PR strategy D102) |

### Mitigazione attuale

L'enumerazione chiusa degli hook probeabili è dichiarata in `src/runtime-classifier.ts` come union `CapabilityName` (la dichiarazione del type alias vicino alle righe 41-46, blocco JSDoc) e materializzata in un array congelato `PROBE_HOOKS` a `src/runtime-classifier.ts:89-94`. `phase_change` è intenzionalmente escluso da entrambi: la union non lo elenca, l'array non lo enumera. L'helper `safeProbe(api, event)` (`src/runtime-classifier.ts:138-150`) accetta un parametro `CapabilityName`, quindi passare `"phase_change"` è un errore di TIPO a compile time, non un fallimento silenzioso a runtime. Il commento JSDoc a `src/runtime-classifier.ts:36` (D084) documenta esplicitamente che `phase_change` NON è un evento registrabile su `ExtensionAPI.on` e pertanto non viene mai probeato. Tre proprietà sono garantite:

- (a) **Exclude-list do-not-probe** — `PROBE_HOOKS` include solo 4 hook noti (`before_agent_start`, `adjust_tool_set`, `unit_start`, `tool_call`); `phase_change` NON è nella lista, e aggiungerlo sarebbe un errore di compilazione TypeScript contro la union chiusa `CapabilityName` (la dichiarazione del type alias vicino alle righe 41-46).
- (b) **Garanzia a livello di tipo, non guard runtime** — `safeProbe` accetta solo `CapabilityName`, quindi un contributor che prova `safeProbe(api, "phase_change")` ottiene un errore compile-time `Type '"phase_change"' is not assignable to type 'CapabilityName'` invece di un fallimento silenzioso a runtime; il JSDoc alla riga 36 (D084) documenta il vincolo e lo collega all'assenza verificata nel `.d.ts` upstream.
- (c) **Decisioni di tier indipendenti da `phase_change`** — `classifyRuntime` (`src/runtime-classifier.ts:161-208`) deriva il tier dal probe dei 4 hook + il fingerprint `parseSemver(process.env.GSD_VERSION)`; nessun percorso del classifier legge, registra, o schedula un listener per `phase_change`.

### Contratto comportamentale

La classificazione di tier runtime (F/A/D) è indipendente dall'assenza dell'evento `phase_change`: le decisioni di tier sono derivate esclusivamente dai 4 hook noti probeabili (`before_agent_start`, `adjust_tool_set`, `unit_start`, `tool_call`) e dal fingerprint di versione `process.env.GSD_VERSION`. La union chiusa `CapabilityName` impedisce il probe accidentale di `phase_change` (o di qualsiasi altro evento inesistente) a compile time, eliminando un'intera classe di regressioni silenziose in cui un evento mancante sarebbe indistinguibile da un evento rifiutato a runtime.

### Test

- `tests/runtime-classifier.test.ts` — sezione W1.4 (aggiunta in T05): asserisce che `PROBE_HOOKS` NON contiene `phase_change`, e che `safeProbe(api, "phase_change" as any)` degrada a `false` tramite il `try/catch` quando uno stub `api.on` lancia su un nome di evento sconosciuto.
