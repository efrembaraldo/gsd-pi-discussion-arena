# Verbalizzato — override dei partecipanti discussion-arena

Deliberazione reale (run `discussion-arena`, 5 round, 4 partecipanti + scribe) su come consentire override delle figure in `participants/*.md`.
Fonte dei contenuti: `.gsd-state/projects/*/discussion-arena/transcripts/*valutazione-propriet-in-preferences*` e `docs/discussion-arena-deliberation-archive.md`.

## Ipotesi

- L'utente condivide le definizioni base di `participants/*.md` ma vuole override personali (modello, tools) senza toccare i file condivisi
- Il merge parziale campo-per-campo è la causa di ambiguità: i campi non specificati nei participant file non vengono propagati
- Una directory `participants.local/*.md` (gitignored) è auto-documentante e non richiede merge logic

## Decisioni

- **Adottare un file `.gsd/participants-overrides.md` con semantica di sostituzione totale**
  - Razionale: stessa discoverability di PREFERENCES.md, stessa sintassi di `participants/*.md`, nessun parser di merge
  - Dissenso: un file override malformato non deve bloccare l'avvio della discussion arena
- **Rendere obbligatorio `--dump-participants` per la verificabilità**
  - Razionale: senza di esso l'override applicato è indecidibile a runtime

## Requisiti

- **REQ-1** — Verificabilità degli override (must-have): comando `--dump-participants` che stampi i partecipanti risolti con la fonte di provenienza
- **REQ-2** — Override per file (must-have): file override che sostituisce interamente il corrispondente default in `participants/`
- **REQ-3** — Normalizzazione override
  - Descrizione: `model: ""` nel frontmatter deve essere normalizzato a `undefined`, mai passato come stringa vuota al modello
  - Priorità: should-have
