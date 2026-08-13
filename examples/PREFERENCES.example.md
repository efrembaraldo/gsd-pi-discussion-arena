---
# PREFERENCES.example.md
#
# Esempio della sezione `discussion_arena:` per il file `.gsd/PREFERENCES.md`
# del tuo progetto gsd-pi. Copia questo blocco nel tuo PREFERENCES.md per
# attivare la modalità auto della discussion arena.
#
# Contratto del formato (parser condiviso, S01):
#   - il blocco `discussion_arena:` è una chiave root del frontmatter;
#   - sub-chiavi a 2 spazi: enabled, mode, milestones;
#   - ID di milestone a 4 spazi (forma permissiva: lettere, cifre, _, . e -);
#   - chiavi di milestone a 6 spazi: enabled: true|false;
#   - in strict:true una chiave sconosciuta o un'indentazione fuori schema
#     lancia DiscussionArenaParseError (usato per validare i file di override).
auto_mode:
  enabled: false
discussion_arena:
  enabled: true
  mode: per-milestone
  milestones:
    M001:
      enabled: true
    M002:
      enabled: false
    M003:
      enabled: true
---

Questo file è un **esempio**: l'estensione ignora `PREFERENCES.example.md`
perché `resolveTrigger` legge solo `<cwd>/.gsd/PREFERENCES.md`. Il blocco
frontmatter qui sopra è però identico a quello che il parser di produzione
legge, quindi puoi copiarlo così com'è.

## Semantica dei campi

| Chiave | Effetto |
| ------ | ------- |
| `enabled: true` | La discussion arena è forzata (decision `forced`, source `preferences`) quando nessun valore del milestone la sovrascrive |
| `mode: per-milestone` | Il trigger segue la tabella `milestones` |
| `milestones.<MID>.enabled` | Forza/nega la discussion arena per un singolo milestone; vince sul flag globale |

La gerarchia del trigger è a 3 tier: env `GSD_DISCUSSION_ARENA_AUTO=1` (tier
>
1) > PREFERENCES `discussion_arena` (tier 2) > fallback `availability-only`
(tier 3). In questo esempio, con il milestone attivo `M001` il decision è
`forced` con source `preferences`.

Riferimenti: [repo](https://github.com/efrembaraldo/gsd-pi-discussion-arena).
