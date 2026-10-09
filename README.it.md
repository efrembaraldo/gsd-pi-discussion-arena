# Agent Discussion Arena per gsd-pi

**Lingue:** [English](README.md) · [Italiano](README.it.md)

[![CI](https://github.com/efrembaraldo/gsd-pi-discussion-arena/actions/workflows/ci.yml/badge.svg)](https://github.com/efrembaraldo/gsd-pi-discussion-arena/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@efrembaraldo/gsd-pi-discussion-arena)](https://www.npmjs.com/package/@efrembaraldo/gsd-pi-discussion-arena)

Estensione che aggiunge un tool `discussion_arena` e un comando `/discussion-arena`
a gsd-pi. Fa discutere N partecipanti (ruoli/competenze definiti da te in
Markdown) per K round su un tema, e restituisce il transcript all'agente
che ha invocato il tool — quindi **gsd-pi resta il coordinatore**: la discussion arena
è solo uno strumento che l'agente attivo nella unit corrente può decidere
di usare, esattamente come userebbe bash o web-search.

## Documentazione

| Sezione | Destinatario | Contenuti |
| --- | --- | --- |
| [Guida per l'utente](docs/user-guide/index.it.md) | Chi installa e usa l'estensione | Installazione, configurazione, uso, sessioni persistenti, troubleshooting |
| [Contributor Guide](docs/contributor-guide/index.it.md) | Chi estende l'estensione | Aggiungere ruoli, scrivere esempi caricabili, convenzioni di repo e documentazione |
| [Architecture Reference](docs/architecture/index.it.md) | Chi modifica gli internals | Registrazione del tool, modello a sottoprocessi, risoluzione trigger, hook di auto-mode, limiti runtime |

## Come funziona (riassunto architetturale)

1. `discussion_arena` è un tool registrato via `api.registerTool()` — lo
   stesso meccanismo di qualsiasi tool custom di gsd-pi.
2. Ogni partecipante gira come sottoprocesso `gsd --mode json -p --no-session`
   isolato, con il proprio system prompt e (opzionalmente) il proprio
   modello e set di tool ristretto.
3. I round sono sequenziali di proposito: nel round N ogni partecipante vede
   gli interventi già dati dagli altri nello stesso round (dialogo reale).
   Per un dibattito simultaneo dove nessuno vede gli altri fino a fine
   round, vedi il commento in `index.ts` (`runDiscussionArena`) su come invertire
   l'ordine con `Promise.all`.
4. Il transcript risultante torna come risultato del tool all'agente
   chiamante, che decide cosa farne (sintetizzare, decidere, scrivere codice
   di conseguenza) — la logica di fase/avanzamento resta interamente
   nell'orchestratore auto di gsd-pi (`resolveDispatch`, `orchestrator.ts`),
   che non ha alcuna consapevolezza della discussion arena.

## Motori: `gsd` (default) e `hermes -z` (opt-in)

Ogni partecipante gira come sottoprocesso isolato. La discussion arena supporta due motori,
dichiarati per-partecipante nel frontmatter del `.md`:

- **`gsd` (default)** — il sottoprocesso `gsd --mode json -p --no-session`
  originale descritto in "Come funziona" sopra. È quello che usano tutti i
  partecipanti bundlati (`analyst`, `architect`, `dev`, `qa`) ed è il
  comportamento invariato da M001–M014.
- **`hermes -z` (opt-in)** — aggiunto nella milestone M015 (`Hermes come
  motore di un partecipante nella Discussion Arena`). Un partecipante opt-in
  tramite `engine: hermes` nel frontmatter, più i campi opzionali `provider`,
  `hermes_toolsets`, `hermes_skills` e `soft_deadline_ms`. La discussion arena spawna
  `hermes -z <prompt> --usage-file <path>` riusando lo strato timer/abort/kill
  esistente (D039), e degrada a `gsd` — emettendo un warning one-shot su
  stderr più un marker `<!-- engine: gsd (degradato...) -->` nel transcript
  — quando il binario `hermes` non è nel `PATH`.

Il bundled `participants/researcher.md` è un esempio funzionante di
partecipante `engine: hermes`. Vedi
[`docs/architecture/participant-subprocesses.it.md`](docs/architecture/participant-subprocesses.it.md)
per il contratto completo del motore (D126, D127) e la semantica del blocco
soft-deadline / recupero (R042, R043).

## Installazione (da npm, dopo il publish — vedi sezione dedicata)

```bash
# Comando CLI top-level (verificato in packages/pi-coding-agent/src/core/package-commands.ts —
# appName si risolve a "gsd" per questo binario)
gsd install npm:@efrembaraldo/gsd-pi-discussion-arena

# In alternativa, dentro una sessione interattiva:
# /gsd extensions install @efrembaraldo/gsd-pi-discussion-arena
```

Poi riavvia gsd-pi (o `/reload` in sessione interattiva).

## Installazione manuale (senza npm, per test locali)

```bash
mkdir -p ~/.gsd/agent/extensions/gsd-pi-discussion-arena
cp -r index.ts participants.ts run-participant.ts package.json extension-manifest.json ~/.gsd/agent/extensions/gsd-pi-discussion-arena/

mkdir -p ~/.gsd/agent/discussion-arena/participants
cp participants/*.md ~/.gsd/agent/discussion-arena/participants/
```

Per uno scope di **progetto** (partecipanti diversi per repo diverso),
crea invece:

```bash
mkdir -p .gsd/discussion-arena/participants
cp participants/*.md .gsd/discussion-arena/participants/
```

I partecipanti di progetto hanno precedenza su quelli utente a parità di
`name` (stessa regola di precedenza project > user usata da gsd-pi per le
skill).

## Verifica dopo l'installazione

```bash
gsd extensions info gsd-pi-discussion-arena   # conferma che il manifest è stato letto
gsd -p "elenca i tool disponibili" --mode json | grep discussion_arena
```

Test manuale rapido, fuori da auto mode:

```bash
gsd
> /discussion-arena Dovremmo migrare hel-arxai da MongoDB 7.x a un modello ibrido con Postgres per i dati relazionali?
```

## Contratto versione host

La discussion arena punta all'host gsd-pi, non a una versione di Node:
la baseline host supportata è **1.15.0** (il peer opzionale
`@gsd/pi-coding-agent >=1.15.0`). Ciò che la versione dell'host offre
è un insieme di **capability native**, rilevate soltanto dal fingerprint
semver di `GSD_VERSION` — mai probeate (R076):

| Versione host | Comportamento |
| --- | --- |
| ≥ 1.21.0 | tutte e tre le capability native sono attive: dispatch context tipizzato su `before_agent_start` (#1997), delta toolset `{ addTools }` su `adjust_tool_set` (#1998), evento `phase_change` (#1999) |
| ≤ 1.20.x | l'estensione degrada automaticamente ai workaround pre-1.21 (snapshot polling, array-copy `{ toolNames }`), alla lettera il comportamento v0.9.2 |

Nessuna configurazione è necessaria in entrambi i casi: lo stesso
binario gira su entrambe le generazioni di host e sceglie il percorso
migliore disponibile all'avvio. La mapping feature → versione →
detection → fallback è documentata in
[`docs/architecture/runtime-tier-matrix.it.md`](docs/architecture/runtime-tier-matrix.it.md)
(Rilevamento delle feature host).

## Bootstrap

Lo slash command `/discussion-arena-init` scaffolda l'albero di coordination
della discussion arena a livello di progetto. È sicuro da invocare in
qualsiasi momento, anche dopo che l'estensione è già installata e usata.

### Slash command: /discussion-arena-init

```
/discussion-arena-init
```

Non accetta argomenti. Alla prima esecuzione crea la seguente struttura
sotto la directory di lavoro corrente:

```
.gsd/discussion-arena/
├── participants/           # partecipanti a livello di progetto (override di bundled/user)
│   └── .gitkeep
├── participants-overrides/ # override per-ruolo dei partecipanti di progetto
│   └── .gitkeep
└── transcripts/            # sessioni salvate della discussion arena
    └── .gitkeep
```

In esecuzioni successive il command è **idempotente**: le directory
esistenti non vengono toccate, e i file `.gitkeep` vengono scritti solo
quando una subdirectory è appena stata creata. Puoi depositare i tuoi
`analyst.md`, `architect.md`, ecc. in `participants/` e il command non li
sovrascriverà né li modificherà — il flusso di init è non-distruttivo per
design.

Il command è **failure-safe**: non lancia mai. Errori di filesystem
(`EACCES`, `ENOSPC`, e simili) vengono raccolti in `errors[]` del risultato
e resi visibili tramite la notifica della sessione, quindi il peggior caso è
un messaggio "cosa è fallito" visibile, non una pipeline in crash.

## Modalità streaming

Il parametro `stream` controlla la modalità di streaming live del tool discussion arena.
Default: `"off"` (comportamento attuale).

- `"off"` — Nessuno streaming live. La callback `onProgress` riceve il
  `partialTranscript` cumulativo come di consueto.
- `"events"` — Popola `details.streamingEvents: StreamingEvent[]` ad ogni
  evento della discussione. Ogni `StreamingEvent` contiene `ts` (ISO 8601),
  `type`, `participantId`, `round`, `costUsd`, `durationMs`,
  `cumulativeCost`, `text`. Utile per UI che vogliono rendering
  per-partecipante in tempo reale.
- `"transcript"` — Stub minimale (M018): accetta il parametro, emette un
  warning su stderr e degrada a `"off"`. Implementazione completa pianificata
  per una slice futura.

Esempio:

```typescript
await discussionArena({
  topic: "Trade-off architetturali per il modulo X",
  participants: ["analyst", "architect"],
  rounds: 3,
  stream: "events",
});
```

Nota: sessioni con molti partecipanti e round possono produrre migliaia di
eventi. Il consumer è responsabile del throttling e del rendering.

## Branching di sessioni

Il tool `discussion_arena` accetta un parametro opzionale `branch` che
crea una nuova sessione figlia derivata da una sessione antenata
esistente, lasciando l'antenata completamente inalterata. È una
funzionalità capability additive (R058): corto-circuita il flusso
normale di esecuzione e riusa il meccanismo `continuation?` già
esistente di `runDiscussionArena`, quindi il loop dei round resta
invariato. Il validatore vive in `branch.ts` come helper puro
(`validateBranchRequest`) e viene invocato prima che qualsiasi
sottoprocesso venga avviato, quindi i percorsi d'errore sono fail-fast.

Il parametro `branch` è un oggetto JSON-like con quattro campi:

- `fromSessionId` — stringa, ID logico della sessione antenata (default
  = `fromTopicSlug` se omesso).
- `fromTopicSlug` — stringa, topic-slug dell'antenata usato per il
  path lookup del transcript.
- `afterRound` — intero con 1 ≤ valore ≤ MAX_ROUNDS, round 1-based
  (incluso) fino al quale ereditare il transcript dell'antenata.
- `newTopic` — stringa, topic della nuova sessione figlia. NON deve
  pre-esistere (no overwrite).

Comportamento nel caso felice:

- Crea un nuovo file di transcript di nome `<cwdHash>-<newTopic>.md`
  dentro `<cwd>/.gsd/discussion-arena/transcripts/`, con tre nuovi
  campi di frontmatter valorizzati: `parentSessionId`,
  `parentTopicSlug`, e `branchedFromRound`. Questi tre campi sono
  opzionali nel parser, quindi i file legacy scritti senza di essi
  continuano a caricarsi invariati (R064 anti-regressione).
- Prefissa il transcript dell'antenata (round da 1 a `afterRound`,
  incluso) come contesto di partenza, così la sessione figlia continua
  da quel punto con gli stessi partecipanti e lo stesso costo/durata
  accumulato.
- La sessione antenata resta completamente inalterata: stesso
  contenuto, stesso mtime. Nessuna parte dell'antenata viene mutata.

Tre scenari d'errore bloccanti (validati in anticipo, prima che
qualsiasi sottoprocesso venga avviato — D058):

1. `afterRound` è maggiore del numero di round dell'antenata — la
   richiesta viene rifiutata e i file esistenti non sono modificati.
2. L'antenata non è trovata per `fromTopicSlug` — la richiesta viene
   rifiutata con un errore canonico "parent session not found".
3. `newTopic` collide con un file di transcript esistente — la richiesta
   viene rifiutata. Il file esistente non viene mai sovrascritto,
   anche se il chiamante lo chiede esplicitamente.

Esempio (l'esempio prende i primi due round di una discussione antenata
intitolata "convenienza AI in ERP" e li biforca come contesto di
partenza di una nuova discussione figlia intitolata "convenienza AI in
ERP - ramo ottimizzazione"; il file dell'antenata mantiene contenuto
e mtime originali, il file figlio è una sessione del tutto nuova con
i campi parent valorizzati):

```typescript
await discussionArena({
  topic: "convenienza AI in ERP - ramo ottimizzazione",
  participants: ["analyst", "architect"],
  rounds: 2,
  branch: {
    fromSessionId: "convenienza AI in ERP",
    fromTopicSlug: "convenienza AI in ERP",
    afterRound: 2,
    newTopic: "convenienza AI in ERP - ramo ottimizzazione",
  },
});
```

Questa funzionalità è puramente additive: i chiamanti che non passano
`branch` continuano a usare il flusso normale di esecuzione, invariato.
Vedi `docs/architecture/invocation-flow.it.md` per il contratto
source-anchored completo del corto-circuito factory.

## Schema decisionale

Il tool `discussion_arena` accetta due parametri opzionali,
`decisionSchema` e `persistDecision`, che insieme abilitano la cattura
strutturata di decisioni per-turno accanto al transcript free-form. È
una funzionalità capability-additive (R064): il flusso esistente resta
intatto quando i parametri sono omessi, quindi i chiamanti che non li
passano continuano a funzionare con diff comportamentale zero.

`decisionSchema` è un oggetto JSON-like che descrive lo schema che ogni
turno partecipante è tenuto a emettere. Porta tre campi:

- `type` — stringa literal, attualmente l'unico valore supportato è
  `"approve-reject"`. Tipi addizionali (es. `"ranked"`, `"graded"`)
  saranno aggiunti in slice future estendendo la union del type; il
  vincolo literal-only mantiene stretta la compatibilità forward.
- `description` — descrizione human-readable opzionale, propagata ai
  partecipanti come hint contestuale (best-effort, dipende dalla
  cooperazione del participant).
- `fields` — mappa opzionale di coppie chiave/valore arbitrarie,
  riservata a regole di validazione future (enum, min/max, …).
  Attualmente un sink no-op; accettata così che estensioni future
  dello schema possano atterrare senza rompere i chiamanti esistenti.

`persistDecision` è un boolean opzionale. Quando `true`, il tool intende
persistere la decisione finale sintetizzata via una scrittura MCP
(R066). Il writer MCP non è ancora implementato in M018/S05 — passare
`true` emette un warning canonico `[discussion-arena]` su stderr e
imposta `details.persistDecisionWritten = false`. Una slice dedicata è
richiesta per abilitare il percorso di scrittura reale.

### Formato di output

Ogni turno partecipante (incluso il turno di sintesi Scribe) può
includere zero o più blocchi decisionali fenced nel transcript. Il
delimitatore per le decisioni per-turno è costituito da triple backtick
seguiti da `decision`:

````text
```decision
{ "choice": "approve", "confidence": 0.9 }
```
````

Il turno di sintesi Scribe può inoltre emettere un singolo blocco
`final-decision` per registrare canonicamente il risultato
dell'arbitraggio sintetizzato:

````text
```final-decision
{ "consensus_level": 0.85, "final_choice": "approve" }
```
````

Questi blocchi sono ortogonali al parser markdown-section esistente
`extractResearchDecisions`: i due sistemi coesistono sullo stesso
transcript senza interferenza reciproca.

Quando `decisionSchema` è settato, il factory arricchisce i `details`
della risposta con tre campi addizionali:

- `details.decisions` — array di oggetti `{participantId, round, parsed,
  parseError}`, uno per blocco per-turno trovato nel transcript, in
  ordine di documento. `parsed` è il payload JSON.parse'd (o `null` se
  malformato); `parseError` è il messaggio d'errore del parser (o
  `null` in caso di successo). Il testo raw del blocco è intenzionalmente
  omesso da questo envelope per mantenerlo minimale — il transcript
  completo è comunque restituito nel content della risposta per i
  chiamanti che ne hanno bisogno.
- `details.finalDecision` — `{rawText, parsed, parseError}` dal blocco
  `final-decision` del Scribe, oppure `undefined` se nessun turno Scribe
  è stato prodotto (o se il Scribe non ha emesso alcun blocco
  final-decision). Quando presente, `rawText` è incluso perché la
  sintesi del Scribe è contenuto arbitrale autorevole.
- `details.persistDecisionWritten` — boolean, presente solo quando
  `persistDecision: true`. Sempre `false` in M018/S05 (writer MCP non
  implementato; vedi warning sopra).

### Cinque scenari d'errore tolleranti

Il factory non rifiuta input malformato; al contrario, popola l'envelope
così che i chiamanti possano introspezionare i fallimenti:

1. **JSON malformato** — un blocco `decision` o `final-decision` il cui
   payload non è JSON valido (es. troncato, virgolette sbagliate,
   commenti interni). Risultato: il corrispondente
   `details.decisions[i].parsed` è `null` e `parseError` porta il
   messaggio del parser.
2. **Nessun blocco decision trovato** — il transcript non contiene
   alcun blocco `decision`. Risultato: `details.decisions` è un array
   vuoto; nessun errore viene sollevato.
3. **Nessuna sintesi Scribe** — il transcript non ha un turno Scribe
   (nessun role uguale a `"Scribe"`). Risultato: `details.finalDecision`
   è `undefined` (il campo è omesso dall'envelope, non settato a
   `null`).
4. **Scribe senza blocco final-decision** — il Scribe emette un turno
   ma nessun blocco fenced `final-decision`. Risultato:
   `details.finalDecision` è `undefined` (come senza Scribe).
5. **Scribe con blocco final-decision malformato** — il Scribe emette
   un blocco `final-decision` con JSON invalido. Risultato:
   `details.finalDecision.parsed` è `null` e `parseError` non è null.
   Il campo È presente (non `undefined`) perché il chiamante vuole
   sapere che il blocco esiste ma è rotto.

### Comportamento fuori dai casi felici

- **Corto-circuito replay** — quando `replay` è settato, la risposta è
  servita dal transcript salvato senza invocare `runDiscussionArena`.
  Nessun arricchimento decision schema è applicato; `details.replay`
  porta i metadati replay invariati.
- **Percorso branch** — quando `branch` è settato, il transcript della
  sessione figlia è arricchito identicamente al percorso main. Gli
  stessi cinque scenari d'errore si applicano al transcript del branch.
- **Error catch** — quando `runDiscussionArena` lancia, l'handler catch
  ritorna direttamente `details.pendingResearchWritten: false`, senza
  invocare l'arricchimento decision schema.

### Backward compatibility (R064)

I chiamanti che non passano `decisionSchema` vedono esattamente la
stessa shape di risposta di prima di M018/S05. I tre nuovi campi
`details` sono popolati solo quando `decisionSchema !== undefined`.
Questo è verificato da un test anti-regressione in
`tests/decision-schema.test.ts`.

### Esempio end-to-end

```typescript
const result = await discussionArena({
  topic: "Refactor del provider di autenticazione",
  participants: ["engineer", "reviewer"],
  rounds: 2,
  decisionSchema: {
    type: "approve-reject",
    description: "Approva o rifiuta il refactor proposto",
  },
});

// result.details.decisions:
// [
//   { participantId: "engineer", round: 1, parsed: { choice: "approve", confidence: 0.9 }, parseError: null },
//   { participantId: "reviewer", round: 1, parsed: { choice: "approve", confidence: 0.8 }, parseError: null },
//   { participantId: "engineer", round: 2, parsed: null, parseError: "Unexpected token } in JSON at position 42" },
// ]

// result.details.finalDecision:
// { rawText: "{ \"consensus_level\": 0.85, \"final_choice\": \"approve\" }",
//   parsed: { consensus_level: 0.85, final_choice: "approve" },
//   parseError: null }
```

Vedi `docs/architecture/invocation-flow.it.md` per il contratto
source-anchored del cablaggio di arricchimento nel factory.

## Viewer

Il comando `discussion-arena-view <id>` renderizza l'event log della
discussion arena di una run completata in un unico file HTML self-contained,
apribile offline in un qualsiasi browser.

- `<id>` è il valore `details.discussionArenaId` restituito dal tool della
  discussion arena. L'event log esiste solo per le run avviate con
  `eventLog: true`; per un id senza event log il comando fallisce con
  `event log not found or empty: <id>`.
- Il file viene scritto in `<cwd>/.gsd/discussion-arena/views/<id>.html`. In
  caso di successo il comando notifica il path scritto insieme a un URL
  `file://` pronto da aprire; in caso di fallimento notifica
  `[discussion-arena-view] error: <message>` (l'altro fallimento canonico è
  `invalid replay id format: <id>` per un id malformato).
- Apri il file prodotto in un qualsiasi browser tramite l'URL `file://`
  stampato.

Garanzie del file generato:

- Documento standalone: `doctype` / `html` / `head` (`<style>` inline) /
  `body` / `main` con un `article` per round.
- CSS embedded con supporto `prefers-color-scheme` (dark mode inclusa);
  zero asset esterni: nessun `<link>`, nessun `script src=`, nessun
  riferimento CDN.
- Tutto il testo dei partecipanti è HTML-escaped (`&`, `<`, `>`, virgolette),
  quindi l'output dei partecipanti non può mai iniettare markup o script
  (no XSS).
- Idempotente: rieseguire il comando per lo stesso id riscrive il file
  byte-identico (il rendering è deterministico e privo di dipendenze dal
  clock).
- Quando lo schema decisionale è attivo, ogni round con un blocco decisione
  ben formato mostra una decision box con il JSON parsed pretty-printed; un
  blocco malformato mostra invece un parse error visibile.

## Status

Il comando `discussion-arena-status` (nessun argomento) riporta uno snapshot
read-only dei dati della discussion arena per la directory di lavoro
corrente, consegnato tramite notifica di sessione con prefisso
`[discussion-arena-status]` — mai su stdout.

Cosa mostra:

- **Sessioni, turni, costo aggregato** — numero di sessioni transcript (al
  massimo le ultime 20 per data di modifica), totale turni `### Round`
  contati in esse e somma dei costi USD dai log eventi per sessione.
- **Distribuzione engine** — sessioni classificate dai marker
  `<!-- engine: ... -->` nel transcript (`gsd`, `hermes` o `unknown`).
- **Esiti** — conteggi `complete` / `partial` / `unknown` dai log eventi
  delle sessioni.
- **Health probe** — l'ultimo esito persistito in `health.json` più un
  failure counter, sempre visibile anche quando è `0` (è `1` quando
  l'ultimo esito noto è diverso da `success`).
- **Metriche strutturate** — i counters di `metrics.json` quando presenti;
  una riga esplicita `non disponibili (<path>)` quando il file è assente
  o malformato.
- **Paths** — le posizioni transcripts/events/health/metrics, sempre
  mostrate anche quando i file non esistono ancora.

Garanzie:

- Puramente read-only: nessun subprocess, nessuna scrittura di alcun tipo.
- Nessun parent-directory traversal: legge solo sotto
  `<cwd>/.gsd/discussion-arena/`.
- Vengono contate al massimo le 20 sessioni modificate più di recente; se
  ce ne sono di più, il report lo dichiara esplicitamente (le sessioni più
  vecchie non sono contate).
- I file corrotti o illeggibili vengono contati come `unreadable` nel
  report e non sono mai fatali — il comando non lancia mai su input ostile.
- L'output passa solo attraverso il canale di notifica della sessione,
  mai stdout.

## Personalizzare ruoli e competenze

Dopo l'install la discussion arena funziona subito con i 4 partecipanti di esempio bundlati
nell'estensione (`analyst`, `architect`, `dev`, `qa`). Per aggiungere o
sovrascrivere ruoli, crea un file `.md` in una di queste directory
(precedenza: project > user > bundled):

- `.gsd/discussion-arena/participants/` — a livello di progetto (walk-up fino alla git root)
- `~/.gsd/agent/discussion-arena/participants/` — a livello utente
- `participants/` accanto al modulo installato — gli esempi bundled (sola lettura concettuale)

## Configurare il modello

Ogni partecipante `.md` può specificare `model:` nel frontmatter — è il modello
usato per spawnare `gsd` come subprocess per quel partecipante:

```markdown
---
name: analyst
role: Business Analyst
description: Chiarisce requisiti
model: claude-sonnet-5            # ← modello di questo partecipante
tools: read, grep
---
```

Se il `model:` è omesso, il subprocess `gsd` usa il modello attivo della sessione
parent (cioè quello impostato con `/model` o `gsd --model`).

Per forzare un modello **per un'intera sessione** senza modificare i file,
usa il flag `--model <id>` del comando:

```
/discussion-arena "tema" 2 --model claude-sonnet-5
```

L'override si applica a tutti i turn della sessione; alla successiva
invocazione senza `--model`, i partecipanti tornano ai loro `.md`.

## Sessioni persistenti e continuazione

Ogni invocazione del comando salva il transcript cumulativo in
`<cwd>/.gsd/discussion-arena/transcripts/<cwd-hash>-<topic-slug>.md` (frontmatter YAML + corpo markdown). Project-relative: il transcript è visibile nel working tree del repo (consiglio: aggiungi `.gsd/` a `.gitignore` del progetto se non vuoi committare i transcript).

Per aggiungere round a una sessione esistente senza ricominciare, usa `--continue`:

```
/discussion-arena "convenienza AI in ERP" 2           # round 1-2, salva sessione
/... leggi, decidi ...
/discussion-arena "convenienza AI in ERP" 1 --continue # round 3 (numerazione continua)
/discussion-arena "convenienza AI in ERP" 2 --continue # round 4-5, poi vedi msg di MAX_ROUNDS
```

Senza `--continue`, ogni invocazione riparte da zero. `--new` forza una
nuova sessione anche se esiste già un file.

Ogni file `.md` segue questo frontmatter:

```markdown
---
name: identificativo-univoco       # usato per invocarlo da participants: [...]
role: Etichetta mostrata nel transcript
description: Una riga, usata anche nel promptSnippet del tool
tools: read, grep, find, ls        # opzionale — sottoinsieme di tool concessi
model: claude-sonnet-5             # opzionale — override modello per questo ruolo
---

Corpo del file = system prompt del ruolo. Istruzioni comportamentali,
non conoscenza di dominio da ripetere a ogni round.
```

Ho incluso 4 partecipanti di esempio (`analyst`, `architect`, `dev`, `qa`),
tradotti dai ruoli equivalenti di BMAD-METHOD (`bmad-agent-analyst`,
`bmad-agent-architect`, `bmad-agent-dev`, più un QA sintetizzato dalle skill
`bmad-qa-generate-e2e-tests`/`bmad-code-review` visto che BMAD non ha un
singolo file agente QA dedicato nella v6 attuale). Aggiungine altri
copiando lo schema — es. un `ux-designer.md` dal contenuto di
`bmad-agent-ux-designer/SKILL.md`.

## Auto-mode: attivazione su 3 livelli (Tier 1-2-3)

Dentro il ciclo auto di gsd-pi il comportamento della discussion arena ha **due stati**:

- **Disponibile** — in ogni fase (`researching`, `planning`, `executing`,
  `verifying`, `closeout`) il tool `discussion_arena` è registrato e visibile
  all'agente, che può invocarlo autonomamente quando lo ritiene utile, come
  lo esortano le `promptGuidelines` del tool (decisioni che beneficiano di
  più prospettive, non lavoro esecutivo).
- **Forzata** — solo nella fase `planning` e solo se uno dei trigger Tier 1/2
  di seguito è attivo, l'estensione obbliga l'agente a usare la discussion arena prima di
  decidere il piano: aggiunge il tool al toolset e inietta nel prompt
  un'istruzione specifica.

La decisione tra i due stati è una pura funzione (`trigger-resolver.ts`) con
ordine deterministico — non lancia mai eccezioni, c'è sempre un risultato:

1. **Tier 1 — variabile d'ambiente.** `GSD_DISCUSSION_ARENA_AUTO=1` →
   la discussion arena è obbligatoria (source `env`). Il modo più semplice e globale per
   forzarla: imposta la variabile nel terminale prima di avviare `gsd auto`.
2. **Tier 2 — file di coordination (`activation:`).** Se nella sezione
   `activation:` del file `<cwd>/.gsd/discussion-arena/discussion-arena-coordination.md`
   il milestone corrente ha `milestones.<MID>.enabled: true`, oppure
   `enabled: true` a livello globale, la discussion arena è obbligatoria
   (source `preferences`). La sezione legacy `discussion_arena:` in
   `<cwd>/.gsd/PREFERENCES.md` è ancora onorata per retrocompatibilità ma
   emette un deprecation warning one-shot; vedi [Percorso di
   migrazione](#percorso-di-migrazione).
3. **Tier 3 — fallback availability-only.** Se né Tier 1 né Tier 2 abilitano,
   il default è `availability-only`: la discussion arena resta **disponibile ma non
   forzata** (nessun `adjust_tool_set` la aggiunge, nessuna istruzione nel
   prompt). È il comportamento di default di M001, deterministico e sicuro.

Tier 1 e Tier 2 sono gli unici percorsi che rendono **obbligatoria**
l'invocazione. `always-on` come fallback sarebbe troppo aggressivo: l'utente
non potrebbe disabilitare la discussion arena per un milestone a basso rischio senza un
opt-out esplicito.

### Percorso di migrazione: `discussion_arena:` → `activation:`

La sezione `discussion_arena:` in `<cwd>/.gsd/PREFERENCES.md` è **deprecata**
ma ancora letta. I nuovi setup — e il wizard interattivo — configurano la
discussion arena nel coordination file
`<cwd>/.gsd/discussion-arena/discussion-arena-coordination.md` nella sezione
`activation:` (stesse chiavi e stesso contratto di indentazione 2/4/6 spazi,
D025): la migrazione è una copia diretta.

Un progetto che definisce ancora la sezione legacy mostra un deprecation
warning one-shot su stderr:

```
[discussion-arena] DEPRECATION: discussion_arena: section in PREFERENCES.md is deprecated — move to .gsd/discussion-arena/discussion-arena-coordination.md under activation:.
```

Per migrare, rimuovi `discussion_arena:` da `PREFERENCES.md` e aggiungi
`activation:` al file di coordination:

```yaml
activation:
  enabled: true
  mode: per-milestone
  milestones:
    M001:
      enabled: true
```

### Schema (legacy) `discussion_arena:` in PREFERENCES.md (D025)

All'interno del frontmatter di `<cwd>/.gsd/PREFERENCES.md` (parser YAML
minimale, zero dipendenze — D004), la sezione usa questo schema:

```yaml
discussion_arena:
  enabled: false            # bool — default false; true = always-on
  mode: availability-only   # per-milestone | always-on | availability-only
  milestones:
    M003:
      enabled: true         # forza solo per quel milestone
```

Il parser distingue 4 stati: file assente, sezione assente, config valida,
config malformata — in caso di config malformata emette un warning (mai un
`throw`) e applica il fallback deterministico.

### Wizard interattivo (TUI) al milestone_start

All'evento `milestone_start`, se la sessione ha un TUI (`hasUI === true`),
l'estensione propone una scelta a 3 voci (`ui.select`) e la persiste in modo
**atomico** (read-modify-write) nella sezione `activation:` del file di
coordination `<cwd>/.gsd/discussion-arena/discussion-arena-coordination.md`:

- `per-milestone` → scrive `activation.milestones.<MID>.enabled: true`
- `always-on` → scrive `activation.enabled: true`
- `availability-only` → scrive `activation.enabled: false` (default)

Se `hasUI === false` (CI/print/modalità senza TUI), il wizard è un **no-op
stretto**: scrive solo un diagnostico su `stderr` e torna, senza mai bloccare
la pipeline.

### Hook di fase (S06)

La fase corrente è tracciata dall'evento `unit_start` (D024). L'obbligo di
uso della discussion arena scatta solo quando entrambe le condizioni sono vere: la fase
corrente è `planning` **e** `resolveTrigger().decision === "forced"`. In quel
caso:

- `adjust_tool_set` aggiunge `discussion_arena` a `toolNames` (non rimuove
  nulla);
- `before_agent_start` aggiunge nel prompt un'istruzione idempotente
  (identificata da un marker HTML, mai duplicata) che spinge a usare la discussion arena
  prima di decidere il piano.

In ogni altra fase (`executing`, `verifying`, `closeout`), o in decision
`availability-only`, il tool resta registrato ma **mai forzato**.

## Limiti noti

- `MAX_PARTICIPANTS = 8`, `MAX_ROUNDS = 5` — hardcoded in
  `index.ts`, alzali se servono discussioni più ampie.
- Per transcript molto lunghi (es. dopo molte sessioni --continue), il
  prompt passato al modello viene troncato a ~100KB scartando i round
  più vecchi (solo per il prompt — il transcript completo su disco è
  preservato, vedi sezione "Sessioni persistenti").
- Ogni turno di ogni partecipante è un processo `gsd` completo: costo e
  latenza scalano linearmente con partecipanti × round. Con 4 partecipanti
  e 2 round sono 8 invocazioni di modello per una singola chiamata al tool.
- Non è stato compilato contro l'albero reale di gsd-pi (richiederebbe
  `pnpm install` dell'intero monorepo): le firme di `ExtensionAPI`,
  `ToolDefinition`, `AgentToolResult` sono state verificate leggendo
  `packages/pi-coding-agent/src/core/extensions/extension-upstream-types.ts`
  e `packages/pi-agent-core/src/types.ts` nel repo clonato, ma un
  `tsc --noEmit` reale prima del primo uso in produzione è consigliato.

### Gap di integrazione con gsd-pi (Vision v2 §2)

Oltre ai limiti interni qui sopra, l'estensione non ha **ancora** raggiunto
l'"integrazione forzata deterministica" descritta nella Vision v2 §2.
Quell'analisi (sette gap, G1–G7) vive in un documento di pianificazione
interno tenuto nel working tree locale come artefatto onesto e in corso —
non tracciato in git e non parte del grafo documentale pubblicato. Ogni gap
sotto elenca lo stato corrente (`workaround` = esiste una mitigazione
locale, `open` = nessuna mitigazione ancora):

- **G1** — `unit_start` non viene mai emesso da `gsd-pi` (nessun
  `before_agent_start` call-site), quindi ogni hook di auto-mode è un no-op
  e il Tier 1/2/3 "forzata" non scatta. *Stato: open* (il workaround del
  probe degradato è solo teorico).
- **G2** — L'unit-type `"planning"` non esiste in `gsd-pi`, quindi anche se
  G1 fosse risolto `currentUnitType` non matcherebbe; gli hook restano
  silenziosamente inattivi. *Stato: open*.
- **G3** — Il modello bundled `minimax/minimax-m3` (verificato in
  `participants/architect.md:6`, `participants/analyst.md:6`,
  `participants/dev.md:6`, `participants/qa.md:6`, e in tutti gli
  `examples/participants/*.example.md`; formato provider-id per D092)
  deve essere risolvibile nel registry del chiamante, altrimenti i
  sottoprocessi dei partecipanti falliscono out-of-the-box e il quickstart
  non funziona. *Stato: workaround* — punta il modello a un
  `model_default` valido (provider o livello progetto) nel file di
  coordination.
- **G4** — `writePendingResearch` non viene mai invocato da `index.ts`,
  ma il partecipante `scribe` è ora bundled (mitigazione locale), quindi
  la pipeline S04 (research-decision → REQUIREMENTS.md) può essere
  innescata localmente anche se `index.ts` non lo chiama. *Stato:
  workaround* — scribe bundled in `participants/scribe.md`.
- **G5** — `adjust_tool_set` short-circuizza sul primo handler
  (`runner.ts:1183`), una race tra il listener core e il listener
  dell'estensione; l'iniezione del tool non è applicata a meno che l'ordine
  di caricamento sia quello atteso. *Stato: workaround* — è una
  preoccupazione di load-order gestita dal framework a monte; il manifest
  dell'estensione non dichiara intenzionalmente un campo `priority`
  (D083 lo ha rimosso perché il loader non lo onorava), quindi ci
  affidiamo all'ordinamento documentato core-prima-extension.
- **G6** — La suite di test è interamente stub-based (redirect di
  `@gsd/pi-coding-agent` a `tests/fixtures/`): la CI passa simulando eventi
  che `gsd-pi` non emette. *Stato: open*.
- **G7** — `extension-manifest.json` non dichiara né capability né
  dipendenze runtime, quindi il registry non può indovinare cosa l'estensione
  si aspetta. *Stato: open*.

I sette rischi runtime (R1–R7) implicati da questi gap sono tracciati in
[`docs/architecture/runtime-fallbacks.md`](docs/architecture/runtime-fallbacks.md) /
[`runtime-fallbacks.it.md`](docs/architecture/runtime-fallbacks.it.md). Alla
data attuale, R1, R2, R3, R5 e R6 sono popolate con le rispettive
mitigazioni locali (strategia ombrello zero-PR, matrice
`src/phase-mapping.ts`, classificatore runtime Tier F/A/D/G, scribe
bundled di S02 in `participants/scribe.md` e lock cross-process di S01);
R4 e R7 restano placeholder espliciti "non ancora implementati"
(skeleton onesti, non promessa di chiusura).

## License

MIT License

Copyright (c) 2026 Efrem Baraldo

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
