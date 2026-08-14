---
# discussion-arena-coordination.example.md
#
# Esempio del file di coordination della discussion arena per-progetto.
# Copia questo file in `.gsd/discussion-arena/discussion-arena-coordination.md`
# alla root del tuo progetto gsd-pi per attivare i default della "forma"
# della discussion arena. Viene caricato dal loader di produzione
# `loadDiscussionArenaCoordination` (mai throw).
#
# Contratto del formato (parser indentation-aware, D051):
#   - commenti `#` e righe vuote fuori dai block scalar vengono ignorati;
#   - `rounds_default` deve essere un integer positivo (>= 1);
#   - `model_default` è il fallback per i participant senza `model` esplicito;
#   - `activation` gestisce l'attivazione della discussion arena per progetto:
#     `enabled` (bool globale), `mode` ∈ {per-milestone, always-on,
#     availability-only} e `milestones` (abilitazione per-milestone, chiave =
#     milestone ID di shape permissiva MID_RE). Il corpo della sezione usa lo
#     stesso parser indentation-aware del blocco `discussion_arena:` di
#     PREFERENCES.md, ed è fail-safe: mode fuori enum o milestone ID fuori
#     MID_RE vengono scartati con un warning D053, mai un throw;
#   - `roles_virtuals` definisce ruoli one-off senza file in `participants/`;
#     ogni entry richiede i 4 campi name, role, description, systemPrompt e
#     la chiave del dict deve coincidere con il campo `name`;
#   - chiavi top-level sconosciute: ignorate (forward-compat).
rounds_default: 2
model_default: inference_provider/minimax-m3
# Sezione activation (shape canonica): default della forma
# della discussion arena. Questa sezione è opzionale: se assente il behavior
# resta quello dei code defaults. `milestones` attiva/disattiva per single
# milestone (la chiave del dict è il milestone ID).
activation:
  enabled: true
  mode: per-milestone
  milestones:
    M001:
      enabled: true
    M002:
      enabled: false
roles_virtuals:
  scribe:
    name: scribe
    role: Scribe
    description: Consolida le conclusioni del consiglio in un riepilogo finale
    systemPrompt: |
      Sei il Verbalizzante del consiglio di agenti. Il tuo compito è produrre un
      riepilogo finale della discussione: decisioni prese, trade-off emersi
      e azioni conseguenti. Sii sintetico e fedele agli interventi reali.
      Quando intervieni:
      - Elenca solo ciò che è stato effettivamente detto o deciso.
      - Non introdurre nuove opinioni: il Verbalizzante riassume, non dibatte.
      - Produci il riepilogo a fine discussione, non durante.
---

Questo file è un **esempio**: l'estensione lo ignora perché il loader legge
solo `<cwd>/.gsd/discussion-arena/discussion-arena-coordination.md`. Il
frontmatter qui sopra è però identico a quello che il loader di produzione
parse, quindi puoi copiarlo così com'è.

## Cosa controlla

| Chiave | Effetto |
| ------ | ------- |
| `rounds_default` | Default dei round quando né il tool né il command passano un valore esplicito (livello 3 della gerarchia a 4 livelli) |
| `model_default` | Modello di fallback per i participant senza campo `model` |
| `activation` | Attivazione della discussion arena: `enabled` globale, `mode` (per-milestone / always-on / availability-only) e `milestones` per-MID |
| `roles_virtuals` | Ruoli one-off definiti interamente qui, senza file in `participants/` |

## Regole da ricordare

- La sezione legacy `discussion_arena:` in `PREFERENCES.md` è **deprecata** e
  sostituita dalla sezione `activation:` di questo file (stesse chiavi e
  stesso contratto di indentazione 2/4/6 spazi). Il loader la legge ancora
  per retrocompatibilità ma emette un deprecation warning one-shot su
  stderr: spostando qui la config e rimuovendo la sezione legacy il warning
  scompare.

- Il parsing della sezione `activation:` è fail-safe (stessa policy del resto
  del file): un `mode` fuori dai tre enum, un milestone ID che non rispetta
  la shape permissiva `[A-Za-z0-9_.\-]+` o un `enabled` non booleano vengono
  scartati con un warning D053, gli altri campi della sezione restano validi
  e la config non viene mai scartata (nessun throw).
- La chiave del dict (es. `scribe`) deve essere uguale al campo `name`
  dell'entry, altrimenti il ruolo viene saltato con un warning
  `virtual role '<key>' name field mismatch ... — skipped`.
- Un'entry incompleta (campo required mancante) viene saltata, le altre
  continuano a valere.
- Un valore `rounds_default` non intero o < 1 viene ignorato e si applicano
  i code defaults.

Riferimenti: [repo](https://github.com/efrembaraldo/gsd-pi-discussion-arena).
