**Lingue:** [English](examples.md) · [Italiano](examples.it.md)

[Guida per i contributor](index.it.md) — Esempi

# Esempi

`examples/` è lo scaffale dei template del repository: i file che copi nel
tuo progetto per configurare la discussion arena. La regola che li governa è
proof by production loader, non by prose: ogni file in `examples/` viene
caricato dalla stessa funzione che l'estensione esegue a runtime — nessun
revisore li guarda a vista. La suite che lo impone è
`tests/examples-validation.test.ts`, e la guardia di copertura
`COVERED_EXAMPLE_FILES` rifiuta qualsiasi `.example.md` senza un loader che
lo possieda.

## Perché l'estensione ignora `examples/`

Nessuno dei loader di produzione legge `examples/`. `discoverParticipants`
raccoglie i participant dalla directory bundled, dalla directory utente
(`~/.pi/agent/discussion-arena/participants/`), dalla directory di progetto
(`.gsd/discussion-arena/participants/`), dai ruoli virtuali e dalla
directory override; `loadDiscussionArenaCoordination` legge
`.gsd/discussion-arena/discussion-arena-coordination.md`;
`parseDiscussionArenaBlock` parsa il blocco `discussion_arena:` di
`.gsd/PREFERENCES.md`. Il suffisso `.example.md` è il marcatore che tiene un
file come template. Una volta copiato in un path di produzione il suffisso è
innocuo: i loader leggono `*.md` e gli override vengono abbinati tramite il
campo `name` del frontmatter, non il nome del file.

## I cinque file di esempio

| File | Loader di produzione | Cosa dimostra |
| --- | --- | --- |
| `participants/architect.example.md` | `discoverParticipants` | Un participant realistico: la copia del ruolo bundled `architect` (`participants/architect.md`), con `role: Software Architect`, `tools` e `model`, senza limiti per-participante |
| `participants/_skeleton.example.md` | `discoverParticipants` | Il template per un nuovo ruolo: i tre campi obbligatori più tutti e cinque i campi limite opzionali |
| `participants-overrides/architect.example.md` | `discoverParticipants` con `options.overridesDir` | Un override totale di un ruolo bundled (`source: "override"`), che cambia `tools` e limiti senza fare merge |
| `discussion-arena-coordination.example.md` | `loadDiscussionArenaCoordination` | Il coordination file: `rounds_default`, `model_default` e un ruolo virtuale (`scribe`) parsati con zero warning |
| `PREFERENCES.example.md` | `parseDiscussionArenaBlock` (strict) + `resolveTrigger` | Il blocco `discussion_arena:` che forza l'arena per milestone (`decision: forced`, `source: preferences`) |

## Come li valida la suite

Ogni test carica il file reale attraverso il loader di produzione, in un
albero di progetto isolato sotto `os.tmpdir()` (mai un path gitignored del
repository):

- gli esempi participant vengono symlinkati in una directory utente isolata
  e scoperti con `skipBundled: true`: l'esempio deve tornare esattamente una
  volta con `source: "user"` e il suo `name` dichiarato; l'esempio architect
  deve risolvere gli stessi `role`, `tools` e `model` dichiarati nel
  frontmatter;
- l'esempio override viene copiato in `options.overridesDir` e scoperto
  **senza** `skipBundled` (MEM107): la base bundled `architect` deve restare
  nel map perché l'override non sia orfano, il risultato riporta
  `source: "override"`, `orphanOverrides: []`, la nuova lista `tools` (con
  `rg`) e i limiti per-participante;
- l'esempio coordination viene passato a `loadDiscussionArenaCoordination`:
  zero warning, `roundsDefault: 2`, `modelDefault` e il ruolo virtuale
  `scribe` presenti nella config parsata;
- l'esempio PREFERENCES viene parsato con `strict: true` (una chiave
  sconosciuta lancerebbe `DiscussionArenaParseError`) e, copiato in
  `.gsd/PREFERENCES.md` di un progetto temporaneo, guida `resolveTrigger` a
  `forced` con `source: "preferences"` per il milestone attivo `M001`.

## La guardia di copertura

`COVERED_EXAMPLE_FILES` in `tests/examples-validation.test.ts` elenca i
cinque file. Un test separato cammina ricorsivamente `examples/`, raccoglie
ogni `.example.md` e fallisce se uno non è registrato — con un messaggio che
nomina il file scoperto. Aggiungere un nuovo esempio senza un caso di
validazione e senza la voce nella guardia rompe la suite: un esempio senza
loader owner è impossibile.

## Aggiungere un esempio

1. Scrivi un file **realistico** — la forma del file di produzione, non un
   segnaposto. L'eccezione è il template `_skeleton.example.md`, i cui
   segnaposto sono il suo scopo.
2. Scegli il loader di produzione che lo leggerà una volta copiato in un
   progetto: un participant → `discoverParticipants`; un override →
   `discoverParticipants` con `options.overridesDir` (il ruolo base deve
   esistere — mai `skipBundled` nel test); un coordination file →
   `loadDiscussionArenaCoordination`; un blocco preferences →
   `parseDiscussionArenaBlock` + `resolveTrigger`.
3. Aggiungi un caso di validazione in `tests/examples-validation.test.ts`
   che carichi il file reale attraverso quel loader, con fixture in
   `os.tmpdir()`.
4. Registra il file in `COVERED_EXAMPLE_FILES`.

## L'enforcement è sensibile

La suite prova anche che i loader rifiuterebbero un esempio corrotto,
eseguendo gli stessi loader di produzione su copie mutate in directory
temporanee:

- `rounds_default: 0` in una copia del coordination → il warning D053 e
  nessun default applicato;
- una chiave sconosciuta nel blocco preferences → `DiscussionArenaParseError`
  con `strict: true`;
- una copia participant senza `role` → esclusa dalla discovery (zero
  participant trovati);
- un override la cui base non esiste → l'errore bloccante per orfano del
  loader.

Questi casi negativi sono ciò che rende non-tautologica la validità dei file
reali: la guardia scatta davvero.

Gli esempi non fanno parte del corpus documentale bilingue: non hanno la
variante `.it.md` (`tests/docs-links.test.ts` applica la convenzione solo a
docs e alla coppia README).

## Documentazione correlata

- [Guida per i contributor](index.it.md) — navigazione e convenzioni
- [Partecipanti](participants.it.md) — il file participant copiabile e lo schema del frontmatter
- [Coordination file](coordination-file.it.md) — il coordination file copiabile e i warning del loader
- [Testing](testing.it.md) — eseguire la suite e aggiungere guardie
- [Guida per l'utente](../user-guide/index.it.md) — installare e usare l'estensione
- [Architecture Reference](../architecture/index.it.md) — come funziona internamente la discussion arena
- [README](../../README.it.md) — panoramica, quickstart e limiti noti
