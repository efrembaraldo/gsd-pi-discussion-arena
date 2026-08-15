**Lingue:** [English](index.md) · [Italiano](index.it.md)

# Riferimento architetturale

Il riferimento architetturale spiega come funziona internamente la discussion
arena: come una singola invocazione `/discussion-arena` diventa un consiglio di
subprocessi agente isolati, come il trigger decide se la discussion arena è
obbligatoria o solo disponibile, e dove vivono i limiti runtime. È scritto per chi deve capire
o modificare gli interni dell'estensione.

## Cosa copre questa sezione

- Registrazione del tool e flusso end-to-end di una invocazione
- Il modello a subprocessi dei partecipanti (un processo `gsd` per partecipante, sessione isolata)
- I round sequenziali e come i partecipanti vedono gli interventi degli altri
- Risoluzione del trigger tier 1-2-3 (`resolveTrigger`) e rilevamento della fase
- Gli hook di auto-mode che obbligano o espongono la discussion arena
- Limiti runtime e i loro punti di enforcement

## Quando leggere questa sezione

Leggi questo riferimento quando devi ragionare sul comportamento
dell'estensione: prima di modificare `index.ts`, aggiungere un hook o
diagnosticare perché una sessione si comporta in un certo modo.

## Prerequisiti

- Repository clonato, con `npm run typecheck` che passa
- Conoscenza operativa di TypeScript e dell'extension API di gsd-pi
- La Contributor Guide come punto di partenza per le convenzioni del repository

## Argomenti di questa sezione

Sette pagine, ciascuna con la controparte italiana (`.it.md`), descrivono gli interni dell'estensione:

- [Flusso di invocazione](invocation-flow.it.md) — dal tool registrato al transcript restituito
- [Risoluzione del trigger](trigger-resolution.it.md) — `resolveTrigger` tier 1-2-3, fallback deterministico, rilevamento della fase su `unit_start`
- [Hook](hooks.it.md) — comportamento di `adjust_tool_set` e `before_agent_start` nella fase di planning
- [Limiti runtime](runtime-limits.it.md) — `MAX_PARTICIPANTS`, `MAX_ROUNDS`, `DEFAULT_ROUNDS` e i loro punti di enforcement
- [Subprocessi partecipante](participant-subprocesses.it.md) — `runParticipantTurn`, isolamento della sessione, costo e latenza per round
- [Orchestrazione dei round](round-orchestration.it.md) — round sequenziali, assemblaggio del transcript, troncamento del prompt (~100KB)
- [Flusso research-decision](research-decision-flow.it.md) — gate → discussion arena → extract → persistenza → ingest → cleanup, la pipeline di ingestion di S04

I path, i simboli e le costanti citati in queste pagine non sono illustrativi:
`tests/architecture-refs.test.ts` li ancora ai sorgenti attuali. La suite
verifica (source-side) che ogni file, simbolo, riga e valore citato risolva,
e (doc-side) che ogni pagina citi davvero le reference dichiarate per essa.
Quando codice e documentazione divergono, la suite fallisce e nomina la pagina
in cui vive la divergenza.

## Documentazione correlata

- [README](../../README.it.md) — panoramica, quickstart e limiti noti
- [User Guide](../user-guide/index.it.md) — installare e usare l'estensione
- [Contributor Guide](../contributor-guide/index.it.md) — aggiungere ruoli e contribuire

---

Ogni pagina di questa sezione è pubblicata con la sua controparte `.it.md` e i
link incrociati che puntano qui. Per aggiungere una pagina, aggiungi le sue
voci alla reference table in `tests/architecture-refs.test.ts` e linkala da
entrambi gli index: la guardia doc-side fallisce finché l'index non elenca
ogni pagina dichiarata nella tabella.
