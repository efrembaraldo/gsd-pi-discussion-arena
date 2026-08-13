**Lingue:** [English](project-layout.md) · [Italiano](project-layout.it.md)

[Guida per i contributor](index.it.md) — Layout del progetto

# Layout del progetto

Questo repository è un'estensione gsd-pi: aggiunge un tool `discussion_arena`
che l'agente attivo può invocare da qualsiasi fase del ciclo auto, più un
comando `discussion-arena` e i moduli ausiliari necessari alla discovery,
alla persistenza delle sessioni e al coordination file. Prima di modificare
codice, test o documentazione, sappi dove vive ogni superficie e cosa si
aspettano da essa gli script di enforcement.

## Mappa del repository

```text
gsd-pi-discussion-arena/
├── index.ts                  # entry dell'estensione: tool + comando, limiti
├── participants.ts           # discoverParticipants, resolveRoundsDefault
├── run-participant.ts        # runParticipantTurn (sottoprocesso di un ruolo)
├── discussion-arena-session.ts  # path del file di sessione + save/load
├── trigger-resolver.ts       # quando la discussion arena deve girare
├── helpers.ts                # resolveParticipantLimits, costi/truncation
├── metrics.ts                # contatori e istogrammi
├── replay.ts                 # ricostruzione del transcript dall'event log
├── participants/             # ruoli bundled: analyst, architect, dev, qa
├── examples/                 # file di esempio validati dai loader di produzione
├── src/                      # coordination loader, CLI, parser, wizard, hooks
├── docs/                     # documentazione bilingue (EN + .it.md)
├── tests/                    # suite node:test, fixture, loader TS ESM
├── scripts/                  # check-links.mjs, setup-types.mjs
├── vendor/pi-coding-agent/   # dichiarazioni di tipo vendored dell'SDK
├── package.json / tsconfig.json / extension-manifest.json
└── README.md (+ README.it.md)
```

## Voci di primo livello

| Path | Scopo |
| --- | --- |
| `index.ts` | Entry point dell'estensione. Registra il tool `discussion_arena` e il comando `discussion-arena`; contiene i limiti `MAX_PARTICIPANTS` (8), `MAX_ROUNDS` (5), `DEFAULT_ROUNDS` (2) e il builder del prompt di round |
| `participants.ts` | Discovery dei partecipanti. `discoverParticipants` raccoglie i ruoli dalle cinque sorgenti (override > virtual > project > user > bundled, D052); `resolveRoundsDefault` implementa la gerarchia dei round a 4 livelli |
| `run-participant.ts` | Esegue un singolo turno di un partecipante come sottoprocesso (`runParticipantTurn`) con i limiti risolti da `helpers.ts` |
| `discussion-arena-session.ts` | Persistenza delle sessioni: deriva il path del file di sessione da `cwd` e topic, salva e carica i transcript |
| `trigger-resolver.ts` | Decide quando la discussion arena deve girare: legge le preferenze (`per-milestone`, `always-on`, `availability-only`) e risolve il trigger |
| `helpers.ts` | Helper runtime condivisi: `resolveParticipantLimits` fa il merge defaults < frontmatter < overrides, più accumulo costi, troncamento dell'output e failure marker |
| `metrics.ts` | Contatori e istogrammi registrati durante le esecuzioni |
| `replay.ts` | Ricostruisce un transcript dall'event log e riproduce una sessione |
| `participants/` | Ruoli participant bundled (`analyst`, `architect`, `dev`, `qa`) — tier 4 della mappa di precedenza. Non modificarli per personalizzare: usa gli override |
| `examples/` | File di esempio validati dai loader di produzione (file participant, override, coordination file, blocco preferenze) |
| `docs/` | Documentazione bilingue: contributor guide, user guide, architecture — ogni pagina esiste come `.md` EN più la controparte `.it.md` |
| `tests/` | La suite `node:test`: file di test, fixture condivise, loader TS ESM |
| `scripts/` | Tool di sviluppo: `check-links.mjs` (link checker) e `setup-types.mjs` (vende le dichiarazioni `.d.ts` dell'SDK in `vendor/`) |
| `vendor/pi-coding-agent/` | Dichiarazioni di tipo vendored dell'SDK gsd-pi, populate da `npm run setup-types` |

## La directory di moduli `src/`

| File | Scopo |
| --- | --- |
| `discussion-arena-coordination.ts` | Loader del coordination file: `loadDiscussionArenaCoordination` (mai throw, diagnostica D053 su stderr) |
| `parse-discussion-arena-block.ts` | `parseDiscussionArenaBlock`: parsa il blocco di preferenze scritto dal wizard |
| `preferences-writer.ts` | `writeDiscussionArenaPreference`: persiste le preferenze in modo atomico |
| `tui-wizard.ts` | `attachDiscussionArenaWizard`: wizard di setup interattivo |
| `hooks-planning.ts` | `attachDiscussionArenaHooks`: hook che iniettano il planning marker |
| `discussion-arena-cli.ts` / `discussion-arena-cli-main.ts` | CLI: dump dei partecipanti e main entry |
| `log-prefix.ts` | `LOG_PREFIX` = `[discussion-arena]`, la superficie diagnostica D053 |
| `markers.ts` | Planning instruction marker |
| `shared-parser.ts` | Re-esporta il parser del blocco per compatibilità |

## Dove va ogni cosa

- **Un nuovo ruolo participant** è un file Markdown con frontmatter; gli
  esempi bundled vivono in `participants/`, i ruoli di progetto in
  `.gsd/discussion-arena/participants/`. Se il ruolo è destinato alla
  distribuzione, aggiungi una copia realistica in `examples/participants/`
  così che sia coperto da `tests/examples-validation.test.ts`.
- **Un esempio di override** vive in `examples/participants-overrides/` e
  deve puntare a un ruolo base tramite il campo `name` (mai `skipBundled`
  nei test).
- **Una pagina di documentazione** deve esistere come coppia bilingue: il
  file EN più la controparte `.it.md`, con il link incrociato nella prima
  riga di entrambi.
- **Un nuovo file di esempio** sotto `examples/` deve caricare attraverso il
  suo loader di produzione ed essere registrato in `COVERED_EXAMPLE_FILES` —
  la guardia rifiuta file di esempio senza owner.

## Cosa impone il link checker

`node scripts/check-links.mjs` cammina su ogni file `*.md` a partire dalla
root del repository (escludendo le directory nascoste, `node_modules/`,
`vendor/` e l'archivio deliberativo) e verifica che ogni link locale risolva
a un file esistente:

- link inline (la sintassi markdown a parentesi quadre più parentesi tonde) e immagini, più gli autolink con schema URI o
  estensione documentale;
- il contenuto dentro i code fence **non** viene ispezionato;
- un fragment (`#...`) viene rimosso prima della risoluzione; i target
  esterni (`http:`, `mailto:`, `//host`, `/abs`) e le ancora nude vengono
  saltati;
- un link rotto stampa `file:riga: target` su stdout e lo script esce con
  codice 1; zero link rotti esce con 0.

`tests/docs-links.test.ts` estende lo stesso checker sul corpus documentale
con quattro regole aggiuntive non negoziabili:

1. ogni documento ha la sua variante `.it.md` (e viceversa);
2. il link incrociato tra le due varianti è bilaterale;
3. nessun documento linka l'archivio deliberativo (`docs/discussion-arena-deliberation-archive.md`, D069);
4. il set minimo documentale (coppia README + i sei index delle sezioni) resta presente.

## La convenzione documentale bilingue

L'inglese è la lingua canonica; la versione italiana è una traduzione dello
stesso contenuto, non un documento separato. La coppia condivide lo stem
(`project-layout.md` ↔ `project-layout.it.md`), la prima riga porta i link
incrociati e **gli identificatori tecnici non si traducono mai**:
`discoverParticipants`, `npm test`, `participants/` e `rounds_default`
restano invariati in entrambe le lingue. Se aggiungi una pagina, aggiungi
entrambi i file nella stessa modifica — altrimenti la suite fallisce.

## Documentazione correlata

- [Guida per i contributor](index.it.md) — navigazione e convenzioni
- [Partecipanti](participants.it.md) — file participant, precedenza e override
- [Coordination file](coordination-file.it.md) — default, ruoli virtuali, warning del loader
- [Testing](testing.it.md) — eseguire la suite e aggiungere guardie
- [Guida per l'utente](../user-guide/index.it.md) — installare e usare l'estensione
- [Architecture Reference](../architecture/index.it.md) — come funziona la discussion arena internamente
- [README](../../README.it.md) — panoramica, quickstart e limiti noti
