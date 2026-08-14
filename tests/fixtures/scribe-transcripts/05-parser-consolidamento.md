# Verbalizzato — convivenza dei parser del documento di coordinamento

Deliberazione reale (run `discussion-arena`, round multipli, 4 partecipanti + scribe) sul consolidamento
del parsing della sezione `discussion_arena` e sul versioning del coordination file.
Fonte contenuti: `.gsd-state/projects/*/discussion-arena/transcripts/*` e `docs/discussion-arena-deliberation-archive.md`.

## Ipotesi

- Due parser near-identical della sezione `discussion_arena` (`trigger-resolver.ts` e `preferences-writer.ts`) sono un bug latente, non solo debito
- Aggiungere una sottosezione `participants:` a un key-value store piatto come PREFERENCES.md crea un formato ibrido fragile
- Estendere il coordination file con il blocco `research_decision_format` richiede che gli agent esistenti lo ignorino gracefully

## Decisioni

- **Consolidare i due parser della sezione `discussion_arena` in un'unica implementazione testata prima di aggiungere la feature**
  - Razionale: due regex divergenti producono comportamenti diversi in contesti diversi (TUI wizard vs CLI)
- **Separare la configurazione dell'estensione dal key-value store piatto dell'host**
  - Dissenso: un errore di indentazione nella sottosezione non deve silenziare le preferenze TUI

## Requisiti

- **REQ-10** — Singolo parser della sezione discussion arena (must-have): un solo modulo di parsing condiviso da tutte le entry point
- **REQ-11** — Migration plan del coordinamento (must-have)
- **REQ-12** — Compatibilità con agent esistenti
  - Descrizione: i vecchi agent che non conoscono il nuovo blocco `research_decision_format` lo ignorano senza errore
  - Priorità: should-have
