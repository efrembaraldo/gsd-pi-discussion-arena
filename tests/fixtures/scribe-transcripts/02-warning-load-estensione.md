# Verbalizzato — warning al load dell'estensione discussion-arena

Deliberazione reale (run `discussion-arena`, 2 round, 5 partecipanti incluso scribe):
al load di gsd, con `discussion_arena: enabled: true / mode: always-on` in PREFERENCES.md, viene emesso un
warning per chiave sconosciuta. `auto-mode may be using defaults` implica che l'estensione non viene onorata.
Fonte contenuti: `.gsd-state/projects/*/discussion-arena/transcripts/*al-load-dell-agente*`.

## Ipotesi

- Il warning non è solo rumore: "auto-mode may be using defaults" implica che la config non è onorata
- Nascondere la chiave al motore non è l'unica via: registrare `discussion_arena` come capability nota a GSD è alternativo
- Un namespace `ext.*` per le preferenze delle estensioni risolverebbe sia warning sia inquinamento dello schema

## Decisioni

- **Registrare `discussion_arena` come capability nota a GSD invece di nasconderla**
  - Razionale: trasforma un warning in un contratto esplicito e versionato, mantiene l'estensione disaccoppiata dal loader
- **Valutare un file di configurazione dedicato all'estensione**
  - Dissenso: il solo PREFERENCES.md costringe l'utente a mettere la configurazione in un file di proprietà del motore

## Requisiti

- **R1** — Zero warning al load (must-have): load di gsd con estensione configurata produce 0 stderr su `discussion_arena`
- **R2** — Auto-mode onora `mode: always-on` (must-have)
- **R3** — Discovery utente
  - Descrizione: l'opzione della discussion arena deve essere visibile e documentata, non nascosta in PREFERENCES.md
  - Priorità: should-have
