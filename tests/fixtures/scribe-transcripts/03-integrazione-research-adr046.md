# Verbalizzato — validazione del design M-next-B (integrazione research ADR-046)

Deliberazione reale (run `discussion-arena`, 2 round) sull'integrazione di `discussion_arena`
nella fase di research di GSD (ADR-046): trigger di attivazione, estrazione post-process,
ingest in REQUIREMENTS.md, file di coordinamento, convivenza dei hook.
Fonte contenuti: `.gsd-state/projects/*/discussion-arena/transcripts/*validazione-del-design-di-m-next-b*`.

## Ipotesi

- Un opt-in esplicito via prompt injection è fragile: l'agente può dimenticarlo sotto pressione di contesto o lanciare la discussion arena quando non serve
- La frequenza di attivazione del gate `depth_verification_research_decision_confirm` è bassa ma qualificabile
- Il trigger deterministico è ottenibile con il trigger-resolver esistente senza nuovi hook core

## Decisioni

- **Estendere il trigger-resolver esistente per forzare l'iniezione di `gsd_discussion_arena` in `adjust_tool_set`**
  - Razionale: determinismo contrattualizzato senza aggiungere contratti a gsd-pi core
- **Adottare il parsing deterministico del transcript markdown (opzione c) come meccanismo di estrazione**, con fallback su model call solo in caso di fallimento
  - Dissenso: un model call separato raddoppia costo e punti di fallimento

## Requisiti

- **REQ-4** — Trigger deterministico (must-have): iniezione di `gsd_discussion_arena` nel toolset quando `phase==='research-decision'`
- **REQ-5** — Estrazione strutturata (must-have): estrazione di hypotheses, decisions, requirements dal transcript markdown del scribe
- **REQ-6** — Coordinamento e versioning del formato
  - Descrizione: estensione del coordination file con blocco `research_decision_format` senza rompere la compatibilità con gli agent esistenti
  - Priorità: should-have
