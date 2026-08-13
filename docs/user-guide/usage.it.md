**Lingue:** [English](usage.md) · [Italiano](usage.it.md)

[Guida per l'utente](index.it.md) — Uso

# Usare la discussion arena

La discussion arena ha due punti di ingresso: il comando `/discussion-arena`
per le sessioni interattive e il tool `discussion_arena` per l'auto mode.
Condividono lo stesso motore (`runDiscussionArena` in `index.ts`) ma
differiscono nel modo in cui si passano i parametri: il comando parsa una
riga di comando compatta, il tool riceve parametri strutturati validati
contro lo schema TypeBox (`DiscussionArenaParamsSchema` in `index.ts`).
Tutto ciò che è mostrato in questa pagina è ancorato a quello schema e
all'handler del comando, non a una loro descrizione: se un nome di
parametro, un default o un cap differisce qui, lo schema o l'handler sono
cambiati e questa pagina è vecchia.

La pagina [Quickstart](quickstart.it.md) mostra il percorso minimo fino al
primo round; questa pagina copre l'intera superficie dei parametri, i flag
del comando, la persistenza delle sessioni (`--continue` / `--new`) e i
limiti runtime che delimitano un run.

## Il comando: `/discussion-arena`

La sintassi del comando, parsata da `parseCommandArgs` (`index.ts`), è:

```text
/discussion-arena <topic> [N round] [--continue|--new] [--model <id>]
```

- `<topic>` è tutto ciò che precede i flag; può contenere spazi.
- `N round` è un intero finale opzionale — l'ultimo token numerico non
  consumato da `--model`. I valori sotto 1 vengono ignorati (vale il
  default); i valori sopra il cap vengono clampati al massimo.
- `--continue` / `-c` riprende la sessione esistente per il topic (vedi
  [Sessioni](#sessioni)).
- `--new` avvia una sessione da zero, anche se `--continue` è presente.
- `--model <id>` / `-m <id>` sovrascrive il modello per **ogni** turno di
  questa sessione, qualsiasi cosa dica il frontmatter di ogni partecipante.

Il numero di round predefinito arriva dal file di coordinamento del
progetto (`coordination.rounds_default`, livello 3 della gerarchia round
sotto) oppure ripiega sul default di codice pari a 2 (`DEFAULT_ROUNDS`).
Senza topic il comando stampa la riga di usage insieme ai partecipanti
scoperti.

Esempi:

```text
/discussion-arena Dovremmo migrare il servizio di reporting? 3
/discussion-arena Dovremmo migrare il servizio di reporting? --continue
/discussion-arena Dovremmo migrare il servizio di reporting? -c -m gpt-4o
/discussion-arena Dovremmo migrare il servizio di reporting? --new
```

## Il tool: parametri di `discussion_arena`

In auto mode il tool viene chiamato con parametri strutturati. Il set
completo è definito da `DiscussionArenaParamsSchema` (TypeBox, `index.ts`)
— questa tabella è il perimetro dello schema, letta dallo schema stesso:

| Parametro | Tipo | Default | Significato |
| --- | --- | --- | --- |
| `topic` | string | — (richiesto) | Il tema o la domanda su cui i partecipanti discutono o deliberano |
| `participants` | string[] | tutti quelli scoperti | Nomi da coinvolgere; devono corrispondere a un file partecipante in uno dei tre tier. I nomi sconosciuti vengono scartati; omesso → tutti i partecipanti scoperti, con cap a `MAX_PARTICIPANTS` (8) |
| `rounds` | intero | 2 | Numero di round, 1–5. Clampato a `MAX_ROUNDS` (5); vedi la gerarchia round sotto |
| `contTopic` | string | — | Dichiarato nello schema come path di un file di sessione esistente da cui continuare (`--continue`). L'implementazione attuale del comando deriva il path della sessione automaticamente dalla directory di lavoro e dal topic (`getSessionFilePath`), quindi questo parametro non è ancora consumato |
| `model` | string | — | Dichiarato nello schema come il modello che sovrascrive `participant.model` per tutti i turni. Consumato sulla superficie del comando via `--model` / `-m` |
| `roundTimeoutMs` | number | 300 000 | Tempo massimo (ms) per il completamento di un round da parte di un partecipante. Sovrascrive il frontmatter `round_timeout_ms` del partecipante e il default; enforceato come timeout rigido (vedi [Limiti runtime](#limiti-runtime)) |
| `eventTimeoutMs` | number | 60 000 | Tempo massimo (ms) tra un evento e il successivo (watchdog) durante un turno partecipante. Sovrascrive `event_timeout_ms`; enforceato come timeout rigido |
| `outputLimitChars` | number | 16 000 | Massimo di caratteri dell'output di un partecipante prima della troncatura. Sovrascrive `output_limit_chars`; l'output oltre il limite viene troncato con un marker, non scartato come failure |
| `costBudgetUsd` | number | 1.00 | Budget massimo in USD per i turni di un partecipante. Sovrascrive `cost_budget_usd`; una volta raggiunto, il turno termina con un marker budget esaurito e il partecipante viene eliminato |
| `termination` | "soft" \| "hard" | "soft" | Cosa succede quando una soglia viene superata: `soft` = degradazione controllata (SIGTERM, poi SIGKILL dopo un grace period), `hard` = SIGKILL immediato |
| `eventLog` | boolean | false | Persiste l'event log JSONL (vedi [Event log e replay](#event-log-e-replay)) |
| `replay` | string | — | Ri-deriva il transcript di un run precedente con `eventLog: true` dal suo log persistito, senza eseguire alcun subprocess (vedi [Event log e replay](#event-log-e-replay)) |

I cinque parametri di limite (`roundTimeoutMs`, `eventTimeoutMs`,
`outputLimitChars`, `costBudgetUsd`, `termination`) formano il livello più
alto di un merge a tre livelli applicato per partecipante: **parametro del
tool > frontmatter del partecipante > default di codice**
(`resolveParticipantLimits` in `helpers.ts`). Le chiavi del frontmatter
sono le forme snake_case (`round_timeout_ms`, `event_timeout_ms`,
`output_limit_chars`, `cost_budget_usd`, `termination`); un livello
mancante scende al successivo.

### La gerarchia dei round

`rounds` viene risolto su quattro livelli (`resolveRoundsDefault`,
`participants.ts`, cablaggio in `index.ts`):

1. parametro del tool `rounds`;
2. frontmatter del partecipante — non applicabile: i round sono una
   proprietà della discussion arena, non di un singolo partecipante;
3. `coordination.rounds_default` dal file di coordinamento del progetto
   (`.gsd/discussion-arena/discussion-arena-coordination.md`, walk-up);
4. default di codice `DEFAULT_ROUNDS` (2).

Il risultato viene clampato a `MAX_ROUNDS` (5) come ultimo passo, quindi un
`rounds_default` sopra il cap non può mai produrre più di 5 round. Il
comando applica la stessa gerarchia — la sua `N` esplicita gioca il ruolo
del livello 1, clampata in `parseCommandArgs`.

## Sessioni

Ogni invocazione — comando e tool — salva il transcript cumulato in un file
di sessione:

```text
<cwd>/.gsd/discussion-arena/transcripts/<cwd-hash8>-<topic-slug>.md
```

Il nome del file combina un hash SHA-256 di 8 caratteri esadecimali della
directory di lavoro e uno slug del topic (minuscole, alfanumerici più
trattini, max 50 caratteri; `untitled` se vuoto). Il file è frontmatter
YAML più il transcript markdown integrale — mai troncato su disco:

```markdown
---
topic: Dovremmo migrare il servizio di reporting da MongoDB a Postgres?
participants: analyst, architect, dev, qa
startedAt: <timestamp ISO>
lastUpdatedAt: <timestamp ISO>
rounds: 2
---

### Round 1 — analyst (Business Analyst)
…
```

La pagina [Quickstart](quickstart.it.md) mostra lo stesso file nel suo
contesto. Qui conta cosa fa la discussion arena con il file tra le invocazioni.

### `--continue`: appendere round a una sessione esistente

Con `--continue` il comando carica il file di sessione per il topic:

```text
/discussion-arena Dovremmo migrare il servizio di reporting? --continue
```

Il transcript esistente viene iniettato nel run e i round vengono appesi con
**numerazione continua**: dopo una sessione di 2 round, `--continue` con
altri 2 round esegue il round 3 e il round 4 (il numero di round è
`round + 1 + roundOffset`, dove `roundOffset` è il numero di round della
sessione precedente). La notifica di avvio rende espliciti i totali:

```text
Avvio discussion-arena su: "Dovremmo migrare il servizio di reporting?" — 4 partecipanti, 2 round(s) da eseguire (totale sessione: 4).
```

e la notifica finale riporta entrambi i numeri:

```text
Discussion arena completata (esito: complete) — analyst, architect, dev, qa — 4 round(s) totali (2 nuovi) — costo cumulato $0.0120.

Session salvata: <cwd>/.gsd/discussion-arena/transcripts/<hash8>-dovremmo-migrare-il-servizio-di-reporting.md

Transcript finale:

### Round 3 — analyst (Business Analyst)
…
```

Il file di sessione viene salvato con `rounds` pari al totale e lo
`startedAt` originale preservato; `lastUpdatedAt` viene aggiornato. Se
`--continue` non trova alcuna sessione per il topic, il comando lo dice e
parte da zero:

```text
Nessuna sessione esistente per "Dovremmo migrare il servizio di reporting?" — avvio da zero.
```

### `--new`: forzare una sessione fresca

`--new` fa sì che il comando ignori qualsiasi sessione esistente anche
quando `--continue` è presente sulla stessa riga (`explicitNew` bypassa
`continueSession`). Il run parte da un transcript vuoto e il file di
sessione viene sovrascritto. Usalo quando vuoi una tabula rasa per un topic
che ha già una sessione.

### Il percorso del tool

Il tool esegue sempre da zero (non ha ancora un flag di continuazione) ma
legge il file di sessione esistente per preservare `startedAt`, quindi
chiamate ripetute sullo stesso topic mantengono la data di inizio originale
e sovrascrivono il corpo del transcript. Gli errori di salvataggio della
sessione sul percorso del tool non sono fatali: il risultato del run viene
restituito e un `[discussion-arena] warning` viene stampato su stderr.

## Limiti runtime

L'inviluppo runtime, tutto enforceato nel codice:

| Limite | Valore | Dove |
| --- | --- | --- |
| `MAX_ROUNDS` | 5 | i round vengono clampati a questo; una richiesta più grande non esegue mai di più |
| `MAX_PARTICIPANTS` | 8 | la selezione dei partecipanti viene troncata a questo (`selectParticipants`) |
| `DEFAULT_ROUNDS` | 2 | fallback di codice quando non valgono né parametro né default di coordinamento |
| timeout round | 300 000 ms | un turno partecipante che lo supera viene killato (vedi sotto) |
| watchdog eventi | 60 000 ms | nessuna riga JSON di progresso entro questo tempo killa il turno |
| limite output | 16 000 char | l'output oltre il limite viene troncato con `[OUTPUT TRUNCATED at N chars]` |
| budget costo | $1.00 | raggiungerlo elimina il partecipante con `[BUDGET EXHAUSTED: <id> at round <N> <ts>]` |
| termination | `soft` | soft = SIGTERM + 5 s di grace + SIGKILL; `hard` = SIGKILL immediato |

I valori di default vengono da `DEFAULT_PARTICIPANT_LIMITS`
(`helpers.ts`); ognuno può essere sovrascritto per partecipante
(frontmatter) o per chiamata (parametri del tool), come descritto nella
tabella dei parametri sopra.

Cosa succede davvero quando un guardrail scatta (S04–S06 in
`run-participant.ts` e `index.ts`):

- **timeout round / watchdog eventi** — il turno viene abortito (il primo
  abort vince tra i due timer e un cancel esterno) e il partecipante viene
  marcato morto con il marker canonico
  `[TIMEOUT: <id> round_timeout|event_watchdog <ts>]`; nei round successivi
  il partecipante viene saltato (`[PARTICIPANT SKIPPED: <id>]`).
- **output oltre il limite** — l'output viene troncato con
  `[OUTPUT TRUNCATED at N chars]`; questo *non* è una failure: il turno
  viene mantenuto e il partecipante resta vivo.
- **budget esaurito** — il turno termina con
  `[BUDGET EXHAUSTED: <id> at round <N> <ts>]` e il partecipante viene
  eliminato.
- **terminazione hard** — all'abort, SIGKILL viene inviato immediatamente
  (non intercettabile); `soft` invia prima SIGTERM e scala a SIGKILL se il
  processo non esce entro il grace period.

Se **tutti** i partecipanti selezionati sono morti alla fine di un round,
il run si ferma prima (`allDead` break in `runDiscussionArena`). L'esito è
`complete` quando nessun partecipante è morto a metà run, `partial`
altrimenti; entrambi sono riportati nella riga di header e nella notifica
finale.

### Troncatura del transcript per il prompt

Il transcript passato al prompt di ogni turno viene troncato a 100 000
byte, mantenendo i round più recenti (`truncateTranscriptForPrompt` in
`index.ts`; default `maxBytes = 100_000`), con una riga di marker quando i
round più vecchi vengono omessi. Esiste per evitare `spawn E2BIG` quando
`--continue` ha accumulato molti round — il limite argv è di circa 2 MB su
Linux e 256 KB su macOS. Il **file di sessione su disco contiene sempre il
transcript integrale**, quindi la troncatura è solo un problema di
dimensione del prompt.

## Event log e replay

Con `eventLog: true` il run persiste un event log JSONL append-only:

```text
<cwd>/.gsd/discussion-arena/events/<discussionArenaId>.jsonl
```

Il `discussionArenaId` viene restituito nei `details` del tool e il testo
della risposta punta al log:

```text
## Discussion Arena — "Dovremmo migrare il servizio di reporting?"
Partecipanti: analyst, architect, dev, qa | Round: 2 | Costo totale stimato: $0.0120 | Esito: complete

…

Session salvata: <cwd>/.gsd/discussion-arena/transcripts/<hash8>-dovremmo-migrare-il-servizio-di-reporting.md

Event log (replay): <cwd>/.gsd/discussion-arena/events/<discussionArenaId>.jsonl — rileggi con discussion_arena { replay: "<discussionArenaId>" }
```

Con `replay: "<discussionArenaId>"` il tool ri-deriva il transcript
dall'event log persistito **senza eseguire alcun subprocess** (ricostruzione
pura sugli eventi registrati) e lo restituisce con il conteggio degli
eventi. Un id sconosciuto produce una risposta esplicita e azionabile
invece del silenzio:

```text
Nessun event log trovato per la discussion-arena <discussionArenaId> — verifica che la run originale sia stata eseguita con eventLog: true (log in <cwd>/.gsd/discussion-arena/events/).
```

## Diagnostica

La discussion arena scrive righe `[discussion-arena]` su stderr: i limiti risolti per
partecipante, il log strutturato `discussionArena.complete` e i warning non
fatali (es. un fallimento di salvataggio della sessione sul percorso del
tool). Sono solo log — non cambiano mai l'esito di un run. Se vedi un
`[discussion-arena] warning` sui limiti, significa che un valore di
frontmatter o di parametro era invalido e il codice è ripiegato sul default
per quel livello (vedi la tabella dei parametri).

## Documentazione correlata

- [Guida per l'utente](index.it.md) — installazione, configurazione, quickstart, troubleshooting
- [Quickstart](quickstart.it.md) — il percorso minimo fino al primo round
- [Configurare la discussion arena](configuration.it.md) — lo schema `discussion_arena:` in `.gsd/PREFERENCES.md`
- La pagina Troubleshooting di questa guida — configurazioni malformate, warning del parser e fallback deterministici
- [README](../../README.it.md) — panoramica, quickstart e limiti noti
- [Architecture Reference](../architecture/index.it.md) — come vengono scoperti ed eseguiti i partecipanti
