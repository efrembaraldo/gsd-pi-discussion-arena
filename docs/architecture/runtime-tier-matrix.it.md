**Lingue:** [English](runtime-tier-matrix.md) · [Italiano](runtime-tier-matrix.it.md)

[Riferimento architetturale](index.it.md) — Matrice dei runtime tier

# Matrice dei runtime tier

`classifyRuntime` (`src/runtime-classifier.ts:161`) è il classificatore
deterministico a due assi che decide se la discussion arena è autorizzata
a **forzare** il proprio tool in una sessione di planning oppure resta
solo in modalità **availability-only**. Questa pagina è il riferimento
canonico della matrice che un operatore consulta quando si chiede "per
questa `Phase` e questo gruppo di unit-type, cosa fa davvero il
runtime?". Tutto ciò che segue è ancorato al sorgente: ogni simbolo e
ogni numero di riga citati qui sono verificati dalla suite
`tests/architecture-refs.test.ts` contro il codice corrente, così un
rename o uno spostamento fa fallire la suite invece di lasciar marcire
questa pagina.

La matrice è la proiezione di due moduli puri su un'unica griglia:

- `src/runtime-classifier.ts` esporta `classifyRuntime`, `parseSemver`,
  la union `RuntimeTier` (`src/runtime-classifier.ts:54`), la union
  `CapabilityName` (`src/runtime-classifier.ts:61`), e congela la tupla
  `PROBE_HOOKS` (`src/runtime-classifier.ts:89`) che guida la sequenza
  di probe.
- `src/phase-mapping.ts` esporta la union `Phase`
  (`src/phase-mapping.ts:23`), il record congelato `ACTIVE_UNIT_TYPES`
  (`src/phase-mapping.ts:61`), il record congelato `PHASE_TO_UNIT_TYPES`
  (`src/phase-mapping.ts:126`), e i due helper di lookup
  `phaseToUnitTypes` (`src/phase-mapping.ts:151`) e
  `unitTypeToArenaGroup` (`src/phase-mapping.ts:160`).

Entrambi i moduli sono puri (D085): nessun I/O, nessuna scrittura su
stderr, nessun side effect osservabile all'import. Gli effetti
collaterali di Tier D (stderr / ledger) vivono nel caller
(`index.ts:activate()`); i moduli si limitano a restituire dati.

## Modello a due assi

Il classificatore è costruito attorno a **due assi indipendenti**,
codificati nella decisione D081. L'albero decisionale in
`classifyRuntime` è abbastanza piccolo che l'intera griglia qui sotto ne
è una proiezione diretta:

- **Asse 1 — fingerprint** — `parseSemver(process.env.GSD_VERSION)`
  restituisce un `ParsedSemver`? È il fingerprint di versione che il
  loader (`gsd-pi/src/loader.ts:141-142`) imposta a ogni run. Un valore
  mancante o malformato porta il runtime a Tier D con reason
  `no_GSD_VERSION` prima ancora che qualsiasi probe venga eseguito.
- **Asse 2 — probe di capability** — i tre hook critici
  (`before_agent_start`, `adjust_tool_set`, `unit_start`) accettano una
  registrazione noop su `api.on(...)`? I probe sono incapsulati in
  `safeProbe`, quindi uno stub che lancia diventa `false` invece di
  propagare l'errore.

`parseSemver` (`src/runtime-classifier.ts:109`) è tollerante per
design: `v1.15.0`, `1.15.0-dev.69075e6e` (la forma reale del
fingerprint gsd-pi), e `1.15` (senza patch, `patch === null`) vengono
tutti parsati. Qualsiasi altro input restituisce `null`, che forza
Tier D indipendentemente dai probe.

Il vettore di capabilities è il `ReadonlySet<CapabilityName>` congelato
restituito insieme al tier; il codice chiamante (gli hook di planning, il
trigger resolver) lo legge invece di riprobare l'API. `tool_call` è
probato ma **non** fa parte della decisione di tier — figura solo in
`capabilities` per osservabilità e gating a valle. L'ordine esatto dei
probe è l'ordine di iterazione di `PROBE_HOOKS`, congelato in cima a
`src/runtime-classifier.ts`.

## Tier F — forcing pieno

Tier F è il percorso felice: il runtime sta operando contro un'istanza
gsd-pi reale la cui API espone ogni hook di cui l'estensione ha bisogno,
e il fingerprint di versione parsa pulito.

| Proprietà | Valore |
| --- | --- |
| Fingerprint (asse 1) | `parseSemver(process.env.GSD_VERSION)` restituisce un `ParsedSemver` |
| Hook critici (asse 2) | `before_agent_start`, `adjust_tool_set`, `unit_start` restituiscono tutti `true` da `safeProbe` |
| `reasons` restituito da `classifyRuntime` | `[]` (vuoto) |
| `capabilities` restituito | un `Set` congelato contenente tutte e quattro le entry di `PROBE_HOOKS` |
| Comportamento degli hook di planning | la condizione congiunta è soddisfatta per ogni cella `(Phase, group)` attiva: la discussion arena viene **forzata**, l'istruzione di planning viene iniettata |
| Side effect del caller (`index.ts:activate()`) | nessuno oltre la normale invocazione di `attachDiscussionArenaHooks` |

Tier F è l'unico tier in cui ogni cella della matrice nella sezione
successiva ha senso: il runtime è onesto su ogni capability che
pubblicizza, quindi ci si può fidare che la discussion arena intervenga
senza sopprimere gli altri tool.

## Tier A — availability-only (senza `unit_start`)

Tier A è la norma operativa su gsd-pi **oggi**: i due hook sincroni
(`before_agent_start`, `adjust_tool_set`) accettano un noop, il
fingerprint di versione parsa, ma `unit_start` no. La nota di ricerca
che lo avvalla è in M010-RESEARCH.md §3: `emitUnitStart` non ha call-site
in `gsd-pi/dist`, quindi anche se il runtime pubblicizza l'hook, la
chiamata non parte mai.

| Proprietà | Valore |
| --- | --- |
| Fingerprint (asse 1) | `parseSemver(process.env.GSD_VERSION)` restituisce un `ParsedSemver` |
| Hook critici (asse 2) | `before_agent_start` e `adjust_tool_set` accettano; `unit_start` rifiuta (o lancia dentro `safeProbe`) |
| `reasons` restituito da `classifyRuntime` | `["no_unit_start"]` |
| `capabilities` restituito | un `Set` congelato contenente solo i due hook sincroni di `PROBE_HOOKS` |
| Comportamento degli hook di planning | la discussion arena è **availability-only**: il tool è chiamabile, ma non viene esposto come forzato nella sessione di planning |
| Side effect del caller (`index.ts:activate()`) | `recordDegraded({ reason: "no_unit_start" })` una volta; nessuna scrittura one-shot su stderr |

L'etichetta `A` per "Available" è scelta apposta per distinguerla da F
(Full) e D (Degraded): Tier A **non** è un failure mode, è la realtà
operativa del gsd-pi corrente, e il runtime continua a guidare
normalmente ogni altro meccanismo (probe di capability, phase tracking,
iniezione dell'istruzione di planning sugli hook supportati).

## Tier D — degradato (tutto il resto)

Tier D è il catch-all: qualunque reason che disqualifichi il runtime da
F o A atterra qui. Il classificatore accumula le reason in modo
cumulativo, quindi una singola esecuzione può produrre più entry; il
caller (`index.ts:activate()`) emette una riga one-shot su stderr **e**
chiama `recordDegraded` per ciascuna.

| Proprietà | Valore |
| --- | --- |
| Fingerprint (asse 1) | mancante (`process.env.GSD_VERSION` non impostato) o malformato (`parseSemver` restituisce `null`) — la reason `no_GSD_VERSION` viene accodata |
| Hook critici (asse 2) | almeno uno tra `before_agent_start` / `adjust_tool_set` rifiuta; se entrambi accettano ma `unit_start` rifiuta, il classificatore cade comunque in D solo perché il ramo F sopra non è soddisfatto (la transizione F→A è gated sull'accettazione di entrambi gli hook sincroni) |
| `reasons` restituito da `classifyRuntime` | `["no_GSD_VERSION"]` e/o `["no_before_agent_start"]`, `["no_adjust_tool_set"]`, `["no_unit_start"]`, nell'ordine in cui vengono rilevati |
| `capabilities` restituito | un `Set` congelato contenente esattamente gli hook che hanno accettato; può essere vuoto |
| Comportamento degli hook di planning | la discussion arena è completamente bypassata; nessun tool viene aggiunto, nessuna istruzione viene iniettata |
| Side effect del caller (`index.ts:activate()`) | una riga stderr strutturata per ciascuna reason, una `recordDegraded({ reason, ... })` per ciascuna reason, deduplicata |

`runtime-classifier.ts` di per sé non scrive mai su stderr e non chiama
mai `recordDegraded`: è una funzione pura che restituisce un risultato
strutturato. È questo che permette alla suite di test di esercitare
ogni combinazione senza mockare `console.error` o i contatori di
`recordDegraded`.

## Matrice 18-fasi × 6-gruppi

La matrice qui sotto è la proiezione di `PHASE_TO_UNIT_TYPES` sui sei
gruppi di `ACTIVE_UNIT_TYPES`. Ci sono esattamente **18 fasi** nella
union `Phase` (`src/phase-mapping.ts:23`) ed esattamente **6 gruppi**
in `ACTIVE_UNIT_TYPES` (`src/phase-mapping.ts:61`); il mapping
biettivo è ciò che produce le sei celle "force".

Sintassi delle celle:

- `force` — la discussion arena è forzata nella sessione: per qualunque
  `unitType` che appartiene a questo gruppo, `phaseToUnitTypes(phase)`
  restituisce un `Set` congelato contenente la chiave del gruppo, e gli
  hook di planning valutano la condizione congiunta `currentPhase ===
  phase && resolveTrigger.decision === "forced"`.
- `availability-only` — `phaseToUnitTypes(phase)` restituisce il set
  condiviso vuoto `EMPTY_UNIT_TYPES` oppure un `Set` congelato di un
  *altro* gruppo: la discussion arena è raggiungibile come tool
  chiamabile ma non viene esposta come forzata per nessun `unitType`
  di questo gruppo in questa fase.
- `n/a` — la fase non è una delle sei fasi "attive" di
  `PHASE_TO_UNIT_TYPES`; `phaseToUnitTypes(phase)` restituisce il set
  condiviso vuoto e nessun `unitType` di questo gruppo passa mai
  attraverso la discussion arena mentre la sessione si trova in questa
  fase.

| `Phase` ↓ / Gruppo → | `research-decision` | `research` | `discussing` | `planning` | `executing` | `verifying` |
| --- | --- | --- | --- | --- | --- | --- |
| `pre-planning` | n/a | n/a | n/a | n/a | n/a | n/a |
| `needs-discussion` | n/a | n/a | n/a | n/a | n/a | n/a |
| `discussing` | availability-only | availability-only | **force** | availability-only | availability-only | availability-only |
| `researching` | **force** | availability-only | availability-only | availability-only | availability-only | availability-only |
| `planning` | availability-only | availability-only | availability-only | **force** | availability-only | availability-only |
| `refining` | availability-only | **force** | availability-only | availability-only | availability-only | availability-only |
| `evaluating-gates` | n/a | n/a | n/a | n/a | n/a | n/a |
| `executing` | availability-only | availability-only | availability-only | availability-only | **force** | availability-only |
| `verifying` | availability-only | availability-only | availability-only | availability-only | availability-only | **force** |
| `summarizing` | n/a | n/a | n/a | n/a | n/a | n/a |
| `advancing` | n/a | n/a | n/a | n/a | n/a | n/a |
| `validating-milestone` | n/a | n/a | n/a | n/a | n/a | n/a |
| `completing-milestone` | n/a | n/a | n/a | n/a | n/a | n/a |
| `replanning-slice` | n/a | n/a | n/a | n/a | n/a | n/a |
| `escalating-task` | n/a | n/a | n/a | n/a | n/a | n/a |
| `complete` | n/a | n/a | n/a | n/a | n/a | n/a |
| `paused` | n/a | n/a | n/a | n/a | n/a | n/a |
| `blocked` | n/a | n/a | n/a | n/a | n/a | n/a |

Ci sono esattamente **sei celle "force"** — una per fase attiva — e
**12 righe "n/a"** per le fasi inattive (`pre-planning`,
`needs-discussion`, `evaluating-gates`, `summarizing`, `advancing`,
`validating-milestone`, `completing-milestone`, `replanning-slice`,
`escalating-task`, `complete`, `paused`, `blocked`). Tutte e 12 le fasi
mappano al set condiviso vuoto `EMPTY_UNIT_TYPES`, ed è per questo che
la riga è interamente `n/a` invece di un misto di `availability-only`
e `n/a`.

Le 30 celle `availability-only` (5 per fase attiva × 6 fasi attive)
sono le celle in cui la discussion arena **potrebbe** intervenire se
la sessione capitasse nella giusta combinazione di `unitType` e
gruppo, ma il design biettivo di `PHASE_TO_UNIT_TYPES` rende ciò
impossibile per costruzione.

## Mapping 20 unit-type → gruppo

Sotto c'è la tabella che il runtime usa quando la sessione arriva
effettivamente a un unit-type. `unitTypeToArenaGroup`
(`src/phase-mapping.ts:160`) percorre `Object.entries(ACTIVE_UNIT_TYPES)`
e restituisce la **chiave** del gruppo il cui `Set` congelato contiene
l'unit-type, oppure `null` se l'unit-type non è in nessuno dei sei
gruppi.

La tabella elenca **20 active memberships** (`activeMemberships === 20`
nel test combinatorio `tests/property-phase-mapping.test.ts`):

| Gruppo | `unitType` (chiave restituita da `unitTypeToArenaGroup`) |
| --- | --- |
| `research-decision` | `research-decision` |
| `research` | `research-milestone` |
| `research` | `research-project` |
| `research` | `research-slice` |
| `discussing` | `discuss-milestone` |
| `discussing` | `discuss-project` |
| `discussing` | `discuss-requirements` |
| `planning` | `plan-milestone` |
| `planning` | `plan-slice` |
| `planning` | `refine-slice` |
| `planning` | `replan-slice` |
| `planning` | `replan-task` |
| `planning` | `gate-evaluate` |
| `executing` | `execute-task` |
| `executing` | `reactive-execute` |
| `executing` | `run-uat` |
| `executing` | `reassess-roadmap` |
| `verifying` | `validate-milestone` |
| `verifying` | `complete-milestone` |
| `verifying` | `complete-slice` |

`unitTypeToArenaGroup` è totale sul tipo stringa: ogni possibile input
restituisce o una chiave di `ACTIVE_UNIT_TYPES` o `null`. L'helper è
invocato da `trigger-resolver.ts` (vedi la pagina *Risoluzione del
trigger*) per popolare `ResolveTriggerOutput.groupEligibility`, che gli
hook di planning leggono prima di decidere se esporre il tool come
forzato.

## Esclusioni by-design

Il record `ACTIVE_UNIT_TYPES` partiziona esattamente **24** unit-type
"primari" di gsd-pi (per D102). Di questi 24, **20** sono mappati a un
gruppo e **4** sono intenzionalmente esclusi:

| `unitType` escluso | Motivo |
| --- | --- |
| `quick-task` | variante operativa; il prompt deliberativo la rallenterebbe senza aggiungere struttura |
| `rewrite-docs` | riscrittura di documentazione; la discussion arena non è il produttore di artefatti giusto per questa superficie |
| `triage-captures` | variante di triage dell'inbox; il deliverable è un insieme di decisioni, non un piano |
| `workflow-preferences` | variante di preferenze utente; non deve essere gated dietro alcuna deliberazione |

Per questi quattro unit-type, `unitTypeToArenaGroup` restituisce `null`
(l'input non è in nessun `Set` congelato), gli hook di planning vedono
`groupEligibility === null`, e la condizione congiunta
`currentPhase === phase && resolveTrigger.decision === "forced"`
corta-circuitca senza forzare la discussion arena nella sessione. Il
tool di per sé resta registrato e chiamabile: un operatore `quick-task`
che vuole la discussion arena può ancora invocarlo esplicitamente.

L'invariante combinatorio (`tests/property-phase-mapping.test.ts`)
impone `activeMemberships === 20` (non 24) e la disgiunzione della
partizione; rinominare uno dei quattro unit-type esclusi o aggiungere
una quinta esclusione è dunque un **cambio breaking** per quel test,
che è il pavimento di sicurezza desiderato.

## Come funziona in pratica

Tre esempi svolti — uno per tier — mostrano come la matrice collassa in
una decisione di runtime. Ogni esempio parte da un
`process.env.GSD_VERSION` fresco e da uno stub `ExtensionAPI` fresco.

### Tier F — forcing pieno nella fase di planning

`process.env.GSD_VERSION` è `"v1.15.0-dev.69075e6e"`; l'API del
runtime espone tutti e tre gli hook critici. `parseSemver` restituisce
`{ major: 1, minor: 15, patch: 0 }`; `safeProbe` restituisce `true` per
ciascuna entry di `PROBE_HOOKS`. Il classificatore restituisce:

```text
{ tier: "F", capabilities: {before_agent_start, adjust_tool_set, unit_start, tool_call}, reasons: [] }
```

Quando la sessione entra nella fase `planning` con
`unitType = "plan-milestone"`, l'hook di planning legge
`groupEligibility = "planning"` da `unitTypeToArenaGroup`, la decisione
di trigger è `forced`, e la condizione congiunta è soddisfatta: il tool
della discussion arena viene aggiunto all'active tool set e
l'istruzione di planning viene iniettata.

### Tier A — availability-only nella fase di discussing

`process.env.GSD_VERSION` è `"1.15.0-dev.69075e6e"`; l'API del runtime
espone `before_agent_start` e `adjust_tool_set` ma **non** `unit_start`.
`parseSemver` restituisce lo stesso `ParsedSemver`; i due probe sincroni
restituiscono `true`; il probe `unit_start` restituisce `false` (o
lancia). Il classificatore restituisce:

```text
{ tier: "A", capabilities: {before_agent_start, adjust_tool_set}, reasons: ["no_unit_start"] }
```

Quando la sessione entra nella fase `discussing` con
`unitType = "discuss-milestone"`, la condizione congiunta
`currentPhase === "planning" && resolveTrigger.decision === "forced"`
vale `false` (la fase non è `planning`). La discussion arena resta
disponibile come tool chiamabile ma non viene esposta come forzata, e
il call-site la invoca esplicitamente invece che tramite il percorso di
forced-injection.

### Tier D — degradato perché il fingerprint manca

`process.env.GSD_VERSION` non è impostato; l'API del runtime espone solo
`tool_call`. `parseSemver` restituisce `null`; solo il probe `tool_call`
restituisce `true`. Il classificatore restituisce:

```text
{ tier: "D", capabilities: {tool_call}, reasons: ["no_GSD_VERSION"] }
```

Il caller (`index.ts:activate()`) emette una riga stderr strutturata
prefissata con `[discussion-arena]` e chiama `recordDegraded({ reason:
"no_GSD_VERSION", ... })` una volta. Gli hook di planning non vengono
attaccati: nessun tool viene aggiunto, nessuna istruzione viene
iniettata. Il tool della discussion arena di per sé può comunque essere
registrato (quella decisione la prende il trigger resolver, non il
classificatore), ma nessun unit-type di alcun gruppo viene forzato
attraverso di esso per questa run.

## Perché questo è puro

Sia `classifyRuntime` sia gli helper di `phase-mapping` sono funzioni
pure sui loro input. Il classificatore legge `process.env.GSD_VERSION`
direttamente (l'unica dipendenza ambiente), ma non scrive mai nulla
indietro: nessun `console.error`, nessun `recordDegraded`, nessun I/O.
`phaseToUnitTypes` e `unitTypeToArenaGroup` sono lookup puri su record
congelati. È questo che permette alla suite di esercitare ogni
combinazione senza un'implementazione reale di `ExtensionAPI`, e che
permette di ragionare sulla matrice qui sopra come una proiezione
statica.

Il caller in `index.ts:activate()` è responsabile degli effetti
collaterali: consuma l'array `reasons`, deduplica le chiamate a
`recordDegraded` e scrive la riga stderr strutturata una volta per
sessione. Separare "decidi" da "riporta" è ciò che tiene
`runtime-classifier.ts` sotto le cinquanta righe logiche e
`phase-mapping.ts` sotto le cento, e che tiene questa pagina sotto le
duecento righe senza perdere fedeltà.

## Documentazione correlata

- [Riferimento architetturale](index.it.md) — indice del riferimento
  interno
- [Risoluzione del trigger](trigger-resolution.it.md) — come
  `forced` / `availability-only` viene deciso da `groupEligibility` e
  dal tier
- [Hook di planning](hooks.it.md) — la condizione congiunta
  `currentPhase === "planning" && resolveTrigger.decision === "forced"`
- [Limiti di runtime](runtime-limits.it.md) — i ceiling che si
  applicano a ogni tier (numero di round, lunghezza del transcript,
  pannello dei partecipanti)
- [Flusso di invocazione](invocation-flow.it.md) — quando
  `classifyRuntime` viene chiamato durante `activate`
- [Sottoprocessi dei partecipanti](participant-subprocesses.it.md) —
  come la discussion arena viene lanciata una volta noto il tier
- [Orchestrazione dei round](round-orchestration.it.md) — come i round
  e il transcript dello Scribe vengono assemblati
- [Flusso research-decision](research-decision-flow.it.md) — la
  pipeline canonica che consuma l'output di Tier F / A / D
