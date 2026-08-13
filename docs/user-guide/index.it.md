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

La guida è organizzata in cinque pagine, una per percorso:

- [Installazione](install.it.md) — npm, sessione interattiva, copia manuale, verifica post-installazione
- [Quickstart](quickstart.it.md) — un primo round `/discussion-arena "tema"` con i partecipanti bundled
- [Configurazione](configuration.it.md) — lo schema `discussion_arena:` (`enabled`, `mode`, `milestones.<MID>.enabled`) e i quattro stati del parser
- [Uso](usage.it.md) — flag del comando, override `--model`, sessioni persistenti con `--continue` / `--new`
- [Troubleshooting](troubleshooting.it.md) — `DiscussionArenaParseError` in strict mode, warning `[discussion-arena]`, fallback deterministici

## Documentazione correlata

- [README](../../README.it.md) — panoramica, quickstart e limiti noti
- [Contributor Guide](../contributor-guide/index.it.md) — aggiungere ruoli e contribuire all'estensione
- [Architecture Reference](../architecture/index.it.md) — come funziona internamente la discussion arena

---

Ogni pagina qui sopra è pubblicata in inglese e in italiano (`.it.md`); i link
`**Lingue:**` in cima a ogni pagina permettono di passare dall'una all'altra.
