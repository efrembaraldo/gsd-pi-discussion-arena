# Verbalizzato — ingest flow delle decisioni in REQUIREMENTS.md

Deliberazione reale (run `discussion-arena`, 2 round, tema M-next-B ADR-046): modalità di
trasferimento delle decisioni/requisiti approvate dal gate `depth_verification_research_decision_confirm`
verso `REQUIREMENTS.md`. Fonte contenuti: `.gsd-state/projects/*/discussion-arena/transcripts/*validazione-del-design-di-m-next-b*`.

## Ipotesi

- L'ingest diretto tramite hook che chiama l'API GSD espone un contratto non documentato con gsd-pi core
- Un file intermedio viene scritto dall'estrattore e letto dall'agent della unit successiva senza toccare il core
- Un file stale può restare orfano se la unit muore prima dell'ingest riuscito

## Decisioni

- **Adottare un file intermedio `.gsd/discussion-arena/pending-research.json` per portare le decisioni approvate in REQUIREMENTS.md**
  - Razionale: nessun burden per l'utente, nessun nuovo contratto con gsd-pi core, formato machine-readable
  - Dissenso: serve cleanup per evitare file stale
- **Delegare il cleanup del file intermedio a un hook di fine milestone con TTL**

## Requisiti

- **REQ-7** — File intermedio machine-readable (must-have): `.gsd/discussion-arena/pending-research.json`
- **REQ-8** — Auto-cleanup del pending (must-have): il file intermedio viene pulito dopo ingest riuscito o in `milestone_end`
- **REQ-9** — Robustezza scrittura
  - Descrizione: scrittura con pattern atomic write-then-rename per evitare file parziali letti dall'agent successivo
  - Priorità: should-have
