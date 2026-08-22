**Languages:** [English](runtime-fallbacks.md) · [Italiano](runtime-fallbacks.it.md)

[Architecture Reference](index.md) — Runtime fallbacks

# Runtime fallbacks

Questa pagina è lo spazio di atterraggio per i sette fallback runtime
(R1–R7) elencati nella Vision v2 §10 relativamente all'integrazione con
`gsd-pi`. Le sezioni sottostanti seguono lo stesso template: una riga che
inquadra il rischio, una tabella **Registro del rischio** con i cinque
campi canonici (Probability, Impact, Mitigation type, PR candidacy,
Upstream issue), un paragrafo **Mitigazione attuale** che ancora ogni
affermazione a un file sorgente esistente, un paragrafo **Contratto
comportamentale** che elenca gli invarianti rispettati dal runtime, e
una lista puntata **Test** che cita file di test presenti su disco.
Alla data attuale:

- R1 — Popolata (meta-rischio ombrello della strategia zero-PR; le
  cinque mitigazioni per-gap vivono nelle sezioni `## W1.1` attraverso
  `## W1.5` sotto).
- R2 — Popolata (matrice Phase → UnitType congelata in
  `src/phase-mapping.ts`).
- R3 — Popolata (probe Tier F/A/D in `src/runtime-classifier.ts` + stderr
  one-shot + counter).
- R4 — Scheletro (lavoro appartiene a un milestone separato).
- R5 — Scheletro.
- R6 — Popolata (lock cross-process; S01).
- R7 — Scheletro.

Una sezione `## Rn` il cui corpo termina subito prima dell'header
successivo è un placeholder onesto "non ancora implementato" — mai una
chiusura della questione. Per il riassunto lato utente vedi
[README.it.md](../../README.it.md), nello specifico [Limiti
noti](../../README.it.md#limiti-noti) e [Gap di integrazione con
gsd-pi](../../README.it.md#gap-di-integrazione-con-gsd-pi-vision-v2-2);
la controparte inglese è all'indirizzo
[English](runtime-fallbacks.md).

## R1

**Rischio:** Tutte le cinque PR cross-repo su `gsd-pi` proposte nella
Vision v2 §4 (i workaround `W1.1`–`W1.5` documentati sotto) sono state
rifiutate dall'upstream; la superficie API che renderebbe banale
un'integrazione deterministica e forzata non è disponibile oggi, e
l'attesa di una singola PR è stata rifiutata come strategia. La
strategia zero-PR (D102) vincola l'estensione ad assorbire ogni gap
localmente invece di attendere l'upstream.

### Registro del rischio

| Campo | Valore |
| ------- | -------- |
| Probability | Low |
| Impact | Medium |
| Mitigation type | Internal local workaround per gap (zero-PR strategy D102) |
| PR candidacy | rejected |
| Upstream issue | TBD |

### Mitigazione attuale

Il rischio è di meta-livello: cattura il fatto che ogni gap W1.x debba
essere assorbito localmente perché l'upstream non ha accettato nessuna
delle cinque proposte. Le cinque mitigazioni concrete vivono nelle
sezioni `W1.1` attraverso `W1.5` qui sotto — ciascuna sezione è
verificata dalla propria suite di test (vedi quelle sezioni per
mitigazione, contratto e test specifici per gap). Questa sezione `R1`
deliberatamente NON ri-dichiara i dettagli per-PR per evitare di
inventare fatti upstream non verificati; è l'ombrello che tiene insieme
i workaround W1.x sotto l'impegno zero-PR.

### Contratto comportamentale

L'estensione raggiunge una classificazione Tier F/A/D deterministica
senza che alcuna PR cross-repo venga accettata, combinando le
mitigazioni locali per-gap in `W1.1` attraverso `W1.5`. La
classificazione di tier è esposta via `classifyRuntime` in
`src/runtime-classifier.ts`; il counter
`discussion_arena_forced_total{phase}` registra ogni runtime che
effettivamente forza l'arena, e `discussion_arena_degraded_total{reason}`
registra il motivo di ogni attivazione Tier D.

### Test

- `tests/runtime-fallbacks-w1.test.ts` — guardia bilingue per `W1.1`
  attraverso `W1.5` (presenza, contenuto, i cinque campi canonici, la
  lista di termini canonici per W1.x, path di test su disco).
- `tests/runtime-fallbacks-r6.test.ts` — guardia bilingue per la
  sezione `R6` (lock cross-process) già popolata; fissa la mitigazione
  S01 da cui uno dei workaround W1.x può dipendere.
- `tests/runtime-classifier.test.ts` — fissa il contratto Tier F/A/D
  di cui l'ombrello comportamentale di `R1` in definitiva dipende.

## R2

**Rischio:** Il payload esposto da `gsd-pi` per l'hook pre-agent
obbligatorio porta solo `phase: string` (nessuna union typed
`unitType`), quindi l'arena non può consumare direttamente un unit-type
strutturato per decidere quale gruppo di `ACTIVE_UNIT_TYPES` è attivo.
Uno `switch` ingenuo su `event.phase` andrebbe in drift quando
`gsd-pi` aggiunge una nuova fase o cadrebbe silenziosamente su
"unknown" tramite un catch che assorbe l'errore.

### Registro del rischio

| Campo | Valore |
| ------- | -------- |
| Probability | Low |
| Impact | High |
| Mitigation type | Internal compile-time matrix (no upstream) |
| PR candidacy | rejected (zero-PR strategy D102) |
| Upstream issue | TBD |

### Mitigazione attuale

Matrice compile-time `ACTIVE_UNIT_TYPES` (congelata al module load via
`Object.freeze`) e il record biiettivo `PHASE_TO_UNIT_TYPES` dichiarati
in `src/phase-mapping.ts`. I due helper puri sono l'unica fonte di
verità per l'attivazione della arena:

- `phaseToUnitTypes(phase)` ritorna il set congelato di unitType attivi
  per la fase, o il `Set` vuoto condiviso per le fasi non mappate.
- `unitTypeToArenaGroup(unitType)` itera
  `Object.entries(ACTIVE_UNIT_TYPES)` e ritorna la chiave del gruppo
  il cui set contiene `unitType`, o `null` quando l'unit-type è fuori
  da ogni gruppo della arena.

Aggiungere un nuovo `unitType` in `gsd-pi` richiede un bump di release
e un aggiornamento locale della matrice — il drift silenzioso è
bloccato dal test property-based che asserisce lo snapshot contro i 24
unit-type primary di `gsd-pi`.

### Contratto comportamentale

Il routing del tool `discussion_arena` è deterministico anche quando
il payload upstream espone solo `phase: string`. I consumer (es. il
counter `discussion_arena_forced_total{phase}`) difendono da `null`
per gli unit-type fuori dai gruppi della arena, e `phaseToUnitTypes`
ritorna il `Set` vuoto condiviso per le fasi non mappate così la
modalità di fallimento è sempre "nessun unit type attivo" invece di
un'eccezione lanciata.

### Test

- `tests/phase-mapping.test.ts` — unit test su `phaseToUnitTypes` e
  `unitTypeToArenaGroup` (appartenenza, mapping biettivo, strutture
  congelate, casi negativi).
- `tests/property-phase-mapping.test.ts` — test combinatorio
  property-based contro i 24 unit-type primary di `gsd-pi`: sweep in
  avanti (432 coppie = 18 fasi × 24 unit-type), sweep inverso,
  iniettività, e snapshot contro il catalogo canonico.

## R3

**Rischio:** Il classificatore runtime potrebbe classificare
silenziosamente il runtime `gsd-pi` come pienamente capace (Tier F)
quando uno o più degli hook critici manca, producendo un'iniezione
"forzata" che non raggiunge mai l'agente. La mitigazione deve essere
sia deterministica (probe sub-millisecondo) sia osservabile (un segnale
stderr one-shot più un counter così il downstream può attribuire la
decisione forced-vs-degraded).

### Registro del rischio

| Campo | Valore |
| ------- | -------- |
| Probability | Medium |
| Impact | High |
| Mitigation type | Internal probe + semver fingerprint + one-shot stderr + counter |
| PR candidacy | rejected (zero-PR strategy D102) |
| Upstream issue | TBD |

### Mitigazione attuale

Il classificatore in `src/runtime-classifier.ts` esegue un probe
sequenziale su una lista congelata di hook noti. Ogni probe è avvolto
da un `try/catch` così un listener stub che lancia degrada a `false`
senza propagare. Il tier è poi derivato dalla combinazione dei
risultati dei probe e da un fingerprint `parseSemver` di
`process.env.GSD_VERSION`:

- Tier F: semver valido + i tre probe core di presenza ritornano tutti `true`.
- Tier A: semver valido + due dei tre probe core ritornano `true`.
- Tier D: fingerprint mancante o qualsiasi probe critico mancante.

I side-effect (il warning Tier D e l'incremento della metrica) vivono
nel caller — gli hook di registro bundled con l'estensione — non nel
modulo classificatore stesso:

- `emitDeprecationWarningOnce` (riusato da `src/deprecation.ts` via il
  pattern di dedup one-shot) emette la riga `[discussion-arena
  DEGRADED]` ESATTAMENTE una volta per processo per le attivazioni
  Tier D.
- `recordDegraded(reason)` incrementa
  `discussion_arena_degraded_total{reason=<code>}` per ciascun
  motivo nell'array del risultato del classificatore (una voce per
  ogni probe mancante, OPPURE `no_GSD_VERSION` quando il fingerprint
  manca).

### Contratto comportamentale

Il classificatore è una funzione pura sincrona: non scrive mai su
stderr, non chiama mai `recordDegraded`, non scrive mai una riga di
log strutturato. I suoi unici input sono il riferimento dell'estensione
(usato solo per invocare il listener via il wrapper safe-probe) e
`process.env.GSD_VERSION` (parsato via `parseSemver`). Il wall-clock
totale è sub-millisecondo. Il risultato è bit-identico tra invocazioni
ripetute sulla stessa coppia `(api, env)`. Tier F/A/D è deciso una
volta al momento dell'attivazione del registro; il warning Tier D a
valle e l'incremento del counter sono one-shot per processo.

### Test

- `tests/runtime-classifier.test.ts` — casi `parseSemver` (positivi e
  negativi), i tre scenari canonici F/A/D, casi limite (stub senza
  alcun listener, determinismo su doppia chiamata, purezza), e le
  spie end-to-end del probe chiuso per gli eventi che l'upstream non
  emette.
- `tests/index.test.ts` (sezione wiring del registro) — test di
  cablaggio che asseriscono il comportamento Tier D del caller:
  stderr ESATTAMENTE una riga `[discussion-arena DEGRADED]` con i
  corretti campi `reason:`, gli incrementi `recordDegraded`
  corrispondenti per ciascun motivo, e il fatto che due attivazioni
  con Tier D producano solo una riga stderr (dedup one-shot).
- `tests/metrics.test.ts` — unit test di `recordDegraded(reason)`
  (incremento del counter, serie per-reason, additivo tra reason).

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

## W1.5

**Rischio:** L'API `api.getState()` NON esiste sull'interfaccia `ExtensionAPI` di `gsd-pi` (verificato: non compare in `vendor/pi-coding-agent/dist/core/extensions/extension-upstream-types.d.ts:821-871` — D084). Un caller ingenuo che richiedesse una query di stato per classificare il runtime fallirebbe a compile time contro il tipo `ExtensionAPI` o bloccherebbe su un'API di stato asincrona inesistente, rompendo il percorso di classificazione sincrono sub-millisecondo da cui dipendono le decisioni Tier F/A/D al momento di `activate()`.

### Registro del rischio

| Campo | Valore |
| ------- | -------- |
| Probability | Low |
| Impact | High |
| Mitigation type | Internal synchronous probe no state query |
| PR candidacy | not candidate |
| Upstream issue | TBD (zero-PR strategy D102) |

### Mitigazione attuale

`classifyRuntime` (`src/runtime-classifier.ts:161-208`) è una funzione pura sincrona i cui input sono il riferimento a `ExtensionAPI` (usato solo per invocare `api.on(...)` tramite `safeProbe`) e `process.env.GSD_VERSION` (parsato da `parseSemver` a `src/runtime-classifier.ts:109-138`). La funzione non chiama mai `api.getState(...)` — quel metodo non esiste sull'interfaccia upstream `ExtensionAPI`, e aggiungerlo sarebbe un errore di compilazione TypeScript. L'algoritmo di classificazione completa in un singolo passaggio sincrono: parse del semver tramite `parseSemver`, probe dei 4 hook tramite `safeProbe` (`src/runtime-classifier.ts:139-150`), congelamento del `ReadonlySet` delle capabilities, e ritorno del risultato immutabile. Il wall-clock totale è sub-millisecondo, misurato contro uno stub `api.on` che accetta sempre, senza query di stato asincrone né hop sull'event loop. Tre proprietà sono garantite:

- (a) **Pura, sincrona, sub-millisecondo** — `classifyRuntime` non ha punti `await`, nessuna allocazione di `Promise`, e nessun I/O; `parseSemver` (`src/runtime-classifier.ts:109-138`) è un match regex letterale, e `safeProbe` (`src/runtime-classifier.ts:139-150`) è un `try/catch` sincrono attorno a `api.on(...)`. La signature ritorna un `ClassifyRuntimeResult` completamente popolato in una singola chiamata sincrona, non un `Promise<ClassifyRuntimeResult>`.
- (b) **Nessuna chiamata `api.getState`** — `classifyRuntime` non invoca mai `api.getState(...)` (il metodo non esiste su `ExtensionAPI`); gli unici metodi chiamati sul riferimento `api` sono `api.on(...)` tramite `safeProbe`. Aggiungere `api.getState(...)` al corpo della funzione sarebbe un errore di compilazione TypeScript contro il tipo upstream e romperebbe anche il contratto sincrono sub-millisecondo introducendo un'ipotetica query di stato asincrona.
- (c) **Bit-identica tra run al activate** — poiché `classifyRuntime` legge solo `process.env.GSD_VERSION` (congelato all'avvio del processo) e il comportamento di registrazione live di `api.on(...)` del runtime gsd-pi (stabile per tutta la vita del processo), il risultato per una data coppia `(api, env)` è identico tra invocazioni ripetute nello stesso processo e tra processi avviati con lo stesso env. Le decisioni di tier sono calcolate una volta al momento di `activate()` e consumate downstream tramite `ResolveTriggerInput` (T03); nessun percorso richiede lo stato durante il ciclo di vita della richiesta.

### Contratto comportamentale

La classificazione di tier (F/A/D) è deterministica e bit-identica tra run senza un'API upstream `api.getState()`: `classifyRuntime` sincrono sub-millisecondo deriva le decisioni di tier esclusivamente da `parseSemver(process.env.GSD_VERSION)` e dal passaggio di `safeProbe` sui quattro hook dell'interfaccia `ExtensionAPI.on(...)`. Il risultato è catturato una volta al momento di `activate()` dell'estensione, congelato in un `ReadonlySet` di capabilities più un array `readonly` di reasons, e propagato downstream tramite `ResolveTriggerInput` senza richiedere lo stato. L'assenza di `api.getState(...)` sull'interfaccia upstream è irrilevante per il percorso di classificazione runtime perché il classifier non ha mai richiesto introspezione di stato — opera interamente su fingerprint statico più probe di capability.

### Test

- `tests/runtime-classifier.test.ts` — sezione W1.5 (aggiunta in T05): stub di `ExtensionAPI` con spy `methodCalls: string[]`, invoca `classifyRuntime(api)`, e asserisce che `api.getState` è stato chiamato 0 volte (il metodo non esiste sullo stub, e qualsiasi tentativo di chiamata o lancerebbe alla type-check o sarebbe escluso dallo spy — in entrambi i casi l'asserzione conferma che il classifier non richiede introspezione di stato).
