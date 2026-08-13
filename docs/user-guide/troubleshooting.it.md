**Lingue:** [English](troubleshooting.md) · [Italiano](troubleshooting.it.md)

[Guida per l'utente](index.it.md) — Troubleshooting

# Risolvere i problemi della discussion arena

Questa pagina documenta cosa fa davvero la discussion arena quando la
configurazione è sbagliata, e cosa **non** fa. Ogni affermazione qui sotto è
ancorata al codice di produzione, e ogni snippet di questa guida — valido o
deliberatamente malformato — viene passato al parser di produzione
`parseDiscussionArenaBlock` in `strict:true` da
`tests/user-guide-snippets.test.ts`. Se un messaggio di errore documentato
non corrisponde a quello che solleva il parser, la suite fallisce nominando
la pagina e la chiave offending.

## Sintomi a colpo d'occhio

| Sintomo | Causa probabile | Dove guardare |
| --- | --- | --- |
| Il trigger non forza mai un round nella fase `planning` | La decisione per il milestone corrente è `available-only` | [I tre tier di attivazione](#il-trigger-non-fa-nulla--controlla-i-tre-tier) |
| Una riga della sezione `discussion_arena:` sembra ignorata | Riga malformata in modalità lenient, saltata in silenzio | [Sezione ignorata in silenzio](#una-sezione-malformata-viene-ignorata-in-silenzio-lenient) |
| Ricevi un errore che nomina una chiave e un indent | La validazione `strict:true` ha rifiutato la prima riga offending | [L'errore `DiscussionArenaParseError`](#lerrore-in-strict-mode-discussionarenaparseerror) |
| Il comando si ferma prima di un round con un errore | Problema di configurazione fatale (override orfano, nessun partecipante) | [Errori di configurazione fatali](#errori-di-configurazione-fatali) |
| `--continue` avvia una nuova sessione | Non esiste un file di sessione per quel tema | [Sessioni, replay e transcript](#sessioni-replay-e-transcript) |
| La risposta di un partecipante manca o è troncata | Timeout, budget o limite di output | [Sessioni, replay e transcript](#sessioni-replay-e-transcript) |

## Il trigger "non fa nulla" — controlla i tre tier

La decisione del trigger è una funzione pura (`resolveTrigger`): non lancia
mai eccezioni e restituisce sempre una di due decisioni, `forced` o
`available-only`. Quando la discussion arena non è forzata, il tool resta
registrato ma nulla viene iniettato nel prompt. Controlla i tre tier in
ordine:

1. **Variabile d'ambiente.** Forza solo la stringa esatta
   `GSD_DISCUSSION_ARENA_AUTO=1`. `0`, non impostata, o qualunque altro valore
   non forza.
2. **`<cwd>/.gsd/PREFERENCES.md` per il milestone *corrente*.** La decisione
   è `forced` quando `milestones.<MID>.enabled: true` per il milestone
   corrente, oppure quando il globale `enabled: true` è impostato. Una
   sezione che abilita solo un *altro* milestone non forza il corrente.
3. **Fallback.** Se nessuno dei due si applica, la decisione è
   `available-only`.

Ricorda che la forzatura ha effetto solo nella fase `planning`: fuori da
quella fase, anche una decisione `forced` lascia il tool registrato ma non
inietta mai nulla.

Non esiste **né un comando né un log** per interrogare la decisione: la
produzione chiama `resolveTrigger` senza loggare l'esito, quindi non cercare
su stderr una riga del trigger — leggi la configurazione e percorri i tier
qui sopra.

## Una sezione malformata viene ignorata in silenzio (lenient)

Il trigger parsa la sezione `discussion_arena:` in `strict:false` (lenient),
esattamente come i due parser legacy. Una riga offending viene saltata **in
silenzio** — nessun warning, nessun errore — e le righe ben formate rimanenti
vengono comunque onorate. Gli errori di parsing vengono collezionati ma mai
controllati: la decisione non è mai bloccata da un problema di parsing. È una
scelta intenzionale, per retrocompatibilità.

Conseguenza: se modifichi la sezione a mano e il trigger "non fa nulla", non
cercare un warning nei log — per uno skip lenient non ne viene mai emesso
nessuno. Confronta invece la tua sezione con la tabella dello schema in
[Configurazione](configuration.it.md). I quattro stati del parser (file
assente, sezione assente, sezione valida, sezione malformata) e i loro esiti
sul trigger sono documentati lì per intero.

## L'errore in strict mode: `DiscussionArenaParseError`

`strict:true` è la modalità di validazione usata per provare che un blocco
`discussion_arena:` sia ben formato: l'harness degli snippet di questa guida
passa ogni snippet attraverso il parser di produzione in `strict:true`, e il
writer valida i file di override con lo stesso punto d'ingresso. Il runtime
non usa mai `strict:true` — è lenient soltanto — ma l'errore qui sotto è
esattamente quello che ottieni quando un blocco viene rifiutato.

In `strict:true`, la **prima** riga offending solleva
`DiscussionArenaParseError` con tre campi: `key` (la chiave offending),
`indent` (il suo livello di indentazione) e `line` (la riga raw). Il messaggio
ha questa forma:

```
unknown key "<key>" at indent <indent> in discussion_arena block (line: <line>)
```

Snippet 1 — una chiave sconosciuta, deliberatamente malformato:

```yaml-invalid
discussion_arena:
  enabled: true
  bogus_key: 1
```

Validato in `strict:true`, solleva esattamente:

```
DiscussionArenaParseError: unknown key "bogus_key" at indent 2 in discussion_arena block (line: bogus_key: 1)
```

`bogus_key` non fa parte dello schema (le chiavi valide a indent 2 sono
`enabled`, `mode` e `milestones`). Rimedio: rimuovi la riga, oppure verifica
l'ortografia contro la tabella dello schema in
[Configurazione](configuration.it.md).

Snippet 2 — una chiave valida all'indent sbagliato, deliberatamente
malformato:

```yaml-invalid
discussion_arena:
  enabled: true
    enabled: true
```

Validato in `strict:true`, solleva esattamente:

```
DiscussionArenaParseError: unknown key "enabled" at indent 4 in discussion_arena block (line: enabled: true)
```

`enabled` è valida solo a indent 2 (flag globale) o a indent 6 (dentro
`milestones.<MID>`). A indent 4 il parser si aspetta una riga con un ID di
milestone (`M001:` e simili) *dentro* la sezione `milestones:`; fuori da
quella sezione una riga a 4 spazi è fuori schema. Rimedio: metti il flag a
indent 2, oppure spostalo sotto una voce di milestone a indent 6.

La stessa sezione corretta — questa è la forma valida e passa `strict:true`:

```yaml
discussion_arena:
  enabled: true
  mode: per-milestone
  milestones:
    M001:
      enabled: true
```

## Il prefisso dei warning `[discussion-arena]`

I warning che vengono davvero emessi usano il prefisso `[discussion-arena]`
su stderr. Le superfici seguenti sono reali e documentate:

- **File di coordinamento** (`<cwd>/.gsd/discussion-arena/discussion-arena-coordination.md`):
  un `rounds_default` invalido produce
  `[discussion-arena] rounds_default must be a positive integer (got <value>) — using code defaults`;
  un file non parsabile produce
  `[discussion-arena] coordination parse error: <reason> — using code defaults`;
  un ruolo virtuale incompleto produce
  `[discussion-arena] virtual role '<key>' missing required field <field> — skipped`.
  In ogni caso il codice ricade sui suoi default e prosegue.
- **Override dei partecipanti** (`participants/`):
  `[discussion-arena] override applied: <role> from <path>` in caso di
  successo; `[discussion-arena] override skipped: incomplete (<role> from <path>)`
  e `[discussion-arena] using default for '<role>' (override skipped: incomplete)`
  quando il file di override è incompleto.
- **Warning di runtime**: `[discussion-arena] warning: impossibile salvare sessione in <path>: <err>`
  (persistenza della sessione fallita, non fatale),
  `[discussion-arena] warning: outputLimitChars=<n> < marker length, troncatura saltata per <name>`
  (limite di output invalido, troncatura saltata),
  `[discussion-arena] warning: appendEvent fallito: <err>`
  (fallimento dell'event log, fail-safe), e
  `[discussion-arena] error resolving trigger during activate: <msg>`
  (problema all'avvio, non bloccante).
- **Wizard senza TUI**: quando `hasUI === false` (CI, print mode), il wizard
  di milestone emette un diagnostic `[discussion-arena]` su stderr e ritorna
  senza mai bloccare la pipeline.

Il prefisso **non** appare in due casi che gli utenti cercano spesso: la
decisione del trigger (non loggata in produzione) e gli skip lenient del
parser (silenziosi per design). Se stai cercando un warning su una sezione
`discussion_arena:` malformata, non ce n'è nessuno da trovare.

## Errori di configurazione fatali

Due problemi di configurazione **fermano** il comando con un errore, invece
di essere degradati a warning:

- **Override orfano**: un file di override in `participants/` il cui target
  non ha un file di ruolo base. Il comando lancia:
  `override target '<role>' not found in participants/ — create participants/<role>.md or remove the override file`.
  Rimedio: crea il file del ruolo base, oppure rimuovi l'override.
- **Nessun partecipante valido**: il comando lancia con la lista disponibile:
  `Nessun partecipante valido trovato. Disponibili: <list>.` Rimedio: definisci
  almeno un ruolo in `participants/` il cui id corrisponda al set richiesto.

Tutto il resto viene intercettato al confine del tool: il comando restituisce
`Errore nell'esecuzione della discussion-arena: <message>` come risposta del
tool e non fa mai crashare la sessione — controlla stderr per il prefisso
`[discussion-arena]` per vedere il problema sottostante.

## Sessioni, replay e transcript

- **`--continue` senza sessione.** Se non esiste un file di sessione per il
  tema, il comando notifica
  `Nessuna sessione esistente per "<topic>" — avvio da zero.` e riparte dal
  round 1. È un avviso informativo, non un errore. Le sessioni vivono in
  `<cwd>/.gsd/discussion-arena/transcripts/<cwdHash>-<topic-slug>.md` e sono
  markdown semplice con un piccolo frontmatter YAML.
- **Replay con id sconosciuto.** Il comando risponde
  `Nessun event log trovato per la discussion-arena <id> — verifica che la run originale sia stata eseguita con eventLog: true (log in <cwd>/.gsd/discussion-arena/events/).`
  Gli event log vivono in `<cwd>/.gsd/discussion-arena/events/`.
- **Salvataggio della sessione fallito.** Un salvataggio fallito emette il
  warning `[discussion-arena] warning: impossibile salvare sessione` e
  l'output del round viene comunque restituito — la persistenza non può mai
  uccidere il round.
- **Transcript molto lunghi.** Per un singolo prompt il transcript viene
  troncato a 100 000 byte mantenendo i round più recenti, con i marker
  `[...round più vecchi omessi per limite prompt...]` o
  `[...troncato per limite prompt...]`. Il file di sessione su disco conserva
  il transcript completo — controlla il file, non il prompt, per la
  registrazione integrale.
- **Marker di fallimento dei partecipanti.** I fallimenti vengono registrati
  nel transcript con marker tra parentesi quadre:
  `[PARTICIPANT FAILED: <id> <reason> <ts>]`,
  `[TIMEOUT: <id> round_timeout <ts>]` (oppure `event_watchdog`),
  `[BUDGET EXHAUSTED: <id> at round <N>]`, `[PARTICIPANT SKIPPED: <id>]`, e
  `[OUTPUT TRUNCATED at <N> chars]` per una risposta oltre il limite (la
  risposta conta comunque come consegnata). L'esito di un round con fallimenti
  è `partial`.

## Documentazione correlata

- [Guida per l'utente](index.it.md) — tutte le pagine di questa guida
- [Configurazione](configuration.it.md) — lo schema e i quattro stati del parser
- [Uso](usage.it.md) — flag del comando e flag di sessione
- [README](../../README.md) — panoramica, quickstart e limiti noti
