---
# discussion-arena-coordination-activation.example.md
#
# Fixture per T03/S01/M007: coordination file che esercita la sezione
# `activation:` VALIDA, nello shape canonico supportato dal loader di
# produzione `loadDiscussionArenaCoordination` (mai throw).
#
# Lo scopo di questa fixture è isolare la sezione activation dal resto
# dell'esempio "completo" (`examples/discussion-arena-coordination.example.md`)
# così i test possono verificare che il parsing della sezione produce
# `config.activation.enabled/mode/milestones` senza alcun warning.
#
# Shape attesa dopo il parsing:
#   config.activation.enabled   === true
#   config.activation.mode      === "per-milestone"
#   config.activation.milestones === { "M.r-1": { enabled: true },
#                                       M_002:  { enabled: false } }
#
# Nota: i milestone ID usano la shape permissiva MID_RE `[A-Za-z0-9_.-]+`
# (punto, underscore e trattino sono accettati), coerente con il parser
# condiviso `parse-discussion-arena-block.ts`.
rounds_default: 3
model_default: inference_provider/minimax-m3
activation:
  enabled: true
  mode: per-milestone
  milestones:
    M.r-1:
      enabled: true
    M_002:
      enabled: false
roles_virtuals:
  scribe:
    name: scribe
    role: Scribe
    description: Consolida le conclusioni del consiglio in un riepilogo finale
    systemPrompt: |
      Sei il Verbalizzante del consiglio di agenti.
---