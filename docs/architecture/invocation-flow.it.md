**Lingue:** [English](invocation-flow.md) · [Italiano](invocation-flow.it.md)

[Riferimento architetturale](index.it.md) — Flusso di invocazione

# Flusso di invocazione

Questa pagina traccia cosa succede tra la richiesta di una discussione e il
transcript restituito. Ci sono tre entry point — il tool `discussion_arena`
in auto mode, il comando `/discussion-arena` nelle sessioni interattive e la
CLI standalone `--dump-participants` — e convergono tutti su un unico
motore: `runDiscussionArena` (`index.ts:440`). Tutto ciò che è citato in
questa pagina è ancorato al sorgente: ogni simbolo e riga citati qui è
verificato contro il codice attuale da `tests/architecture-refs.test.ts`,
quindi un rename o uno spostamento di funzione fa fallire la suite invece di
lasciare che questa pagina marcisca in silenzio.

## Entry point

| Entry point | Superficie | Dove è cablato |
| --- | --- | --- |
| Tool `discussion_arena` | auto mode, invocato dall'agente | `api.registerTool(...)` dentro `activate` (`index.ts:947`) |
| Comando `/discussion-arena` | sessione interattiva | `api.registerCommand("discussion-arena", ...)` dentro `activate` |
| CLI `--dump-participants` | processo standalone, senza runtime gsd-pi | `src/discussion-arena-cli-main.ts` → `dumpParticipantsCli` (`src/discussion-arena-cli.ts:124`) |
| `main(argv, cwd)` | API programmatica, senza runtime gsd-pi | esportata da `index.ts:101` |

Tool e comando condividono lo stesso motore; la CLI è una superficie
diagnostica che non esegue mai una discussione. `main` programmatico è la
controparte API dell'entry point CLI: delega alla stessa
`dumpParticipantsCli` ma ritorna l'exit code invece di terminare il processo.

## Attivazione dell'estensione: `activate` (`index.ts:903`)

Quando gsd-pi carica l'estensione chiama il default export una sola volta,
in modo sincrono, al momento del load:

```ts
export default function activate(api: ExtensionAPI) {
```

Dentro `activate` l'estensione:

1. risolve la decisione del trigger con `resolveTrigger(...)` — il risultato
   decide se gli hook di planning obbligano la discussion arena o la
   espongono soltanto (fire-and-forget: un errore scrive
   `[discussion-arena] error resolving trigger during activate` su stderr e
   non blocca l'attivazione);
2. aggancia gli hook di planning (`attachDiscussionArenaHooks`) con quella
   decisione;
3. aggancia il wizard TUI di milestone-start
   (`attachDiscussionArenaWizard`), che scrive
   `.gsd/PREFERENCES.md` quando l'utente sceglie una strategia di
   attivazione;
4. registra il tool e il comando.

La decisione del trigger e gli hook sono trattati nelle loro pagine
(*Risoluzione del trigger* e *Hook*); qui il punto è che la superficie di
registrazione è `activate`, quindi ogni nuovo entry point o parametro parte
da lì.

## Registrazione del tool e schema dei parametri (`index.ts:947`, `index.ts:109`)

Il tool è registrato con:

```ts
api.registerTool({
  name: "discussion_arena",
  label: "Discussion Arena",
  ...
  parameters: DiscussionArenaParamsSchema,
  execute: async (_toolCallId, params, signal, onUpdate, ctx) => { ... },
});
```

Il contratto dei parametri è lo schema TypeBox, dichiarato subito sopra i
limiti rigidi nello stesso file:

```ts
const DiscussionArenaParamsSchema = Type.Object({
  topic: Type.String({ ... }),
  participants: Type.Optional(Type.Array(Type.String(), { ... })),
  rounds: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_ROUNDS, ... })),
  ...
});
```

La validazione avviene prima che `execute` parta: una chiamata con `rounds`
fuori range o `topic` mancante non raggiunge mai il motore. Lo schema
incorpora le costanti del codice — il massimo di `rounds` è `MAX_ROUNDS`
dello stesso file — quindi lo schema non può allontanarsi dai limiti che
documenta.

## Il percorso del tool in auto mode

Una invocazione del tool attraversa il callback `execute` in quest'ordine:

1. **Scorciatoia replay** — se `params.replay` è impostato, il tool ri-deriva
   il transcript dall'event log JSONL persistito (`replayDiscussionArena`)
   e lo restituisce senza avviare alcun subprocesso. Un id sconosciuto
   produce una risposta esplicita "nessun event log trovato".
2. **Risoluzione dei round** — `rounds` parte da `DEFAULT_ROUNDS` (livello 4
   della gerarchia dei round), poi si applica la risoluzione a quattro
   livelli (`resolveRoundsDefault`) e il risultato viene clampato con
   `Math.min(parsed, MAX_ROUNDS)` — il clamp è l'ultimo passo, quindi un
   default di coordinamento sopra il cap non può mai produrre più round del
   limite.
3. **Chiamata al motore** — `runDiscussionArena` viene invocata con il
   topic, i partecipanti richiesti, i round risolti, `ctx.cwd`, il segnale
   di abort, il callback di progresso (`onUpdate`), i limiti a livello tool
   e il flag `eventLog`.
4. **Persistenza della sessione** — il transcript restituito viene salvato
   via `getSessionFilePath` / `loadSession` / `saveSession` (trattato nella
   pagina *Orchestrazione dei round*); un errore di
   salvataggio non è fatale (`[discussion-arena] warning` su stderr).
5. **Risposta** — un blocco di testo con la riga di intestazione
   (`Partecipanti: ... | Round: ... | Costo totale stimato: ... | Esito: ...`),
   il transcript completo, il path della sessione e, con `eventLog` attivo,
   il path dell'event log; `details` trasporta `participantsUsed`,
   `totalCost`, `rounds`, `outcome` e il `discussionArenaId`.

## Il percorso del comando

Il comando interattivo è registrato nella stessa chiamata `activate`:

```text
/discussion-arena <topic> [N round] [--continue|--new] [--model <id>]
```

L'handler parsa la riga con `parseCommandArgs` (la `N` esplicita gioca il
ruolo del livello 1 della gerarchia dei round, anch'essa clampata), legge il
file di coordinamento per il default di livello 3, carica la sessione
esistente per `--continue`, poi chiama lo stesso motore `runDiscussionArena`.
Progresso e risultato finale arrivano via `ctx.ui.notify`; senza topic
stampa la riga di uso insieme ai partecipanti scoperti.

## Il motore condiviso: `runDiscussionArena` (`index.ts:440`)

```ts
export async function runDiscussionArena(
  topic: string,
  requestedNames: string[] | undefined,
  rounds: number,
  cwd: string,
  signal: AbortSignal | undefined,
  onProgress: (partialTranscript: string) => void,
  ...
): Promise<{ transcript: string; participantsUsed: string[]; totalCost: number; outcome: "complete" | "partial"; discussionArenaId?: string }>
```

Il motore è il punto unico in cui una discussione accade davvero:

1. **Discovery** — `discoverParticipants(cwd)` attraversa i tier dei
   partecipanti (progetto, utente, bundled) e carica il file di
   coordinamento.
2. **Selezione** — `selectParticipants` tiene i nomi richiesti e cappa il
   risultato a `MAX_PARTICIPANTS`; una selezione vuota lancia un errore
   esplicito che elenca i partecipanti disponibili.
3. **Limiti per partecipante** — `resolveParticipantLimits` viene applicato
   una volta per partecipante (tool > frontmatter > default) e loggato su
   stderr.
4. **Loop dei round** — per ogni round, ogni partecipante vivo esegue un
   turno in un subprocesso isolato (`runParticipantTurn`, trattato nella
   pagina *Subprocessi partecipante*); il
   transcript cumulativo viene assemblato e passato al round successivo
   così i partecipanti successivi vedono gli interventi precedenti.
5. **Risultato** — il transcript cumulativo, i nomi dei partecipanti usati,
   il costo totale, l'esito (`complete` quando nessun partecipante muore a
   metà run, `partial` altrimenti) e, con `eventLog`, il
   `discussionArenaId`.

Una continuazione inietta `transcript` e `roundOffset` nel motore: è così
che `--continue` aggiunge round con numerazione continua.

## La CLI standalone e `main` (`src/discussion-arena-cli-main.ts`, `src/discussion-arena-cli.ts:124`, `index.ts:101`)

La CLI è volutamente isolata dal runtime gsd-pi. L'entry point di processo è
`src/discussion-arena-cli-main.ts`, il cui intero corpo è:

```ts
import { dumpParticipantsCli } from "./discussion-arena-cli.js";

dumpParticipantsCli(process.argv, process.cwd());
```

`dumpParticipantsCli` (`src/discussion-arena-cli.ts:124`) parsa `argv` per
il flag booleano `--dump-participants`: con il flag scrive il dump dei
partecipanti su stdout (exit code 0) o su stderr (exit code 1) e termina il
processo; senza flag è un no-op che ritorna 0. La controparte programmatica
`main(argv, cwd)` (`index.ts:101`) è esportata dal modulo dell'estensione e
delega alla stessa funzione senza il `process.exit`.

```text
node --import ./tests/ts-esm-loader.mjs src/discussion-arena-cli-main.ts --dump-participants
```

## Percorsi di errore e parziali

- **Nessun partecipante valido** — il motore lancia un errore il cui
  messaggio elenca i ruoli disponibili; il catch del tool lo trasforma in
  una risposta di testo d'errore
  (`Errore nell'esecuzione della discussion-arena: ...`) con `details`
  vuoti.
- **Errore del trigger durante l'attivazione** — loggato su stderr,
  l'attivazione continua (vedi `activate` sopra).
- **Errore di salvataggio della sessione** — warning non fatale su stderr,
  il risultato della run viene comunque restituito.
- **Morte del subprocesso / budget esaurito / timeout** — gestiti dentro il
  motore e riflessi nell'esito e nei marker; trattati nelle
  pagine *Subprocessi partecipante* e *Limiti runtime*.
- **Errore di discovery della CLI** — `dumpParticipantsCli` scrive l'errore
  su stderr ed esce con 1.

## Documentazione correlata

- [Riferimento architetturale](index.it.md) — indice del riferimento interno (risoluzione del trigger, hook, subprocessi partecipante, orchestrazione dei round e limiti runtime sono trattati nelle loro pagine)
- [User Guide](../user-guide/index.it.md) — installare e usare l'estensione
- [Contributor Guide](../contributor-guide/index.it.md) — convenzioni del repository
- [README](../../README.it.md) — panoramica, quickstart e limiti noti
