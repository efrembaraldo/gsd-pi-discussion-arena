**Lingue:** [English](participant-subprocesses.md) · [Italiano](participant-subprocesses.it.md)

[Riferimento architetturale](index.it.md) — Subprocessi partecipante

# Subprocessi partecipante

Questa pagina documenta come la discussion arena esegue il turno di un
singolo partecipante: la discovery di chi è disponibile, lo spawn di un
subprocess `gsd` isolato in modalità print/JSON, il parsing degli eventi su
stdout e il post-processing che trasforma il turno grezzo nell'entry del
transcript. Ogni simbolo, riga e valore citato qui è verificato contro il
codice attuale da `tests/architecture-refs.test.ts`, quindi un rename di
una funzione o uno spostamento di dichiarazione fa fallire la suite invece
di lasciare che questa pagina marcisca in silenzio.

I limiti per-turno (timer, modalità di terminazione, soglia di troncatura,
budget) sono documentati nella pagina *Limiti runtime*; questa pagina si
concentra sulla meccanica di processo attorno a essi.

## Discovery: `discoverParticipants` (`participants.ts:438`)

Prima di qualsiasi turno il motore risolve il roster dei partecipanti con
`discoverParticipants` (`participants.ts:438`), che carica le definizioni
di ogni ruolo da cinque sorgenti, fuse per nome con precedenza fissa (vince
la più alta):

```text
override > virtual > project > user > bundled
```

- **override** — `.gsd/discussion-arena/participants-overrides/*.md`,
  walk-up verso la root git; un file `<role>.md` sostituisce per intero la
  base corrispondente. Un override senza base è un orfano e fa lanciare a
  `discoverParticipants` un errore bloccante — nessun fallback silenzioso;
- **virtual** — ruoli definiti nel coordination file
  `discussion-arena-coordination.md` (`roles_virtuals`); partecipanti di
  prima classe senza alcun file in `participants/`;
- **project** — `.gsd/discussion-arena/participants/*.md`, walk-up verso
  la root git;
- **user** — `~/.gsd/agent/discussion-arena/participants/*.md`;
- **bundled** — `participants/*.md` accanto al modulo installato.

Il coordination file fornisce anche `roundsDefault` (livello 3 della
gerarchia dei round, vedi *Orchestrazione dei round*) e `modelDefault`,
applicato a ogni partecipante che non dichiara un `model` esplicito.

## Spawn del subprocess del turno: `runParticipantTurn` (`run-participant.ts:131`)

Ogni turno è eseguito da `runParticipantTurn` (`run-participant.ts:131`),
che spawna un singolo subprocess `gsd` in modalità print/JSON isolata con
contesto di sessione azzerato:

```ts
const args: string[] = ["--mode", "json", "-p", "--no-session"];
```

`["--mode", "json", "-p", "--no-session"]` (`run-participant.ts:139`) è il
vettore di argomenti base. Il modello risolto e la allowlist dei tool del
partecipante vengono appesi quando presenti:

- `--model <id>` — il modello effettivo (`modelOverride ?? participant.model`);
- `--tools <lista separata da virgole>` — il sottoinsieme di tool del
  partecipante;
- `--append-system-prompt <tempfile>` — il system prompt del ruolo viene
  scritto prima in un file temporaneo (`writePromptToTempFile`) per evitare
  i limiti di lunghezza argv, poi appeso;
- infine, il prompt del turno stesso (topic + transcript cumulativo
  costruito da `buildRoundPrompt`) viene passato come argomento finale.

Il subprocess è spawnato con `shell: false`, `cwd` ereditato dal motore e
`stdio: ["ignore", "pipe", "pipe"]` — stdin chiuso, stdout che trasporta lo
stream di eventi JSON, stderr catturata per la diagnostica.

## Parsing degli eventi su stdout

Il subprocess emette un evento JSON per riga su stdout. Il runner del turno
bufferizza lo stream, lo divide sulle newline e parsa ogni riga completa; le
righe malformate vengono ignorate (non sono un failure):

- qualsiasi riga JSON parsata riarma l'event watchdog (`lastEventAt`),
  quindi ogni attività conta come liveness;
- un evento `message_end` con `message.role === "assistant"` incrementa
  `usage.turns`, accumula `usage.{input,output,cost}` (coerzione difensiva
  a number, dato che alcuni provider emettono stringhe) e raccoglie le
  parti testuali come risposta dell'assistente;
- la stderr accumulata resta in `result.stderr` per la diagnosi post-mortem.

## Ciclo di vita del turno, timer e terminazione

L'intero turno è protetto da un `AbortController` che fonde tre sorgenti di
abort — il segnale esterno di cancel di gsd-pi, il round timeout e l'event
watchdog. Il primo abort vince (`abortReason` è controllato prima di ogni
abort); la modalità di terminazione risolta dai limiti del partecipante
decide come il subprocess viene ucciso:

- `"soft"` — SIGTERM, poi un periodo di grace, poi SIGKILL;
- `"hard"` — SIGKILL immediato.

Un timeout NON lancia: `runParticipantTurn` ritorna un
`ParticipantTurnResult` con `failureKind` = `"timeout_round"` |
`"timeout_event"` e un `failureReason` leggibile, mentre `durationMs`
registra lo spawn-to-close. Un subprocess ucciso da un segnale fatale
esterno o uscito con un exit code non-zero — senza che timeout o abort
esterno abbiano agito — viene classificato come `failureKind: "failed"`
con reason `"crash <signal>"` o `"crash exit=<code>"`. L'ordine dei branch
conta: un timeout escalation a SIGKILL resta un timeout, mai un crash.

## Post-processing: costo, troncatura e limiti

Dopo un turno riuscito il motore applica tre helper puri di `helpers.ts`,
tutti ancorati qui:

- `accumulateCost` (`helpers.ts:132`) — estrae un costo da `usage`
  (accettando `usage.cost` come number, string o `{total}`, clamp a >= 0)
  e lo somma al totale corrente;
- `truncateOutput` (`helpers.ts:150`) — se il testo del turno supera
  `limits.outputLimitChars`, lo tronca e appende il marker
  `[OUTPUT TRUNCATED at N chars]`; la troncatura non è un crash. Un limite
  più piccolo del marker stesso lancia `RangeError` (config invalida);
- `resolveParticipantLimits` (`helpers.ts:313`) — fonde i tre livelli
  `toolParams > frontmatter > defaults` con validazione runtime per campo;
  i valori invalidi fanno fallback al livello inferiore con un warning su
  stderr e non lanciano mai.

Il motore cabla il frontmatter del partecipante e i parametri del tool in
`resolveParticipantLimits` una volta per partecipante prima del loop dei
round tramite `resolveParticipantLimitsForParticipant` (`index.ts:363`),
quindi ogni turno di una run usa limiti stabili e pre-risolti.

## Cosa questa pagina non copre

- **Limiti per-turno e punti di enforcement** — timer, grace di
  terminazione, soglia di troncatura e budget guard: vedi *Limiti runtime*.
- **Il loop dei round e il transcript** — come i turni compongono i round,
  la troncatura del prompt e la persistenza della sessione: vedi
  *Orchestrazione dei round*.
- **Quando gira la discussion arena** — trigger di attivazione e hook di planning: vedi
  *Risoluzione del trigger* e *Hook di planning*.

## Documentazione correlata

- [Riferimento architetturale](index.it.md) — indice del riferimento interno
- [Flusso di invocazione](invocation-flow.it.md) — dove viene entrato il motore e cablato il turn runner
- [Risoluzione del trigger](trigger-resolution.it.md) — come viene attivata la discussion arena
- [Hook di planning](hooks.it.md) — come il tool viene esposto durante il planning
- [Limiti runtime](runtime-limits.it.md) — i limiti applicati attorno a ogni turno
- [Orchestrazione dei round](round-orchestration.it.md) — il loop dei round e la persistenza della sessione
- [User Guide](../user-guide/index.it.md) — installazione e uso dell'estensione
- [Contributor Guide](../contributor-guide/index.it.md) — convenzioni del repository
- [README](../../README.it.md) — panoramica, quickstart e limitazioni note
