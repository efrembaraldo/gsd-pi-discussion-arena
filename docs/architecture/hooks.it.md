**Languages:** [English](hooks.md) · [Italiano](hooks.it.md)

[Architecture Reference](index.md) — Hook di planning

# Hook di planning

`attachDiscussionArenaHooks` (`src/hooks-planning.ts:34`) è il singolo
punto di registrazione che trasforma la decisione del trigger (vedi la
pagina [*Risoluzione del trigger*](trigger-resolution.md)) in
comportamento runtime: registra tre hook del ciclo di vita gsd-pi —
`unit_start`, `adjust_tool_set` e `before_agent_start` — sull'API
dell'estensione. Tutti e tre condividono una closure che traccia la fase
corrente, e i due che mutano la sessione agiscono sotto un'unica condizione
congiunta: `currentPhase === "planning"` **e**
`resolveTrigger.decision === "forced"`. Quando quella condizione non vale,
gli hook non ritornano nulla e non cambiano nulla. Tutto in questa pagina è
ancorato al sorgente: ogni simbolo e riga citati qui sono verificati contro
il codice corrente da `tests/architecture-refs.test.ts`, quindi un rename o
uno spostamento di una funzione fa fallire la suite invece di lasciare
marcire questa pagina.

## Contratto di registrazione (`src/hooks-planning.ts:34`)

La funzione di attach riceve l'API, un contesto e l'output del trigger già
risolto, e registra gli hook in un ordine fisso:

```ts
export function attachDiscussionArenaHooks(
 api: ExtensionAPI,
 ctx: ExtensionContext,
 resolveTrigger: ResolveTriggerOutput,
): void
```

Il tipo `ResolveTriggerOutput` è importato da `trigger-resolver.ts` — lo
stesso contratto di decisione documentato nella pagina *Risoluzione del
trigger* — e `PLANNING_INSTRUCTION_MARKER` è importato da `./markers.js`
(`src/markers.ts:17`). La variabile della closure `currentPhase` parte dal
letterale `"unknown"` (`src/hooks-planning.ts:40`) e viene aggiornata dal
primo hook; il secondo e il terzo la leggono.

## Hook 1 — `unit_start`: tracciamento della fase

```ts
api.on("unit_start", (event) => { ... });
```

Quando una unit inizia, l'hook legge `event.unitType` e lo mappa sulla fase
a cui reagiscono gli altri hook:

| `event.unitType` | `currentPhase` diventa |
| --- | --- |
| `planning` | `planning` |
| `execution` | `execution` |
| `verifying` | `verifying` |
| `closeout` | `closeout` |
| qualsiasi altro valore | `unknown` |

Questo hook non muta mai nulla tranne la closure: il suo unico compito è
tenere `currentPhase` sincronizzato con la sessione, così i due hook che
mutano sanno se si trovano dentro una unit di planning.

## Hook 2 — `adjust_tool_set`: esposizione del tool

```ts
api.on("adjust_tool_set", (event) => { ... });
```

L'hook valuta la condizione congiunta `currentPhase === "planning" &&
resolveTrigger.decision === "forced"`. Solo quando entrambe valgono:

1. copia `event.activeToolNames` in un nuovo array;
2. aggiunge `discussion_arena` se il nome non è già presente;
3. ritorna `{ toolNames }` così il runtime applica il set aggiornato.

Tre proprietà meritano nota:

- **Solo additivo** — l'hook non rimuove mai un tool, quindi esporre la
  discussion arena non può mai togliere un altro tool all'agente.
- **Idempotente** — se `discussion_arena` è già nel set attivo, il set
  ritornato è identico all'input.
- **Non interferente** — in ogni altra fase, e quando la decisione è
  `available-only`, l'hook non ritorna nulla, quindi il set di tool passa
  invariato. In quei casi il tool resta chiamabile: semplicemente non viene
  *forzato* nel set.

## Hook 3 — `before_agent_start`: iniezione dell'istruzione

```ts
api.on("before_agent_start", (event) => { ... });
```

Sotto la stessa condizione congiunta, l'hook appende un'istruzione di
planning idempotente al system prompt dell'agente. Il blocco aggiunto è
costruito da due costanti:

```ts
const marker = `\n\n${PLANNING_INSTRUCTION_MARKER}\n${DISCUSSION_ARENA_INSTRUCTION}`;
```

- `PLANNING_INSTRUCTION_MARKER` (`src/markers.ts:17`) è il letterale
  `<!-- gsd-pi-discussion-arena-planning-instruction -->` — un commento
  HTML che ancora il testo iniettato;
- `DISCUSSION_ARENA_INSTRUCTION` è l'istruzione italiana
  "Usa discussion_arena prima di decidere il piano".

L'iniezione è protetta dal marker: se
`event.systemPrompt.includes(PLANNING_INSTRUCTION_MARKER)` è già true,
l'hook non ritorna nulla. È questo che rende l'iniezione **idempotente
attraverso i turni**: il system prompt evolve tra le unit, ma il marker non
appare mai due volte, quindi una unit di planning che gira dopo una unit di
planning precedente non accumula istruzioni duplicate.

## Quando gli hook non fanno nulla

Entrambi gli hook che mutano sono controllati dalla condizione congiunta.
In ogni altra combinazione — `available-only` con qualunque fase, o
qualsiasi fase non-planning con `forced` — la sessione passa senza
modifiche:

- nessun tool viene aggiunto al set attivo;
- nessuna istruzione viene appesa al system prompt;
- nessun hook ritorna un valore.

Questo è il contratto di *disponibilità* del trigger: `available-only`
significa che il tool esiste e può essere chiamato, non che all'agente
viene detto di usarlo. L'hook `unit_start` gira comunque e traccia la fase
in ogni caso, perché la contabilità della fase è sempre utile.

## Il marker come contratto runtime

`PLANNING_INSTRUCTION_MARKER` è deliberatamente un letterale stabile
piuttosto che un valore generato: `tests/hooks-planning.test.ts` asserisce
il comportamento di idempotenza degli hook (un secondo `before_agent_start`
dopo il primo non duplica l'istruzione), e il marker è la stringa su cui
quelle asserzioni si basano. Rinominare il marker in silenzio farebbe
smettare di combaciare la guardia — il test lo intercetta, perché una nuova
iniezione verrebbe appesa a un prompt che porta già il vecchio marker.

## Documentazione correlata

- [Architecture Reference](index.md) — indice del reference interno
- [Risoluzione del trigger](trigger-resolution.md) — come viene prodotta la decisione `forced` / `available-only`
- [Matrice dei runtime tier](runtime-tier-matrix.it.md) — la decisione force vs availability-only per fase e gruppo
- [Flusso di invocazione](invocation-flow.it.md) — come gli hook vengono agganciati durante `activate`
- [User Guide](../user-guide/index.md) — installazione e uso dell'estensione
- [Contributor Guide](../contributor-guide/index.md) — convenzioni del repository
- [README](../../README.md) — panoramica, quickstart e limitazioni note
