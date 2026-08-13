**Lingue:** [English](index.md) · [Italiano](index.it.md)

# Guida per l'utente

La guida per l'utente spiega come installare, configurare e usare il tool
`discussion_arena` e il comando `/discussion-arena` nei tuoi progetti gsd-pi.
È scritta per chi consuma l'estensione — non per chi ne modifica il codice
sorgente.

## Cosa copre questa sezione

- Installare l'estensione (npm, sessione interattiva, copia manuale)
- Eseguire il primo round `/discussion-arena` con i partecipanti bundled
- Configurare quando la discussion arena è obbligatoria vs. solo disponibile,
  tramite la sezione `discussion_arena:` in `.gsd/PREFERENCES.md`
- Usare i flag di sessione come `--model`, `--continue` e `--new`
- Capire dove vengono salvati i transcript e come riprendere una sessione
- Risolvere configurazioni malformate e warning del parser

## Quando leggere questa guida

Leggi questa guida quando vuoi usare la discussion arena in un progetto reale:
hai gsd-pi installato e vuoi che un consiglio di agenti con ruoli personalizzati
deliberi su un tema prima di prendere una decisione.

## Prerequisiti

- gsd-pi installato e funzionante (Node 20+)
- Estensione `@efrembaraldo/gsd-pi-discussion-arena` installata
- Un progetto gsd-pi in cui puoi creare `.gsd/PREFERENCES.md`

## Argomenti di questa guida

La guida completa, aggiunta nella slice S02, copre queste pagine:

- **Installazione** — npm, sessione interattiva, copia manuale, verifica post-installazione
- **Quickstart** — un primo round `/discussion-arena "tema"` con i partecipanti bundled
- **Configurazione** — lo schema `discussion_arena:` (`enabled`, `mode`, `milestones.<MID>.enabled`) e i quattro stati del parser
- **Uso** — flag del comando, override `--model`, sessioni persistenti con `--continue` / `--new`
- **Troubleshooting** — `DiscussionArenaParseError` in strict mode, warning `[discussion-arena]`, fallback deterministici

## Documentazione correlata

- [README](../../README.md) — panoramica, quickstart e limiti noti
- [Contributor Guide](../contributor-guide/index.md) — aggiungere ruoli e contribuire all'estensione
- [Architecture Reference](../architecture/index.md) — come funziona internamente la discussion arena

---

Il contenuto dettagliato sarà aggiunto nella slice S02. Questo index è il
contratto di navigazione stabile: ogni pagina aggiunta a questa sezione è
pubblicata con la sua controparte `.it.md` e i link incrociati che puntano qui.
