**Lingue:** [English](quickstart.md) · [Italiano](quickstart.it.md)

[Guida per l'utente](index.it.md) — Quickstart

# Eseguire il primo round di discussione

Questa pagina ti porta da un'installazione appena fatta a un round di
discussione reale in circa cinque minuti, usando solo i quattro partecipanti
bundled dell'estensione — nessun file di configurazione, nessun ruolo
personalizzato. Tutto ciò che è mostrato qui è ancorato al codice di
produzione: l'elenco dei partecipanti viene da `participants/*.md` accanto al
modulo installato, la forma del transcript da `runDiscussionArena`
(`index.ts`) e la meccanica dei round da `run-participant.ts`.

Il [README](../../README.md) copre lo stesso terreno in forma compatta.
Questa pagina mostra il percorso completo con l'output atteso, così sai che
aspetto ha un primo run sano prima di cominciare.

## Prerequisiti

- L'estensione è installata e gsd-pi è stato riavviato dopo — vedi
  [Installare l'estensione discussion arena](install.it.md) se non ne sei
  sicuro.
- Sei nella directory di un progetto gsd-pi (la discussion arena risolve
  tutto rispetto alla directory di lavoro).
- `gsd` è nel tuo `PATH` — verificalo con `gsd --version`.

Tutto qui. La discussion arena funziona subito con i partecipanti bundled;
non c'è nulla da configurare per un primo round.

## I quattro partecipanti bundled

Dopo l'installazione l'estensione scopre esattamente quattro partecipanti,
gli esempi distribuiti in `participants/` accanto al modulo. La loro identità
è il `name`; il `role` è ciò che compare nel transcript:

| `name` | `role` (etichetta nel transcript) | Model nel frontmatter |
| --- | --- | --- |
| `analyst` | Business Analyst | `freeinference_efrem/minimax-m3` |
| `architect` | Software Architect | `freeinference_efrem/minimax-m3` |
| `dev` | Senior Developer | `freeinference_efrem/minimax-m3` |
| `qa` | QA / Reviewer | `freeinference_efrem/minimax-m3` |

Questi sono i valori realmente distribuiti in questo repository
(`participants/analyst.md`, `architect.md`, `dev.md`, `qa.md`). Quando
invochi la discussion arena senza l'argomento `participants`, partecipano **tutti i
partecipanti scoperti** — con la sola estensione installata, questi quattro.
La pagina [Installare l'estensione discussion arena](install.it.md) spiega
come i partecipanti di progetto e utente hanno precedenza su quelli bundled.

## Il primo round, da una sessione interattiva

Dentro una sessione gsd-pi, esegui:

```text
/discussion-arena Dovremmo migrare il servizio di reporting da MongoDB a Postgres?
```

L'handler del comando parsifica il topic (tutto ciò che precede i flag),
risolve il numero di round e stampa una notifica di avvio:

```text
Avvio discussion-arena su: "Dovremmo migrare il servizio di reporting da MongoDB a Postgres?" — 4 partecipanti, 2 round(s) da eseguire (totale sessione: 2).
```

Dopo ogni round stampa il transcript cumulato, e alla fine la notifica finale
con il transcript:

```text
Discussion arena completata (esito: complete) — analyst, architect, dev, qa — 2 round(s) totali (2 nuovi) — costo cumulato $0.0120.

Session salvata: <cwd>/.gsd/discussion-arena/transcripts/<hash8>-dovremmo-migrare-il-servizio-di-reporting-da-mongo-db-a-postgre.md

Transcript finale:

### Round 1 — analyst (Business Analyst)
…
```

Puoi passare il numero di round esplicitamente — viene clampato al massimo,
quindi un valore eccessivo è sicuro:

```text
/discussion-arena Dovremmo migrare il servizio di reporting? 3
```

Il default è **2 round**, il massimo è **5** (`DEFAULT_ROUNDS`, `MAX_ROUNDS`
in `index.ts`); i valori sopra il cap vengono clampati, quelli sotto 1
vengono ignorati e si torna al default.

## Lo stesso round, tramite il tool (auto mode)

In auto mode è l'agente attivo a decidere quando un round è utile e invoca
lui stesso il tool `discussion_arena` — l'estensione lo registra in ogni
fase, quindi il round funziona in modo identico:

```text
discussion_arena {
  topic: "Dovremmo migrare il servizio di reporting da MongoDB a Postgres?"
}
```

Due parametri opzionali cambiano la forma del round:

| Parametro | Tipo | Significato |
| --- | --- | --- |
| `participants` | string[] | Nomi da coinvolgere; i nomi sconosciuti vengono scartati. Omesso → tutti i partecipanti scoperti |
| `rounds` | intero 1–5 | Default 2; clampato a `MAX_ROUNDS` (5) |

Il tool restituisce il transcript come testo, preceduto da un header
deterministico (la riga `## Discussion Arena — …`), e salva il file di
sessione (sotto).

Per rendere la discussion arena **forzata** — l'auto orchestrator richiede un round
prima che il piano venga deciso — configura la sezione `discussion_arena:`
in `.gsd/PREFERENCES.md`:

```yaml
discussion_arena:
  enabled: true
```

Questa sezione minima è validata contro il parser di produzione
(`parseDiscussionArenaBlock`, strict mode) da
`tests/user-guide-snippets.test.ts`, esattamente come ogni altro snippet di
questa guida. La pagina [Configurare la discussion arena](configuration.it.md)
documenta lo schema completo, i tre tier di attivazione e i quattro stati del
parser.

## Che aspetto ha l'output atteso

La forma del transcript è deterministica: ogni intervento è un'intestazione
`### Round N — name (role)` seguita dal testo del partecipante. Un run di due
round con tutti e quattro i partecipanti bundled ha quindi questa forma:

```text
## Discussion Arena — "Dovremmo migrare il servizio di reporting da MongoDB a Postgres?"
Partecipanti: analyst, architect, dev, qa | Round: 2 | Costo totale stimato: $0.0120 | Esito: complete

### Round 1 — analyst (Business Analyst)
[posizione dell'analyst sulla migrazione, basata sui requisiti…]

### Round 1 — architect (Software Architect)
[trade-off strutturali dell'architect, in reazione all'analyst…]

### Round 1 — dev (Senior Developer)
[stima di fattibilità del dev, in reazione a entrambi…]

### Round 1 — qa (QA / Reviewer)
[modalità di fallimento e domande di verifica del qa…]

### Round 2 — analyst (Business Analyst)
[risposta dell'analyst, vedendo tutto il round 1…]

### Round 2 — architect (Software Architect)
…

### Round 2 — dev (Senior Developer)
…

### Round 2 — qa (QA / Reviewer)
[…]

Session salvata: <cwd>/.gsd/discussion-arena/transcripts/<hash8>-<slug>.md
```

Due proprietà di questo output vanno conosciute prima del primo run:

- **I round sono sequenziali di proposito.** Nel round 1 ogni partecipante
  vede gli interventi già dati dagli altri nello stesso round (dialogo
  reale, nell'ordine analyst → architect → dev → qa); nel round 2 ogni
  partecipante vede l'intero transcript fin lì. Il prompt di ogni turno è
  costruito da `buildRoundPrompt` (`index.ts`): il round 1 chiede la
  posizione iniziale, i round successivi chiedono di rispondere agli altri.
- **Il contenuto viene da chiamate di modello reali, la forma no.** La riga
  di header, le entry `### Round N — name (role)` e il path della sessione
  sono deterministici; il testo di ogni turno dipende dal modello e può
  differire tra run diversi. Se la forma è sbagliata — niente header, niente
  intestazioni, niente path di sessione — l'estensione è rotta o vecchia,
  non il modello.

## Dove viene salvato il transcript

Ogni invocazione (comando e tool) salva il transcript cumulato in un file di
sessione:

```text
<cwd>/.gsd/discussion-arena/transcripts/<cwd-hash8>-<topic-slug>.md
```

Il nome del file combina un hash breve della directory di lavoro e uno slug
del topic (minuscolo, alfanumerico più trattini, max 50 caratteri). Il file
è frontmatter YAML + corpo markdown:

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

Questo è il transcript completo — quello mostrato in sessione può essere
troncato per il budget del prompt, ma il file è integrale. Il file di
sessione è ciò che `--continue` usa per appendere round con numerazione
continua (vedi la pagina Usage di questa guida).

## Cosa succede sotto il cofano

Ogni turno di un partecipante è un sottoprocesso `gsd` isolato in print mode,
senza stato di sessione:

```text
gsd --mode json -p --no-session [--model <model del partecipante>] [--tools <lista>] --append-system-prompt <file system prompt del ruolo> <prompt del turno>
```

- Il system prompt del ruolo (il corpo markdown del file del partecipante)
  viene scritto in un file temporaneo e iniettato con
  `--append-system-prompt`.
- `participants.model` del frontmatter viene passato come `--model` (per i
  partecipanti bundled: `freeinference_efrem/minimax-m3`).
- Il prompt del turno è costruito da `buildRoundPrompt` e passato come
  ultimo argomento.
- Il risultato dell'intero run — transcript, partecipanti usati, costo
  stimato, esito (`complete` quando nessun partecipante è morto a metà run,
  `partial` altrimenti) — viene restituito all'agente chiamante, che resta
  il coordinatore: l'orchestrator di gsd-pi non sa che la discussion arena
  esiste, vede una tool call lunga.

I diagnostic `[discussion-arena]` che puoi vedere su stderr (limiti per
partecipante, `discussionArena.complete` strutturato) sono solo log: non
cambiano mai l'esito.

## Se il primo round fallisce

I due guasti più comuni al primo run e i loro segnali:

- **`discussion_arena` non è un tool registrato.** L'estensione non si è
  caricata — ricontrolla l'[installazione](install.it.md) e riavvia gsd-pi.
  Gli errori di caricamento delle estensioni compaiono come warning `[gsd]`
  su stderr all'avvio della sessione.
- **`Nessun partecipante valido trovato. Disponibili: …`** — nessun
  partecipante scoperto in alcun tier (progetto, utente, bundled). Con
  l'estensione installata non dovrebbe accadere; significa che la directory
  `participants/` bundled manca o che la discovery è fallita.

## Prossimi passi

- [Configurare la discussion arena](configuration.it.md) — lo schema
  `discussion_arena:`, i tre tier di attivazione e i quattro stati del
  parser, incluso cosa succede quando la sezione è malformata.
- La pagina Usage di questa guida — override `--model`, flag di sessione
  `--continue` / `--new` e limiti runtime.
- [Installare l'estensione discussion arena](install.it.md) — scope utente
  vs progetto, verifica post-install e rimozione.

## Documentazione correlata

- [Guida per l'utente](index.it.md) — installazione, configurazione, uso, troubleshooting
- [README](../../README.md) — panoramica, quickstart e limiti noti
- [Contributor Guide](../contributor-guide/index.it.md) — aggiungere ruoli e contribuire all'estensione
- [Architecture Reference](../architecture/index.it.md) — come vengono scoperti ed eseguiti i partecipanti
