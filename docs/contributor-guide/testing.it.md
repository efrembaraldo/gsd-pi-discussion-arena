**Lingue:** [English](testing.md) · [Italiano](testing.it.md)

[Guida per i contributor](index.it.md) — Testing

# Testing

Il repository usa il test runner integrato di Node (`node:test`) e importa
il sorgente TypeScript attraverso un piccolo resolve hook ESM — niente
bundler, niente Jest, nessuna dipendenza extra (D004). Questa pagina spiega
come eseguire la suite, cosa protegge ogni gruppo di file e come aggiungere
un test senza rompere il contratto di enforcement.

## Eseguire la suite

```bash
npm test                                 # suite completa (discovery node:test)
npm run typecheck                        # tsc --noEmit sui sorgenti di produzione
node scripts/check-links.mjs             # zero link markdown locali rotti
node --import ./tests/ts-esm-loader.mjs --test tests/<file>.test.ts   # singolo file
```

| Comando | Cosa fa |
| --- | --- |
| `npm test` | Esegue `node --import ./tests/ts-esm-loader.mjs --test`: `node:test` scopre ogni `*.test.ts` sotto `tests/` e lo esegue |
| `npm run typecheck` | Prima esegue `scripts/setup-types.mjs` (vende i file `.d.ts` dell'SDK), poi `tsc --noEmit --pretty false` sui sorgenti di produzione |
| `node scripts/check-links.mjs` | Verifica che ogni link markdown locale del repository risolva; exit 0 significa pulito, un link rotto stampa `file:riga: target` ed esce con 1 |
| `node --import ./tests/ts-esm-loader.mjs --test tests/<file>.test.ts` | Esegue un singolo file di test in isolamento — il loop veloce mentre sviluppi una guardia |

## Il loader TS ESM

I test importano il codice di produzione con gli stessi specifier usati dal
runtime — per esempio `import { discoverParticipants } from "../participants.js"`
— e l'hook mappa lo specifier `.js` sul sorgente `.ts`.
`tests/ts-esm-loader.mjs` registra `tests/ts-hooks.mjs` tramite
`module.register`; oltre al remapping `.js` → `.ts` redirige lo specifier
bare `@gsd/pi-coding-agent` allo stub locale in `tests/fixtures/`. Ecco
perché ogni comando che esegue la suite passa `--import ./tests/ts-esm-loader.mjs`:
senza l'hook gli import fallirebbero con `ERR_MODULE_NOT_FOUND` e lo
specifier bare non si risolverebbe mai (è un workspace package di gsd-pi,
non un pacchetto npm pubblicato).

## Cosa proteggono le suite

Le suite di enforcement sono la parte eseguibile delle convenzioni
documentali:

| File | Contratto |
| --- | --- |
| `tests/docs-links.test.ts` | Convenzione bilingue su tutto il corpus docs: ogni `.md` ha la sua coppia `.it.md`, i link incrociati sono bilaterali, nessun documento linka l'archivio deliberativo (D069), il set minimo documentale resta presente |
| `tests/contributor-guide-snippets.test.ts` | Ogni snippet copiabile fencato come `participant` / `coordination` nella contributor guide carica attraverso i loader di produzione (`discoverParticipants`, `loadDiscussionArenaCoordination`) con zero warning; i fence `*-invalid` producono esattamente il comportamento registrato (skip o warning D053) |
| `tests/examples-validation.test.ts` | Ogni `.example.md` sotto `examples/` carica attraverso il suo loader di produzione; la guardia `COVERED_EXAMPLE_FILES` rifiuta file di esempio senza owner |
| `tests/naming-residue.test.ts` | Nessun residuo di naming legacy nei file `.ts` / `.md` / `.json` tracked e untracked: il token legacy è ammesso solo se preceduto dal qualificatore `discussion` |
| `tests/user-guide-snippets.test.ts` | Lo stesso pattern di snippet-harness applicato alle pagine della user guide |
| `tests/check-links.test.ts` | Il link checker stesso: rilevamento link rotti, classificazione dei target e comportamento CLI, su fixture |

Le suite comportamentali coprono direttamente i moduli di produzione:
`participants.test.ts`, `participants-override.test.ts`,
`discussion-arena-coordination.test.ts`, `parse-discussion-arena-block.test.ts`,
`discussion-arena-cli.test.ts`, `discussion-arena-session.test.ts`,
`discussion-arena-loop.test.ts`, `index.test.ts`, `helpers.test.ts`,
`metrics.test.ts`, `replay.test.ts`, `trigger-resolver.test.ts`,
`preferences-writer.test.ts`, `tui-wizard.test.ts`, `event-log.test.ts`,
`timeout-watchdog.test.ts`, `hooks-planning.test.ts` e gli scenari di
accettazione (`acceptance-scenario-1/2/3.test.ts`, `e2e-auto-mode.test.ts`).

## Aggiungere un test o una guardia

- Usa `node:test` e `node:assert/strict` — nessuna dipendenza da framework.
- Importa la funzione di produzione ed esercitala; un test deve provare il
  comportamento attraverso il loader reale, non attraverso una
  reimplementazione (proof by production loader, MEM137).
- Le fixture che richiedono stato su filesystem vivono in `os.tmpdir()` e
  vengono pulite in `afterEach` — mai in path del repository che i test non
  devono toccare.
- Rendi i messaggi di fallimento autoesplicativi: nomina il file e la riga
  offendenti (per esempio `pagina:riga` di un fence markdown) così un test
  rosso indica la correzione senza bisecare.
- Per una nuova guardia, rispecchia i casi negativi: ogni dimensione di
  enforcement ha un test su fixture che prova che la guardia scatta davvero
  — un enforcement che non può mai fallire non è un enforcement.

## Evitare le regressioni

Prima di chiudere una modifica, esegui la tripla completa: `npm test`,
`npm run typecheck` e `node scripts/check-links.mjs`. La baseline di M006
richiede almeno 359 test verdi; le suite di enforcement elencate sopra sono
ciò che mantiene caricabili il corpus bilingue, i file di esempio e gli
snippet copiabili.

## Documentazione correlata

- [Guida per i contributor](index.it.md) — navigazione e convenzioni
- [Layout del progetto](project-layout.it.md) — dove vive ogni suite e modulo
- [Partecipanti](participants.it.md) — file participant, precedenza e override
- [Coordination file](coordination-file.it.md) — default, ruoli virtuali, warning del loader
- [Guida per l'utente](../user-guide/index.it.md) — installare e usare l'estensione
- [README](../../README.it.md) — panoramica, quickstart e limiti noti
