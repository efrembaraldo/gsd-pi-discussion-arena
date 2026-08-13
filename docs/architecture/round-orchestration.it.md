**Lingue:** [English](round-orchestration.md) · [Italiano](round-orchestration.it.md)

[Riferimento architetturale](index.it.md) — Orchestrazione dei round

# Orchestrazione dei round

Questa pagina documenta come il motore compone i turni dei partecipanti in
una discussione: il loop dei round in `runDiscussionArena`
(`index.ts:440`), la risoluzione del numero di round a quattro livelli, il
budget del prompt che tiene il transcript entro i limiti argv e la
persistenza della sessione che rende possibili gli append di `--continue`.
Ogni simbolo, riga e valore citato qui è verificato contro il codice
attuale da `tests/architecture-refs.test.ts`, quindi un rename di una
funzione o uno spostamento di dichiarazione fa fallire la suite invece di
lasciare che questa pagina marcisca in silenzio.

La meccanica del subprocess per-turno (spawn, parsing degli eventi, timer)
è nella pagina *Subprocessi partecipante*; i limiti rigidi attorno a essi
sono nella pagina *Limiti runtime*.

## Il loop dei round (`index.ts:440`)

`runDiscussionArena` (`index.ts:440`) esegue `rounds` iterazioni della
discussione. In ogni round ogni partecipante selezionato fa un turno, **in
sequenza e deliberatamente** — ogni partecipante vede gli interventi che
gli altri hanno già dato nello stesso round (un dialogo reale, non N
risposte indipendenti). Il commento nel sorgente a `index.ts:440` nota che
un dibattito davvero simultaneo richiederebbe di costruire tutti i prompt
del round prima di eseguirli e di lanciarli con `Promise.all`; l'ordine
sequenziale è il comportamento di produzione.

La numerazione dei round è continua attraverso le continuazioni: il motore
calcola `roundNumber = round + 1 + roundOffset`, dove `roundOffset`
proviene da una sessione ripresa. Il primo round di una sessione usa
`buildRoundPrompt` con `roundIndex === 0`, che chiede una posizione
iniziale basata solo sul ruolo; i round successivi ricevono il transcript
cumulativo e chiedono al partecipante di rispondere agli altri.

I failure per-turno non abortiscono il round: un partecipante morto viene
saltato con `[PARTICIPANT SKIPPED: <id>]`, e se **tutti** i partecipanti
selezionati sono morti alla fine di un round, il loop esce in anticipo
(`allDead`). Il risultato riporta `outcome: "complete" | "partial"` a
seconda che un partecipante sia morto o meno.

## Risoluzione del numero di round: `resolveRoundsDefault` (`participants.ts:585`)

Il numero di round è risolto attraverso una gerarchia a quattro livelli,
applicata da `resolveRoundsDefault` (`participants.ts:585`):

```text
tool param (1) > frontmatter partecipante (2, N/A) >
coordination.rounds_default (3) > code DEFAULT_ROUNDS (4)
```

- livello 1 — il parametro `rounds` del tool (o la `N` esplicita in
  `/discussion-arena <topic> N`);
- livello 2 — il frontmatter del partecipante: riservato, `N/A` oggi
  (`rounds` è una proprietà della discussion arena, non di un singolo partecipante);
- livello 3 — `rounds_default` dal coordination file
  `discussion-arena-coordination.md`, letto dal walk-up in
  `discoverParticipants`;
- livello 4 — il default di codice `DEFAULT_ROUNDS` (`2`).

`resolveRoundsDefault` è una funzione pura che non lancia mai: un valore
invalido a un livello degrada al successivo. Il clamp a `MAX_ROUNDS` è
deliberatamente **fuori** da essa — `participants.ts` non può importare
`MAX_ROUNDS` da `index.ts` senza una dipendenza circolare — quindi il
chiamante in `index.ts` applica `Math.min(result, MAX_ROUNDS)` come ultimo
passo del cablaggio (vedi *Limiti runtime*, punto di enforcement 2).

## Budget del prompt: `truncateTranscriptForPrompt` (`index.ts:203`)

Il transcript cresce a ogni round, e una run `--continue` vi appende.
Passare il transcript completo nel prompt supererebbe prima o poi il
limite argv di `spawn` (tipicamente ~2 MB su Linux, ~256 KB su macOS) e
fallirebbe con `E2BIG`. `truncateTranscriptForPrompt` (`index.ts:203`)
cappa la copia per il prompt a `maxBytes: number = 100_000` di default:

```ts
function truncateTranscriptForPrompt(
 transcript: string,
 maxBytes: number = 100_000,
): string {
```

Divide il transcript ai confini dei round (la regex `\n\n(?=### Round
\d+)`), tiene i round più recenti che stanno dentro `maxBytes` e prefissa
il risultato con `[...round più vecchi omessi per limite prompt...]`. Se un
singolo round da solo è più grande del budget, l'ultimo blocco viene
troncato con il marker `[...troncato per limite prompt...]`. È una
troncatura solo per il prompt: il file di sessione su disco conserva sempre
il transcript completo, quindi nulla è perso per l'utente.

## Persistenza della sessione (`discussion-arena-session.ts`)

Il transcript cumulativo è persistito per progetto così che invocazioni
successive di `/discussion-arena "topic" --continue` possano appendere
round con numerazione continua (1, 2 → 3, 4 → 5, …). Il layout di
storage:

```text
<cwd>/.gsd/discussion-arena/transcripts/<cwdHash>-<topic-slug>.md
```

- `getSessionFilePath` (`discussion-arena-session.ts:50`) calcola il path:
  la directory letterale `"transcripts"` sotto
  `<cwd>/.gsd/discussion-arena/`, con un hash SHA-256 corto del cwd
  (`cwdHashShort`) e un topic slugificato (`topicSlug`, max 50 caratteri)
  per disambiguare i topic tra progetti;
- `loadSession` (`discussion-arena-session.ts:61`) legge e parsa una
  sessione esistente, ritornando `null` se il file manca o è corrotto — il
  chiamante allora riparte da zero;
- `saveSession` (`discussion-arena-session.ts:78`) scrive la sessione,
  creando la directory se serve, come frontmatter YAML minimale (`topic`,
  `participants`, `startedAt`, `lastUpdatedAt`, `rounds`) più il body
  markdown con il transcript completo.

Il flusso `--continue` del motore carica la sessione e poi passa
`continuation = { transcript, roundOffset: existing.rounds }` a
`runDiscussionArena`: il transcript riparte da dove si era fermato e i
nuovi round continuano la numerazione. La persistenza non è fatale: un
`saveSession` fallito produce un warning su stderr, mai un errore nella
run.

## Cosa questa pagina non copre

- **Meccanica del subprocess per-turno** — spawn, parsing degli eventi,
  timer, terminazione: vedi *Subprocessi partecipante*.
- **I limiti e il loro enforcement** — `MAX_ROUNDS`, il clamp dei round e
  i timer per-turno: vedi *Limiti runtime*.
- **Come si entra e si attiva la discussion arena** — flusso di invocazione, trigger e
  hook di planning: vedi *Flusso di invocazione*, *Risoluzione del
  trigger* e *Hook di planning*.

## Documentazione correlata

- [Riferimento architetturale](index.it.md) — indice del riferimento interno
- [Flusso di invocazione](invocation-flow.it.md) — dove viene entrato il motore e cablato il loop dei round
- [Risoluzione del trigger](trigger-resolution.it.md) — come viene attivata la discussion arena
- [Hook di planning](hooks.it.md) — come il tool viene esposto durante il planning
- [Limiti runtime](runtime-limits.it.md) — i limiti applicati attorno a ogni round
- [Subprocessi partecipante](participant-subprocesses.it.md) — come viene eseguito il turno di un singolo partecipante
- [User Guide](../user-guide/index.it.md) — installazione e uso dell'estensione
- [Contributor Guide](../contributor-guide/index.it.md) — convenzioni del repository
- [README](../../README.it.md) — panoramica, quickstart e limitazioni note
