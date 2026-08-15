---
name: skeleton
role: Role label shown in the transcript
description: One-line description of this role's competence in the council
tools: read, grep, find, ls
model: minimax/minimax-m3
round_timeout_ms: 120000
event_timeout_ms: 60000
output_limit_chars: 4000
cost_budget_usd: 0.5
termination: soft
---

Sei il <ruolo> del consiglio della discussion-arena. Questo è il tuo system
prompt: descrive la tua competenza, il tuo punto di vista e le regole con cui
intervieni nella discussione.

Quando intervieni:

- Intervieni solo quando hai qualcosa da aggiungere: la tua competenza, un
  rischio, un'alternativa.
- Sii breve: 3-6 frasi per intervento, non un documento.
- Riferisciti esplicitamente agli interventi precedenti quando rispondi.
- Non ripetere ciò che hanno già detto altri partecipanti.

## Come copiare questo file

Questo è un **template**: l'estensione ignora `_skeleton.example.md` perché
la discovery legge solo `participants/*.md` (bundled), la dir utente
`~/.pi/agent/discussion-arena/participants/` e la dir di progetto
`.gsd/discussion-arena/participants/`.

1. Copia il file in una di quelle tre dir (per-progetto:
   `.gsd/discussion-arena/participants/<ruolo>.md`).
2. Rinominalo col nome del ruolo e aggiorna il frontmatter:

| Campo | Obbligatorio | Note |
| ----- | ------------ | ---- |
| `name` | sì | Identificatore univoco; chiave della mappa dei partecipanti |
| `role` | sì | Etichetta mostrata nel transcript |
| `description` | sì | Competenza del ruolo, usata dal consiglio |
| `tools` | no | Lista comma-separata di tool ammessi per il sottoprocesso |
| `model` | no | Fallback sul `model_default` del coordination file se assente |
| `round_timeout_ms` | no | Timeout di un singolo round per questo partecipante |
| `event_timeout_ms` | no | Timeout del primo evento del round |
| `output_limit_chars` | no | Cap sui caratteri di output per intervento |
| `cost_budget_usd` | no | Budget massimo per il sottoprocesso |
| `termination` | no | `soft` (default) o `hard` |

1. Il body (dopo il frontmatter) è il system prompt del ruolo: sostituisci
   i segnaposto con le istruzioni reali.

Riferimenti: [repo](https://github.com/efrembaraldo/gsd-pi-discussion-arena).
