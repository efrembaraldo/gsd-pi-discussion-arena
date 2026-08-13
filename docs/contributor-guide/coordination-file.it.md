**Lingue:** [English](coordination-file.md) · [Italiano](coordination-file.it.md)

[Guida per i contributor](index.it.md) — Coordination file

# Il coordination file

Il coordination file per-progetto definisce la "forma" della discussion
arena. Vive in `.gsd/discussion-arena/discussion-arena-coordination.md` e
viene letto con una ricerca **walk-up** da `cwd` verso la root git, esattamente
come la directory dei participant di progetto. È la fonte canonica di tre
cose:

| Chiave | Effetto |
| --- | --- |
| `rounds_default` | Default del numero di round quando né il tool né il command passano un valore esplicito (livello 3 della gerarchia a 4 livelli di `resolveRoundsDefault`, `participants.ts`) |
| `model_default` | Modello di fallback applicato ai participant senza `model` esplicito (inclusi i ruoli virtuali) |
| `roles_virtuals` | Ruoli one-off definiti interamente qui, senza file in `participants/` |

Il loader è `loadDiscussionArenaCoordination`
(`src/discussion-arena-coordination.ts`), la stessa funzione che l'estensione
esegue a runtime. Il suo contratto: **mai throw** — ogni errore di parsing
produce una config vuota con un diagnostico `[discussion-arena]` su stderr
(D053), e un file assente è un no-op silenzioso. Lo snippet copiabile di
questa pagina è validato contro quel loader di produzione da
`tests/contributor-guide-snippets.test.ts`: deve caricarsi con zero warning.

## Un coordination file copiabile

Il file è un documento Markdown il cui frontmatter segue un sottoinsieme
YAML indentation-aware (D051): chiavi top-level a 0 spazi, ogni chiave di
ruolo virtuale a 2, i suoi campi a 4, il block scalar `systemPrompt` più in
profondità. I commenti (`#`) e i commenti inline vengono strippati. Copia
questo file in `.gsd/discussion-arena/discussion-arena-coordination.md` nel
tuo progetto:

```coordination
---
# Forma della discussion arena: round, modello e ruoli virtuali.
rounds_default: 2
model_default: freeinference_efrem/minimax-m3
roles_virtuals:
  scribe:
    name: scribe
    role: Scribe
    description: Consolida le conclusioni del consiglio in un riepilogo finale
    systemPrompt: |
      Sei lo Scribe del consiglio di agenti. Il tuo compito è produrre un
      riepilogo finale della discussione: decisioni prese, trade-off emersi
      e azioni conseguenti. Sii sintetico e fedele agli interventi reali.
---

Copia questo file in `.gsd/discussion-arena/discussion-arena-coordination.md`
e la discussion arena applicherà i suoi default al prossimo run.
```

L'harness scrive questo snippet in un file temporaneo e lo passa a
`loadDiscussionArenaCoordination`: deve tornare con zero warning e ogni
valore dichiarato nel frontmatter (`rounds_default`, `model_default` e le
chiavi dei ruoli virtuali) deve essere presente nella config parsata.

## Schema del frontmatter

| Chiave | Indent | Obbligatoria | Significato |
| --- | --- | --- | --- |
| `rounds_default` | 0 | no | Integer positivo (>= 1); default del numero di round al livello 3 della gerarchia |
| `model_default` | 0 | no | Modello di fallback per i participant senza `model` esplicito |
| `roles_virtuals` | 0 | no | Apre la sezione dei ruoli virtuali (dict) |
| `<chiave>:` | 2 | — | Chiave del ruolo virtuale; deve coincidere con il campo `name` dell'entry |
| `name` / `role` / `description` / `systemPrompt` | 4 | sì | I quattro campi obbligatori di un ruolo virtuale |

Regole del loader:

- `rounds_default` deve essere un integer >= 1. Un valore non intero o 0
  viene ignorato con warning D053 e si applicano i code defaults.
- Un ruolo virtuale a cui manca uno dei quattro campi obbligatori viene
  saltato con warning D053; le altre entry continuano a valere.
- Una chiave del dict diversa dal campo `name` dell'entry fa saltare il
  singolo ruolo con il warning
  `virtual role '<key>' name field mismatch '<name>' — skipped` (gli altri
  ruoli restano applicati).
- Le chiavi top-level sconosciute vengono ignorate silenziosamente
  (forward compatibility: un file scritto per una versione futura non deve
  azzerare la config).
- Un file senza frontmatter (senza `---` iniziale) è un no-op silenzioso.

Il `rounds_default` del coordination file alimenta `resolveRoundsDefault`
(`participants.ts`) come livello 3 della gerarchia: parametro del tool (1) >
frontmatter del participant (2, riservato) > `rounds_default` del
coordination (3) > code default (4). `model_default` viene applicato da
`discoverParticipants` come fallback su ogni participant risolto senza campo
`model` esplicito — ruoli virtuali inclusi.

## Ruoli virtuali

Un ruolo virtuale è un participant di prima classe con `source: "virtual"` e
`filePath` che punta al coordination file. Non ha bisogno di un file in
`participants/`, ma partecipa alla mappa di precedenza esattamente come un
ruolo base: tier base (bundled, user, project) < virtual < override (D052).
Questo significa anche che un override che punta a un ruolo virtuale **non**
è un orfano.

## Di cosa avvisa il loader

Il loader non lancia mai: un valore malformato degrada la config, non il
processo. Lo snippet sotto è deliberatamente invalido (`rounds_default: 0`)
e l'harness lo usa per provare che il loader emette il warning registrato:

```coordination-invalid
---
rounds_default: 0
---

Questo file è deliberatamente invalido: `rounds_default` deve essere un
integer positivo, quindi il loader emette il warning D053 e applica i code
defaults.
```

Il warning esatto è
`rounds_default must be a positive integer (got 0) — using code defaults`.
Se i tuoi default "non vengono applicati", ricontrolla il frontmatter contro
la tabella dello schema qui sopra e cerca il prefisso `[discussion-arena]`
su stderr.

## Documentazione correlata

- [Guida per i contributor](index.it.md) — navigazione e convenzioni
- [Partecipanti](participants.it.md) — file participant, precedenza e override
- [Guida per l'utente](../user-guide/index.it.md) — installare e usare l'estensione
- [Architecture Reference](../architecture/index.it.md) — come la discussion arena risolve round e modelli
- [README](../../README.it.md) — panoramica, quickstart e limiti noti
