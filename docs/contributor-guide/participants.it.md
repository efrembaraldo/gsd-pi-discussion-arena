**Lingue:** [English](participants.md) · [Italiano](participants.it.md)

[Guida per i contributor](index.it.md) — Partecipanti

# Aggiungere e sovrascrivere i partecipanti

La discussion arena carica i suoi partecipanti da file Markdown con blocco
frontmatter, un file per ruolo. La funzione di discovery è
`discoverParticipants` (`participants.ts`), la stessa funzione che
l'estensione esegue a runtime: quello che scrivi in `participants/*.md` deve
sopravvivere a quel loader, non all'occhio di un revisore. Ogni snippet
copiabile di questa pagina è validato contro il loader di produzione da
`tests/contributor-guide-snippets.test.ts` — se uno snippet smette di
caricarsi, la suite fallisce nominando la pagina e la riga del fence.

## Come funziona la discovery

`discoverParticipants(cwd, options)` raccoglie i file participant da cinque
sorgenti. La precedenza è **highest wins** (D052):

| Tier | Sorgente | Directory / file | Campo `source` |
| --- | --- | --- | --- |
| 0 | override | `.gsd/discussion-arena/participants-overrides/*.md` (walk-up verso la root git) | `override` |
| 1 | virtual | `roles_virtuals:` nel coordination file | `virtual` |
| 2 | project | `.gsd/discussion-arena/participants/*.md` (walk-up verso la root git) | `project` |
| 3 | user | `~/.pi/agent/discussion-arena/participants/*.md` | `user` |
| 4 | bundled | `participants/` accanto al modulo installato | `bundled` |

A parità di `name`, un tier più alto sostituisce interamente quello più
basso: la mappa viene costruita bundled → user → project → virtual →
override, e ogni tier sovrascrive l'entry precedente con lo stesso nome. I
participant bundled sono gli esempi distribuiti (`analyst`, `architect`,
`dev`, `qa`): dopo `npm install` la discussion arena funziona senza setup, e si
sovrascrivono quelli invece di modificare il package.

Le directory project, override e coordination usano una ricerca **walk-up**:
il loader parte da `cwd` e risale verso la root git finché trova la
directory (o il file). Ecco perché un participant in una sottodirectory vale
per l'intero repository.

## Un file participant copiabile

Un file participant è un frontmatter più un body. I tre campi `name`, `role`
e `description` sono **obbligatori** — senza di essi il file viene escluso
silenziosamente. Copia questo file in
`.gsd/discussion-arena/participants/pm.md` nel tuo progetto:

```participant
---
name: pm
role: Project Manager
description: Mantiene la discussione focalizzata su obiettivi, scope e scadenze del progetto
tools: read, grep, ls
model: freeinference_efrem/minimax-m3
round_timeout_ms: 120000
output_limit_chars: 4000
---

Sei il Project Manager del consiglio di agenti. Tieni la discussione
focalizzata sugli obiettivi e sulle scadenze del progetto.

Quando intervieni:

- Ricorda al consiglio lo scope, il piano e la definizione di done.
- Segnala i drift: proposte che risolvono un problema fuori dal milestone corrente.
- Riepiloga la decisione e i follow-up assegnati a fine round.
- Sii breve: 3-6 frasi per intervento.
```

L'harness scrive questo snippet in una directory utente temporanea isolata e
chiama `discoverParticipants` con `skipBundled: true`: lo snippet deve
tornare esattamente una volta, con `source: "user"` e lo stesso `name`
dichiarato nel frontmatter.

## Schema del frontmatter

| Campo | Obbligatorio | Significato |
| --- | --- | --- |
| `name` | sì | Identificatore univoco; chiave della mappa dei partecipanti, usato per invocare il ruolo |
| `role` | sì | Etichetta mostrata nel transcript della discussion arena |
| `description` | sì | Competenza del ruolo, usata dal consiglio |
| `tools` | no | Lista comma-separata di tool ammessi per il sottoprocesso |
| `model` | no | Override del modello; in assenza ripiega sul `model_default` del coordination file |
| `round_timeout_ms` | no | Timeout per-participante di un singolo round |
| `event_timeout_ms` | no | Timeout del primo evento di un round |
| `output_limit_chars` | no | Cap sui caratteri di output per intervento |
| `cost_budget_usd` | no | Budget massimo per il sottoprocesso |
| `termination` | no | `soft` (default) o `hard` |

I cinque campi limite sono validati e mergiati a runtime da
`resolveParticipantLimits` (`helpers.ts`), mai dal loader di discovery: il
frontmatter trasporta solo i valori grezzi. `systemPrompt` è il body dopo il
frontmatter — nessuna trasformazione, nessun placeholder: quello che scrivi
è quello che il ruolo esegue.

## Override: sostituzione totale, nessun merge

Un file di override in
`.gsd/discussion-arena/participants-overrides/<ruolo>.md` sostituisce il
participant base **interamente** — frontmatter e system prompt. Nessun campo
viene mergiato dalla base. L'override deve corrispondere alla base tramite
il `name` del frontmatter, non il nome del file: `architect.example.md`
sovrascrive `architect`, e il suffisso `.example.md` è innocuo.

Un override senza base è un **orfano** e la discovery lancia un errore
bloccante — nessun fallback silenzioso:

```
override target '<role>' not found in participants/ — create participants/<role>.md or remove the override file
```

Il tier virtual conta come base: un override che punta a un ruolo definito
in `roles_virtuals` è valido (D052, base < virtual < override).

## Cosa rifiuta il loader

Un participant senza `name`, `role` o `description` non entra mai nel
risultato: `parseParticipantContent` ritorna `null` e `discoverParticipants`
salta il file **silenziosamente** — nessun errore, nessun log. Lo snippet
sotto è deliberatamente malformato (manca `role`) e l'harness lo usa per
provare che il loader lo esclude davvero:

```participant-invalid
---
name: ghost
description: Manca il campo obbligatorio role
---

Un file participant senza `role` non è caricabile: `discoverParticipants`
lo esclude silenziosamente e la discussion arena non lo vede mai.
```

Se il tuo participant "non compare", ricontrolla il frontmatter contro la
tabella dello schema qui sopra prima di cercare nei log: un campo
obbligatorio mancante non lascia traccia.

## Documentazione correlata

- [Guida per i contributor](index.it.md) — navigazione e convenzioni
- [Coordination file](coordination-file.it.md) — `rounds_default`, `model_default` e `roles_virtuals`
- [Guida per l'utente](../user-guide/index.it.md) — installare e usare l'estensione
- [Architecture Reference](../architecture/index.it.md) — come funzionano discovery e precedenza
- [README](../../README.it.md) — panoramica, quickstart e limiti noti
