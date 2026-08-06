# Agent Discussion Arena per gsd-pi

[![CI](https://github.com/efrembaraldo/gsd-pi-discussion-arena/actions/workflows/ci.yml/badge.svg)](https://github.com/efrembaraldo/gsd-pi-discussion-arena/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@efrembaraldo/gsd-pi-discussion-arena)](https://www.npmjs.com/package/@efrembaraldo/gsd-pi-discussion-arena)

Estensione che aggiunge un tool `discussion_arena` e un comando `/discussion-arena`
a gsd-pi. Fa discutere N partecipanti (ruoli/competenze definiti da te in
Markdown) per K round su un tema, e restituisce il transcript all'agente
che ha invocato il tool — quindi **gsd-pi resta il coordinatore**: l'arena
è solo uno strumento che l'agente attivo nella unit corrente può decidere
di usare, esattamente come userebbe bash o web-search.

## Come funziona (riassunto architetturale)

1. `discussion_arena` è un tool registrato via `api.registerTool()` — lo
   stesso meccanismo di qualsiasi tool custom di gsd-pi.
2. Ogni partecipante gira come sottoprocesso `gsd --mode json -p --no-session`
   isolato, con il proprio system prompt e (opzionalmente) il proprio
   modello e set di tool ristretto.
3. I round sono sequenziali di proposito: nel round N ogni partecipante vede
   gli interventi già dati dagli altri nello stesso round (dialogo reale).
   Per un dibattito simultaneo dove nessuno vede gli altri fino a fine
   round, vedi il commento in `index.ts` (`runArena`) su come invertire
   l'ordine con `Promise.all`.
4. Il transcript risultante torna come risultato del tool all'agente
   chiamante, che decide cosa farne (sintetizzare, decidere, scrivere codice
   di conseguenza) — la logica di fase/avanzamento resta interamente
   nell'orchestratore auto di gsd-pi (`resolveDispatch`, `orchestrator.ts`),
   che non ha alcuna consapevolezza dell'arena.

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
gsd extensions info gsd-arena   # conferma che il manifest è stato letto
gsd -p "elenca i tool disponibili" --mode json | grep discussion_arena
```

Test manuale rapido, fuori da auto mode:

```bash
gsd
> /discussion-arena Dovremmo migrare hel-arxai da MongoDB 7.x a un modello ibrido con Postgres per i dati relazionali?
```

## Personalizzare ruoli e competenze

Dopo l'install l'arena funziona subito con i 4 partecipanti di esempio bundlati
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

## Usarla dentro auto mode

L'agente in una qualsiasi fase del ciclo auto di gsd-pi (`researching`,
`planning`, `executing`, `verifying`...) vede `discussion_arena` nel proprio
set di tool e può invocarlo autonomamente quando lo ritiene utile — grazie
a `promptGuidelines` nel tool, che lo istruisce a usarlo per decisioni che
beneficiano di più prospettive, non per lavoro esecutivo.

Se vuoi **forzare** l'uso dell'arena in fasi specifiche (es. sempre durante
`planning` per milestone ad alto rischio), il punto di aggancio è l'evento
`adjust_tool_set` (vedi `gsd-extension-types.ts`, `AdjustToolSetEvent`) o
`unit_start` combinato con un `systemPromptOverride` che istruisce
esplicitamente l'agente a usare l'arena prima di procedere — non incluso in
questa prima versione per tenerla minimale; è un'estensione naturale se ti
serve.

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
