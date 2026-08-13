**Lingue:** [English](install.md) · [Italiano](install.it.md)

[Guida per l'utente](index.it.md) — Installazione

# Installare l'estensione discussion arena

La discussion arena è un'estensione di gsd-pi: registra il tool
`discussion_arena` e il comando `/discussion-arena`, e fornisce quattro
partecipanti bundled (`analyst`, `architect`, `dev`, `qa`). Questa pagina
copre i tre percorsi di installazione (npm, sessione interattiva, copia
manuale), cosa significa *scope* per un'installazione, come verificare che
l'estensione sia davvero caricata e come rimuoverla.

Il [README](../../README.md) copre lo stesso terreno fino al primo round.
Questa pagina aggiunge ciò che il README tralascia: la distinzione tra scope
utente e scope progetto, la verifica post-install e la rimozione. I comandi
qui sotto sono ancorati al package manager di gsd-pi
(`packages/pi-coding-agent/src/core/package-commands.ts` e
`package-manager.ts`) e ai comandi di estensione implementati in
`commands-extensions.js` — non a una loro descrizione.

## Prerequisiti

- gsd-pi installato e nel tuo `PATH` — verificalo con:

```bash
gsd --version
```

- Node.js e npm (usati da `gsd install` per scaricare i pacchetti npm)

## Metodo 1 — installazione da npm (consigliata)

```bash
gsd install npm:@efrembaraldo/gsd-pi-discussion-arena
```

`gsd install` è un comando CLI di primo livello (stessa famiglia di
`gsd remove`, `gsd list` e `gsd update`). Fa tre cose:

1. installa il pacchetto con npm nella root npm dello scope utente
   (`~/.gsd/agent/npm/node_modules/`);
2. registra la source nel file di impostazioni utente
   (`~/.gsd/agent/settings.json`);
3. esegue gli eventuali lifecycle hook dell'estensione.

Poi riavvia gsd-pi, oppure esegui `/reload` in una sessione interattiva: le
estensioni vengono scoperte all'avvio della sessione.

Per fissare una versione specifica, aggiungila al nome del pacchetto:

```bash
gsd install npm:@efrembaraldo/gsd-pi-discussion-arena@0.7.2
```

Per aggiornare in seguito: `gsd update npm:@efrembaraldo/gsd-pi-discussion-arena`
(senza source, `gsd update` aggiorna ogni pacchetto configurato).

## Metodo 2 — installazione da sessione interattiva

Dentro una sessione gsd-pi attiva, la famiglia di comandi `/gsd extensions`
gestisce il registro delle estensioni. Installa con:

```text
/gsd extensions install @efrembaraldo/gsd-pi-discussion-arena
```

Il comando impacchetta il pacchetto con npm, valida il manifest, lo estrae in
`~/.gsd/agent/extensions/gsd-pi-discussion-arena/` e registra una voce nel
registry in `~/.gsd/extensions/registry.json`. Poi stampa
"Restart GSD to activate." — riavvia prima di usare il tool.

Lo stesso comando accetta URL git e path locali:
`/gsd extensions install git:github.com/user/repo` oppure
`/gsd extensions install ./local/path`. La famiglia ha `install`, `list`,
`info`, `enable`, `disable` e `validate` — non esiste un sottocomando
`remove` (vedi [Rimuovere l'estensione](#rimuovere-lestensione)).

## Metodo 3 — copia manuale (senza npm)

Per test locali, macchine offline o un checkout di sviluppo, copia i file
dell'estensione direttamente nella directory delle estensioni utente:

```bash
mkdir -p ~/.gsd/agent/extensions/gsd-pi-discussion-arena
cp -r index.ts participants.ts run-participant.ts package.json extension-manifest.json ~/.gsd/agent/extensions/gsd-pi-discussion-arena/

mkdir -p ~/.gsd/agent/discussion-arena/participants
cp participants/*.md ~/.gsd/agent/discussion-arena/participants/
```

Il set minimo di file è il file di entry (`index.ts`), il manifest
(`extension-manifest.json`, che dichiara il tool `discussion_arena` e il
comando `discussion-arena`) e i moduli runtime che importano. La seconda
copia ti dà i quattro esempi bundled come partecipanti *utente*, così vincono
su quelli bundled (vedi la sezione scope sotto). Riavvia gsd-pi dopo.

## Scope utente vs scope progetto

"Scope" ha due significati indipendenti per questa estensione; non
confonderli.

### 1. Dove vive il codice dell'estensione

`gsd install` usa di default lo scope **utente**. Il flag `-l` / `--local`
installa invece nello scope **progetto**. I due scope tengono file di
impostazioni e root npm separati:

| | Scope utente (default) | Scope progetto (`-l`) |
| --- | --- | --- |
| File di impostazioni | `~/.gsd/agent/settings.json` | `<cwd>/.gsd/settings.json` |
| Root npm di install | `~/.gsd/agent/npm/` | `<cwd>/.gsd/npm/` |
| Effetti | su ogni progetto di questo utente | solo su questo progetto |

`gsd list` mostra i pacchetti configurati di entrambi gli scope insieme, con
il path di install risolto:

```text
User packages:
  npm:@efrembaraldo/gsd-pi-discussion-arena
    /home/you/.gsd/agent/npm/node_modules/@efrembaraldo/gsd-pi-discussion-arena
```

I pacchetti di entrambi gli scope vengono risolti, quindi un'installazione in
uno dei due scope rende il tool disponibile. In pratica il codice
dell'estensione è quasi sempre installato a scope utente: la parte
per-progetto della discussion arena sono i partecipanti (vedi sotto).

### 2. Da dove arrivano i partecipanti

A runtime l'estensione risolve i partecipanti con questa precedenza (vince la
più alta, `participants.ts`):

| Tier | Directory | Note |
| --- | --- | --- |
| Progetto | `.gsd/discussion-arena/participants/` | walk-up dalla directory di lavoro: vince la directory esistente più vicina |
| Utente | `~/.gsd/agent/discussion-arena/participants/` | condivisa da tutti i progetti dell'utente |
| Bundled | `participants/` accanto al modulo installato | i quattro esempi, sempre presenti dopo l'install |

(Due tier avanzati — gli override e il documento di coordinamento — esistono
sopra il tier progetto; sono documentati nella
[Contributor Guide](../contributor-guide/index.it.md).)

Un partecipante è un file markdown con frontmatter YAML:

```markdown
---
name: analyst
role: Business Analyst
description: Chiarisce requisiti, obiettivi di business e vincoli prima che si discuta di soluzioni tecniche
tools: read, grep, find, ls
model: freeinference_efrem/minimax-m3
---
```

Il `name` è l'identità usata per la precedenza: un partecipante copiato a
scope progetto con lo stesso `name` sostituisce quello utente/bundled in quel
progetto. I quattro partecipanti bundled sono sempre disponibili dopo
l'install; copiali dove vuoi personalizzarli invece di modificare la copia
del modulo (un aggiornamento dell'estensione la sovrascriverebbe).

## Verificare l'installazione

Tre controlli, in ordine crescente di confidenza:

1. **Il pacchetto è configurato.** `gsd list` mostra la source con il suo
   path di install (esempio sopra). Assente → la source non è mai stata
   registrata, oppure è stata rimossa.

2. **Il manifest è stato letto.** In una sessione interattiva:

```text
/gsd extensions info gsd-pi-discussion-arena
```

stampa i campi del manifest, lo stato del registry e il blocco `provides`:

```text
gsd-pi-discussion-arena (gsd-pi-discussion-arena)

  Version:     0.1.0
  Description: Agent Discussion Arena per gsd-pi: consiglio di agenti con ruoli/competenze configurabili, coordinato dal ciclo auto di gsd-pi
  Tier:        community
  Status:      enabled
  Provides:
    Tools:     discussion_arena
    Commands:  discussion-arena
```

`Extension "gsd-pi-discussion-arena" not found` → il manifest non è
scopribile: nome directory errato, `extension-manifest.json` mancante, o
nessun riavvio ancora.

1. **Il tool è registrato.** In print mode, chiedi la lista dei tool:

```bash
gsd -p "list the available tools" --mode json | grep discussion_arena
```

Un match per `discussion_arena` → l'estensione è stata caricata e ha
registrato il suo tool. Nessun match → l'estensione non è riuscita a
caricarsi; gli errori di caricamento delle estensioni vengono stampati
all'avvio della sessione (compaiono come warning `[gsd]` su stderr).

## Rimuovere l'estensione

- **Installata via `gsd install npm:`** — rimuovi con la stessa famiglia di
  comandi:

```bash
gsd remove npm:@efrembaraldo/gsd-pi-discussion-arena
```

`gsd remove` disinstalla il pacchetto dalla root npm dello scope e toglie la
source da `settings.json`. Usa `-l` se il pacchetto era stato installato con
`-l`. I file dei partecipanti che hai copiato a mano NON vengono toccati da
`gsd remove`: cancellali separatamente (sotto).

- **Installata via `/gsd extensions install` o copia manuale** — la famiglia
  slash non ha un sottocomando `remove`, quindi la rimozione è manuale:

```bash
rm -rf ~/.gsd/agent/extensions/gsd-pi-discussion-arena
rm -rf ~/.gsd/agent/discussion-arena/participants   # solo se vi hai copiato i partecipanti
```

e, se presente, togli la voce corrispondente da
`~/.gsd/extensions/registry.json`. Per un'installazione manuale a scope
progetto, rimuovi gli stessi file sotto `<cwd>/.gsd/`.

Rimuovere il codice dell'estensione rimuove insieme i suoi partecipanti
bundled: dopo una rimozione completa nessun partecipante viene scoperto e il
tool `discussion_arena` non viene più registrato al prossimo avvio di
sessione. Per confermare, ri-esegui i controlli di verifica: `gsd list` non
mostra più la source e il comando `grep discussion_arena` non produce match.

## Documentazione correlata

- [Guida per l'utente](index.it.md) — quickstart, configurazione, uso, troubleshooting
- [README](../../README.md) — panoramica, quickstart e limiti noti
- [Contributor Guide](../contributor-guide/index.it.md) — ruoli, partecipanti e convenzioni del repository
- [Architecture Reference](../architecture/index.it.md) — come vengono scoperti ed eseguiti i partecipanti
