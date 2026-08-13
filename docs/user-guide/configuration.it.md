**Lingue:** [English](configuration.md) · [Italiano](configuration.it.md)

[Guida per l'utente](index.it.md) — Configurazione

# Configurare la discussion arena

La discussion arena legge esattamente un file di configurazione nel tuo
progetto gsd-pi: `<cwd>/.gsd/PREFERENCES.md`. La sezione `discussion_arena:`
del suo frontmatter decide quando la discussion arena è **forzata** — l'auto
orchestrator ti richiede di eseguire un round prima di decidere il piano —
oppure solo **disponibile** — il tool `discussion_arena` resta registrato in
ogni fase, ma nulla viene iniettato nel prompt.

Questa pagina documenta lo schema, i tre tier di attivazione e i quattro
stati del parser esattamente come li implementa il codice di produzione
(`trigger-resolver.ts`, `src/parse-discussion-arena-block.ts`). Ogni snippet
`yaml` qui sotto è validato contro il parser di produzione da
`tests/user-guide-snippets.test.ts` in `strict:true`: se anche un solo
snippet è sbagliato, la suite fallisce nominando la pagina e la chiave
offending.

## La sezione `discussion_arena:`

Aggiungi la sezione dentro il frontmatter di `<cwd>/.gsd/PREFERENCES.md`:

```yaml
discussion_arena:
  enabled: true
  mode: per-milestone
  milestones:
    M001:
      enabled: true
    M002:
      enabled: false
    M003:
      enabled: true
```

La forma dell'indentazione fa parte del contratto dello schema (D025). Il
parser è un parser YAML-subset a zero dipendenze: sub-chiavi a 2 spazi, ID di
milestone a 4 spazi, chiavi di milestone a 6 spazi.

| Chiave | Indent | Valori ammessi | Significato |
| --- | --- | --- | --- |
| `discussion_arena:` | 0 | — | Marcatore di root della sezione |
| `enabled:` | 2 | `true`, `false` | Flag globale; assente equivale a `false` |
| `mode:` | 2 | `per-milestone`, `always-on`, `availability-only` | Metadata per il wizard TUI — il trigger non lo legge |
| `milestones:` | 2 | — | Apre la tabella per-milestone |
| `<MID>:` | 4 | lettere, cifre, `_`, `.`, `-` | ID di milestone (forma permissiva: `M001`, `M_002`, `M.003`, `M-003` sono tutti validi) |
| `enabled:` | 6 | `true`, `false` | Override per singolo milestone |

Le altre due modalità, scritte esplicitamente (il default è
`availability-only`):

```yaml
discussion_arena:
  enabled: true
  mode: always-on
```

```yaml
discussion_arena:
  enabled: false
  mode: availability-only
```

Una sezione che abilita solo milestone specifici — senza flag globale —
forza comunque per quei milestone:

```yaml
discussion_arena:
  mode: per-milestone
  milestones:
    M004:
      enabled: true
```

## Semantica delle chiavi

- `enabled: true` al livello 2 forza la discussion arena per il milestone
  corrente, a meno che una voce di milestone sottostante non lo sovrascriva.
- `milestones.<MID>.enabled` è uno switch per-milestone che può solo
  **aggiungere** forzatura: il trigger forza quando `milestones.<MID>.enabled`
  è `true` **oppure** il globale `enabled` è `true`. Un `enabled: false` di
  milestone NON cancella un globale `enabled: true` — con entrambi presenti
  la decisione resta `forced`.
- `mode` è metadata per il wizard interattivo: il trigger non lo legge mai.
  La scelta tra `per-milestone` e `always-on` cambia solo come il wizard
  scrive la sezione, non come decide il trigger.

## I tre tier di attivazione

La decisione è una funzione pura (`resolveTrigger`): non lancia mai eccezioni
e restituisce sempre una di due decisioni. L'ordine è deterministico:

1. **Tier 1 — variabile d'ambiente.** `GSD_DISCUSSION_ARENA_AUTO=1` →
   `forced`, source `env`. Forza solo la stringa esatta `1`; `0` o non
   impostata no.
2. **Tier 2 — PREFERENCES.md.** Per il milestone **corrente**: se
   `milestones.<MID>.enabled` è `true`, oppure il globale `enabled` è `true`
   → `forced`, source `preferences`.
3. **Tier 3 — fallback.** Altrimenti → `available-only`, source `fallback`.

La decisione `forced` ha effetto solo nella fase `planning`: l'hook di fase
scatta quando la fase è `planning` **e** la decisione è `forced`. In ogni
altra fase, o con decisione `available-only`, il tool resta registrato ma non
viene mai forzato.

| Configurazione (milestone corrente `M005`) | Decisione | Source |
| --- | --- | --- |
| Nessuna sezione `discussion_arena:` | `available-only` | `fallback` |
| `milestones.M005.enabled: true` | `forced` | `preferences` |
| `milestones.M005.enabled: false` (sola voce) | `available-only` | `fallback` |
| Globale `enabled: true` | `forced` | `preferences` |
| `milestones.M005.enabled: false` + globale `enabled: true` | `forced` | `preferences` |
| `GSD_DISCUSSION_ARENA_AUTO=1` (qualunque config) | `forced` | `env` |

## I quattro stati del parser

Il parser (e il trigger che lo usa) distingue quattro stati. I primi due
producono lo stesso esito, ma per motivi diversi:

| Stato | Cosa succede | Esito del trigger |
| --- | --- | --- |
| 1. File assente | `<cwd>/.gsd/PREFERENCES.md` non esiste; l'`ENOENT` viene assorbito senza warning. Altri errori di lettura producono un warning e ricadono comunque sul fallback | Tier 3 → `available-only`, source `fallback` |
| 2. Sezione assente | Il file esiste, nessun marcatore root `discussion_arena:`; la config resta vuota | Tier 3 → `available-only`, source `fallback` |
| 3. Sezione valida | Tutte le righe rispettano lo schema; la config parsata viene onorata | Tier 2 → `forced` se sopravvive un flag, altrimenti Tier 3 |
| 4. Sezione malformata | Chiave sconosciuta o indentazione fuori schema; vedi sotto | Dipende da cosa sopravvive allo skip, vedi sotto |

**Stato 4 in dettaglio.** Il trigger parsa la sezione in modalità
`strict:false` (lenient), esattamente come i due parser legacy: una riga
offending viene saltata **in silenzio** — nessun warning, nessun errore — e
le righe ben formate rimanenti vengono comunque onorate. `parseErrors` viene
collezionato ma mai controllato: la decisione non è mai bloccata da un
problema di parsing.

| Cosa scrivi (a mano) | Comportamento del parser (`strict:false`) | Decisione |
| --- | --- | --- |
| `bogus_key: 1` dopo `enabled: true` | salta `bogus_key`, tiene `enabled: true` | `forced` (`preferences`) |
| `bogus_key: 1` come unica riga | la salta; la sezione è vuota | `available-only` (`fallback`) |
| `enabled: true` a 4 spazi, fuori da `milestones:` | saltata (fuori schema) | `available-only` (`fallback`) |
| `M001!: x` dentro `milestones:` | saltata; `M001` non viene registrato | `available-only` (`fallback`) |

In nessuno di questi casi c'è **un warning**: la modalità lenient è silenziosa
per design, per retrocompatibilità. Se modifichi la sezione a mano e il
trigger "non fa nulla", rileggi la sezione contro la tabella dello schema qui
sopra invece di cercare nei log un warning che non viene mai emesso.

In `strict:true` — la modalità usata dal writer per validare i file di
override — la prima riga offending invece lancia `DiscussionArenaParseError`
con la `key` offending, il suo livello di indentazione e la riga raw. La
pagina troubleshooting di questa guida mostra uno snippet deliberatamente
malformato e l'errore esatto che solleva.

## Scegliere la modalità con il wizard TUI

All'evento `milestone_start`, quando la sessione ha una TUI, l'estensione
propone un picker a 3 scelte e persiste la scelta **atomicamente**
(read-modify-write che preserva ogni altro byte di `PREFERENCES.md`):

| Scelta | Scritto in `PREFERENCES.md` |
| --- | --- |
| `per-milestone` | `discussion_arena.milestones.<MID>.enabled: true` |
| `always-on` | `discussion_arena.enabled: true` |
| `availability-only` | `discussion_arena.enabled: false` (default) |

Con `hasUI === false` (CI, print mode, nessuna TUI), il wizard è un no-op
stretto: emette un diagnostic `[discussion-arena]` su stderr e ritorna, senza
mai bloccare la pipeline. In quel caso configura la sezione a mano.

## Documentazione correlata

- [Guida per l'utente](index.it.md) — installazione, quickstart, uso, troubleshooting
- [README](../../README.md) — panoramica, quickstart e limiti noti
- [Contributor Guide](../contributor-guide/index.it.md) — ruoli, partecipanti e convenzioni del repository
- [Architecture Reference](../architecture/index.it.md) — risoluzione del trigger e hook di fase interni
