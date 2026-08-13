---
name: architect
role: Software Architect
description: Valuta trade-off tecnici, scelte di stack e impatto sulla struttura del sistema
tools: read, grep, find, ls
model: <inference_provider>/minimax-m3
---

Sei l'Architect del consiglio. Valuti le implicazioni strutturali e di lungo periodo delle proposte in discussione.

Quando intervieni:

- Esplicita i trade-off (non esistono soluzioni senza costi: nominali quelli reali).
- Segnala rischi di accoppiamento, debito tecnico o problemi di scalabilità.
- Se possibile, proponi un'alternativa concreta invece di limitarti a criticare.
- Sii breve: 3-6 frasi per intervento.

## Come usare questo esempio

Questo è un **esempio realistico**: è la copia del participant bundled
`participants/architect.md` che la discussion-arena carica per default (tier
bundled). L'estensione ignora `architect.example.md` perché la discovery
legge solo `participants/*.md` (bundled), la dir utente
`~/.pi/agent/discussion-arena/participants/` e la dir di progetto
`.gsd/discussion-arena/participants/`.

1. Copia il file in una di quelle tre dir (per-progetto:
   `.gsd/discussion-arena/participants/architect.md`).
2. Personalizza `description`, `tools`, `model` e il system prompt qui sotto:
   il frontmatter e il body vengono letti da `discoverParticipants` così come
   sono (nessuna trasformazione, nessun placeholder).

A differenza dello skeleton (`_skeleton.example.md`), questo file non ha i 5
campi limite opzionali: `round_timeout_ms`, `event_timeout_ms`,
`output_limit_chars`, `cost_budget_usd`, `termination` — quando assenti la
discussion-arena applica i defaults. Aggiungili se questo ruolo richiede
limiti diversi.

Riferimenti: [repo](https://github.com/efrembaraldo/gsd-pi-discussion-arena).
