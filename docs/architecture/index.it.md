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

Il riferimento completo, aggiunto nella slice S04, copre queste pagine:

- **Flusso di invocazione** — dal tool registrato al transcript restituito
- **Subprocessi partecipante** — `runParticipantTurn`, isolamento della sessione, costo e latenza per round
- **Orchestrazione dei round** — round sequenziali, assemblaggio del transcript, troncamento del prompt (~100KB)
- **Risoluzione del trigger** — `resolveTrigger` tier 1-2-3, fallback deterministico, rilevamento della fase su `unit_start`
- **Hook** — comportamento di `adjust_tool_set` e `before_agent_start` nella fase di planning
- **Limiti runtime** — `MAX_PARTICIPANTS`, `MAX_ROUNDS`, `DEFAULT_ROUNDS` e i loro punti di enforcement

## Documentazione correlata

- [README](../../README.md) — panoramica, quickstart e limiti noti
- [User Guide](../user-guide/index.md) — installare e usare l'estensione
- [Contributor Guide](../contributor-guide/index.md) — aggiungere ruoli e contribuire

---

Il contenuto dettagliato sarà aggiunto nella slice S04. Questo index è il
contratto di navigazione stabile: ogni pagina aggiunta a questa sezione è
pubblicata con la sua controparte `.it.md` e i link incrociati che puntano qui.
