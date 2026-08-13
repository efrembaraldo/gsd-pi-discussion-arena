**Lingue:** [English](index.md) · [Italiano](index.it.md)

# Guida per i contributor

La guida per i contributor spiega come estendere la discussion arena:
aggiungere partecipanti, scrivere esempi che i loader di produzione accettano
e seguire le convenzioni del repository. È scritta per chi clona questo
repository e ne modifica codice o documentazione.

## Cosa copre questa sezione

- Struttura del repository e convenzioni documentali (coppie bilingue EN/IT, suffisso `.it.md`, link incrociati, link checker)
- Aggiungere e sovrascrivere ruoli partecipante (`discoverParticipants`, precedenza project > user > bundled)
- Il coordination file (`.gsd/discussion-arena/discussion-arena-coordination.md`) con `rounds_default`, `model_default` e `roles_virtuals`
- Aggiungere file di esempio in `examples/` validati dai loader di produzione
- Convenzioni di testing (`node:test`, TS ESM loader, guardie di enforcement)

## Quando leggere questa guida

Leggi questa guida quando vuoi contribuire: hai clonato il repository, sai
eseguire la suite di test e vuoi aggiungere un ruolo, un esempio o una pagina
di documentazione senza rompere le convenzioni.

## Prerequisiti

- Node 20+ e npm
- Repository clonato, con `npm install` e `npm run setup-types` completati
- Familiarità con Markdown e TypeScript

## Argomenti di questa guida

La guida copre queste pagine:

- [Struttura del progetto](project-layout.it.md) — dove vivono sorgenti, test, esempi e docs, e cosa impone il link checker
- [Partecipanti](participants.it.md) — schema del frontmatter (`name`, `role`, `description`, `tools` e `model` opzionali), regole di precedenza, limiti runtime per partecipante
- [Coordination file](coordination-file.it.md) — schema, default, ruoli virtuali, contratti del loader e warning
- [Esempi](examples.it.md) — come un esempio diventa caricabile da un loader di produzione e come `tests/examples-validation.test.ts` lo mantiene tale
- [Testing](testing.it.md) — eseguire la suite, aggiungere guardie, evitare regressioni

> **Nota su `docs/discussion-arena-deliberation-archive.md`:** quel file è un
> archivio deliberativo locale non versionato (D069). È escluso di proposito
> dalla navigazione documentale — non linkarlo mai da guide o index.

## Documentazione correlata

- [README](../../README.md) — panoramica, quickstart e limiti noti
- [User Guide](../user-guide/index.md) — installare e usare l'estensione
- [Architecture Reference](../architecture/index.md) — come funziona internamente la discussion arena

---

Questo index è il contratto di navigazione stabile: ogni pagina di questa
sezione è pubblicata con la sua controparte `.it.md` e i link incrociati che
puntano qui.
