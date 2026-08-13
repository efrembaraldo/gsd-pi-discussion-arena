**Lingue:** [English](runtime-limits.md) · [Italiano](runtime-limits.it.md)

[Riferimento architetturale](index.it.md) — Limiti runtime

# Limiti runtime

Questa pagina documenta i limiti che delimitano una run della
discussion arena: tre costanti rigide a livello di motore
(`index.ts:105-107`), un insieme di limiti a livello partecipante con i
loro default (`helpers.ts:85-91`) e i punti di enforcement in cui
ciascuno di essi interviene davvero. Tutto ciò che è citato in questa
pagina è ancorato al sorgente: ogni simbolo, riga e valore citato qui è
verificato contro il codice attuale da `tests/architecture-refs.test.ts`,
quindi un rename di una costante o uno spostamento di funzione fa
fallire la suite invece di lasciare che questa pagina marcisca in
silenzio.

## Le tre costanti rigide (`index.ts:105-107`)

| Costante | Valore | Cosa delimita |
| --- | --- | --- |
| `MAX_PARTICIPANTS` | `8` | numero di partecipanti selezionati in una singola run |
| `MAX_ROUNDS` | `5` | numero di round di discussione per run |
| `DEFAULT_ROUNDS` | `2` | numero di round usato quando niente altro lo sovrascrive |

```ts
export const MAX_PARTICIPANTS = 8;
export const MAX_ROUNDS = 5;
export const DEFAULT_ROUNDS = 2;
```

La suite importa questi tre valori dal modulo reale e ne asserisce i numeri
(8, 5, 2) contro `index.ts:105-107`, quindi la documentazione non può
allontanarsi in silenzio dal codice.

`MAX_PARTICIPANTS` e `MAX_ROUNDS` sono soffitti: i default sono più bassi
dei cap, e ogni entry point converge sugli stessi valori cappati (vedi
*Punti di enforcement* sotto). `DEFAULT_ROUNDS` è ciò che una run usa
quando non c'è né un conteggio esplicito, né un flag di comando, né un
default di coordinamento.

## Limiti a livello partecipante: `DEFAULT_PARTICIPANT_LIMITS` (`helpers.ts:85-91`)

Ogni turno di un partecipante è inoltre delimitato da cinque limiti, i cui
default sono un'unica costante:

```ts
export const DEFAULT_PARTICIPANT_LIMITS: ResolvedLimits = {
  roundTimeoutMs: 300_000,
  eventTimeoutMs: 60_000,
  outputLimitChars: 16_000,
  costBudgetUsd: 1.0,
  termination: "soft",
};
```

| Campo | Default | Delimita |
| --- | --- | --- |
| `roundTimeoutMs` | `300_000` (5 min) | cap assoluto di un turno, indipendente dall'attività del subprocess |
| `eventTimeoutMs` | `60_000` (1 min) | nessun evento JSON parsato per questo tempo → subprocess considerato in hang |
| `outputLimitChars` | `16_000` | il testo del turno nel transcript viene troncato oltre questa lunghezza |
| `costBudgetUsd` | `1.0` | costo cumulato per partecipante che fa scattare il budget guard |
| `termination` | `"soft"` | come viene terminato un subprocess andato in timeout |

## Catena di risoluzione: tool > frontmatter > default (`index.ts:363`, `helpers.ts:313`)

Per ogni partecipante selezionato il motore risolve una volta i limiti
effettivi con `resolveParticipantLimitsForParticipant` (`index.ts:363`),
che cabla i parametri a livello tool e il frontmatter del partecipante in
`resolveParticipantLimits` (`helpers.ts:313`):

```text
toolParams (massima priorità) > participant.limits (frontmatter) > DEFAULT_PARTICIPANT_LIMITS
```

Ogni campo numerico viene scelto lungo quella catena con regole per-campo:

- `roundTimeoutMs`, `eventTimeoutMs` — minimo 1 ms, nessun clamp: un valore
  invalido o sotto soglia fa fallback al livello inferiore;
- `outputLimitChars` — minimo 1, clamp a 1;
- `costBudgetUsd` — minimo 0, clamp a 0 (un budget di 0 significa "nessun
  budget" per i turni a costo zero, vedi il budget guard);
- `termination` — solo `"soft"` o `"hard"` sono accettati; qualsiasi altro
  valore fa fallback al livello inferiore.

I valori invalidi non lanciano mai: fanno fallback al livello inferiore (o
al default) e producono un warning su stderr.

## Punto di enforcement 1 — validazione dello schema (`index.ts:124`)

Lo schema TypeBox del tool incorpora le costanti del motore, quindi una
chiamata che viola un limite rigido non raggiunge mai il motore:

```ts
rounds: Type.Optional(
  Type.Integer({
    minimum: 1,
    maximum: MAX_ROUNDS,
  }),
),
```

`maximum: MAX_ROUNDS` è la stessa costante della dichiarazione, non una
copia — se `MAX_ROUNDS` cambia, lo schema la segue. I parametri di limite a
livello tool (`roundTimeoutMs`, `eventTimeoutMs`, `outputLimitChars`,
`costBudgetUsd`, `termination`) sono opzionali nello schema: ometterli fa
scendere il merge al frontmatter o ai default.

## Punto di enforcement 2 — il clamp dei round (`index.ts:307-318`)

Il clamp viene applicato come *ultimo* passo della risoluzione dei round,
in due call site:

- `parseCommandArgs` clampa un conteggio esplicito:
  `rounds = Math.min(parsed, MAX_ROUNDS)` (`index.ts:307` e
  `index.ts:318`);
- il path del tool clampa dopo la gerarchia a quattro livelli
  (`resolveRoundsDefault`):
  `rounds = Math.min(resolveRoundsDefault(params.rounds, coordination.roundsDefault, DEFAULT_ROUNDS), MAX_ROUNDS)`.

Il clamp è deliberatamente fuori da `resolveRoundsDefault`: quella funzione
vive in `participants.ts`, che non può importare `MAX_ROUNDS` da `index.ts`
senza una dipendenza circolare (commento a `index.ts:975-977`).
Conseguenza: un `roundsDefault` di coordinamento sopra il cap non può mai
produrre più di `MAX_ROUNDS` round.

## Punto di enforcement 3 — il cap dei partecipanti (`index.ts:348-349`)

`selectParticipants` tiene i nomi richiesti nell'ordine della richiesta e,
quando sopravvivono più di `MAX_PARTICIPANTS` partecipanti, tronca:

```ts
selected = selected.slice(0, MAX_PARTICIPANTS);
```

`selected.slice(0, MAX_PARTICIPANTS)` è l'ultimo passo della selezione: i
primi `MAX_PARTICIPANTS` nell'ordine risolto vincono, gli altri vengono
scartati senza errore.

## Punto di enforcement 4 — timer per-turno e terminazione (`run-participant.ts:131`, `run-participant.ts:57`)

`runParticipantTurn` (`run-participant.ts:131`) protegge ogni turno con
due timer indipendenti e una modalità di terminazione, risolti dai
`ResolvedLimits` del partecipante:

- **round_timeout** (`roundTimeoutMs`) — cap assoluto dell'intero turno,
  indipendente dall'attività del subprocess;
- **event_watchdog** (`eventTimeoutMs`) — se nessuna linea JSON parsata
  arriva entro la soglia, il subprocess è considerato in hang (polling ogni
  `max(25 ms, eventTimeoutMs / 4)`, capped a 500 ms);
- **termination** — `"soft"` = SIGTERM, poi una grace di
  `SOFT_TERMINATION_GRACE_MS = 5_000` ms, poi SIGKILL; `"hard"` = SIGKILL
  immediato.

```ts
const SOFT_TERMINATION_GRACE_MS = 5_000;
```

Un timeout NON lancia: produce un `ParticipantTurnResult` con `failureKind`
= `"timeout_round"` | `"timeout_event"` e un `failureReason`, mentre
`durationMs` registra lo spawn-to-close. Il consumer marca il partecipante
morto ed emette il marker canonico (vedi sotto).

## Punto di enforcement 5 — troncatura dell'output (`helpers.ts:150`)

Dopo un turno, se `turn.text.length > limits.outputLimitChars`, il motore
applica `truncateOutput` (`helpers.ts:150`) e l'entry del transcript
termina con `[OUTPUT TRUNCATED at N chars]`. La troncatura NON è un crash:
il turno resta completo, il partecipante non viene marcato morto e
`outcome` non ne risente. Se `outputLimitChars` è più piccolo del marker
stesso, la troncatura viene saltata con un warning su stderr (la config
non è utilizzabile per la troncatura e il testo passa integro).

## Punto di enforcement 6 — il budget guard

I costi si accumulano per partecipante e vengono aggiornati *prima* che il
guard giri (`costByParticipant`). Dopo la troncatura, se
`participantCost > 0 && participantCost >= limits.costBudgetUsd`, il turno
termina con il marker canonico `[BUDGET EXHAUSTED: <id> at round <N> <ts>]`,
il partecipante viene marcato morto (`"budget_exhausted"`) e nei round
successivi viene saltato con `[PARTICIPANT SKIPPED: <id>]` — la run riporta
poi `outcome: "partial"`. Tre dettagli sono pinnati:

- il turno che fa scattare il guard paga il suo costo;
- la condizione è `cost > 0 && cost >= limit`, quindi con
  `costBudgetUsd: 0` un turno a costo zero non fa scattare il guard;
- l'ordine è fisso: prima la troncatura (l'over-limit resta un successo),
  poi il budget guard (l'over-budget è una failure distinta).

## Failure kind e marker (`helpers.ts:203`)

Tutti gli esiti dei limiti affiorano nel transcript come marker prodotti
dall'helper puro `formatFailureMarker` (`helpers.ts:203`):

| `FailureKind` | Marker |
| --- | --- |
| `failed` | `[PARTICIPANT FAILED: <id> <reason> <ts>]` |
| `skipped` | `[PARTICIPANT SKIPPED: <id>]` |
| `timeout_round` | `[TIMEOUT: <id> round_timeout <ts>]` |
| `timeout_event` | `[TIMEOUT: <id> event_watchdog <ts>]` |
| `budget_exhausted` | `[BUDGET EXHAUSTED: <id> at round <N> <ts>]` |
| `output_truncated` | `[OUTPUT TRUNCATED at N chars]` |

Un kind non riconosciuto lancia un `Error` esplicito da
`formatFailureMarker` — nessun fallback silenzioso, quindi un nuovo failure
kind non può passare inosservato al formato del transcript.

## Cosa questi limiti NON coprono

- **Nessun cap globale sul costo** — `costBudgetUsd` è per partecipante;
  non esiste un soffitto sulla somma tra partecipanti.
- **Nessuna wall clock sull'intera run** — i timer delimitano i singoli
  turni, non la run complessiva.
- **Transcript byte budget** — `truncateTranscriptForPrompt` cappa il
  prompt a `maxBytes: number = 100_000`; la gerarchia dei round
  (`resolveRoundsDefault`, quattro livelli) è trattata nella pagina
  *Orchestrazione dei round*.
- **Meccanica del subprocess** — spawn, parsing degli eventi e
  classificazione dei crash sono trattati nella pagina *Subprocessi
  partecipante*.

## Documentazione correlata

- [Riferimento architetturale](index.it.md) — indice del riferimento interno
- [Flusso di invocazione](invocation-flow.it.md) — dove i limiti vengono cablati nel tool e nel motore
- [Risoluzione del trigger](trigger-resolution.it.md) — come viene attivata la discussion arena
- [Hook di planning](hooks.it.md) — come il tool viene esposto durante il planning
- [User Guide](../user-guide/index.it.md) — installazione e uso dell'estensione
- [Contributor Guide](../contributor-guide/index.it.md) — convenzioni del repository
- [README](../../README.it.md) — panoramica, quickstart e limitazioni note
