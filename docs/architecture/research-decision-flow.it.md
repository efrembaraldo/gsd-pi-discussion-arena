**Lingue:** [English](research-decision-flow.md) · [Italiano](research-decision-flow.it.md)

[Riferimento architetturale](index.it.md) — Flusso research-decision

# Flusso research-decision

Il flusso research-decision trasforma un run di `discussion_arena` nella fase
di ricerca in requisiti e decisioni durevoli GSD. È la superficie di consegna
della milestone M008: un gate chiede all'utente di approvare una deliberazione
di ricerca, l'agente lancia la discussion arena e — una volta approvata —
la struttura prodotta dal Scribe viene persistita e poi ingerita nei
registri di requisiti
e decisioni del progetto (`gsd_requirement_save` / `gsd_decision_save`).

Questa pagina documenta la pipeline in nove step, end to end. Ogni simbolo e
riga citati qui sono ancorati al sorgente attuale da
`tests/architecture-refs.test.ts`, così una rinomina o uno spostamento fa
fallire la suite invece di far marcire la pagina.

## Panoramica della pipeline

```text
 research-decision       1. il gate research-decision si apre
 ──► discussion arena    2. l'hook inietta il tool discussion_arena
     ──► Scribe          3. l'agente lancia la discussion arena
     ──► transcript      4. il Scribe produce il transcript markdown
     ──► structured      5. l'extractor parsa il transcript
     ──► pending       6. il writer persiste pending-research.json
     ──► approved        7. l'utente approva il gate
     ──► ingest          8. l'ingestion legge pending → gsd_requirement_save / gsd_decision_save
     ──► cleanup         9. i file pending vengono rimossi
```

Ogni step è di proprietà di un modulo, documentato nelle sezioni seguenti.

## Step 1 — il gate research-decision si apre

Quando il milestone entra nella fase research, il gate `depth_verification`
della ricerca viene proposto all'utente. Nulla di questo flusso gira prima
dell'apertura del gate — la presenza di una deliberazione di ricerca da
estrarre è una precondizione per ogni step successivo.

## Step 2 — l'hook inietta la discussion arena

Una volta ingaggiato il gate, un hook del ciclo di vita espone
`discussion_arena` all'agente così che la deliberazione possa davvero
avvenire. È la stessa macchina trigger/hook descritta nelle pagine
[*Hook*](hooks.it.md) e [*Risoluzione del trigger*](trigger-resolution.it.md)
— il flusso la riusa piuttosto che duplicarla.

## Step 3 — l'agente lancia la discussion arena

L'agente chiama `discussion_arena` con il topic della ricerca. La discussion arena esegue
il pannello dei partecipanti sui round configurati e restituisce un transcript
— vedi [*Orchestrazione dei round*](round-orchestration.it.md) per come il
transcript viene assemblato.

## Step 4 — il Scribe produce il transcript

Al termine del run il participant Scribe produce un transcript markdown con
tre sezioni strutturate: `## Ipotesi`, `## Decisioni` e `## Requisiti`.
Questa forma canonica è quella consumata dall'extractor.

## Step 5 — l'extractor parsa il transcript

`extractResearchDecisions` (`src/discussion-arena-research-extractor.ts:211`)
parsa il transcript in una struttura tipizzata `ResearchDecisions` con
`hypotheses`, `decisions` e `requirements`. Il parser è deterministico e
fail-safe: se il transcript non è sufficientemente strutturato restituisce un
marker `fallback: "model-call-needed"` invece di lanciare — così una model
call diventa una decisione esplicita a valle piuttosto che un crash silenzioso.

## Step 6 — il writer persiste pending-research

Una volta che la struttura tipizzata è disponibile, `writePendingResearch`
(`src/discussion-arena-pending-research.ts:182`) scrive i due file sotto
`cwd/.gsd/discussion-arena/` atomicamente (write-then-rename):

- `pending-research.json` — la struttura tipizzata, incapsulata come
  `{ version: 1, structured }` (nome file dalla costante
  `PENDING_RESEARCH_JSON_FILENAME`,
  `src/discussion-arena-pending-research.ts:46`);
- `pending-research.md` — il transcript completo human-readable.

Entrambi i file vivono nella stessa directory del coordination file, così che
l'opt-in `ingestion` descritto allo Step 8 li legga da lì.

## Step 7 — l'utente approva il gate

I file pending-research sono inerti finché l'utente non approva il gate.
L'approvazione è il trigger che autorizza l'ingestion; fino ad allora nulla
viene scritto nei registri dei requisiti o delle decisioni GSD.

## Step 8 — l'ingestion legge i pending e salva

L'ingestion gira sull'evento `milestone_end` (registrato in `index.ts`
attraverso l'hook `attachIngestionHooks`, `src/discussion-arena-ingestion.ts:514`)
**prima** dell'hook di cleanup, così legge i file pending mentre esistono
ancora. È opt-in: vengono eseguiti solo i progetti il cui coordination file ha
`ingestion.enabled: true`.

`ingestPendingResearch` (`src/discussion-arena-ingestion.ts:404`) legge
`pending-research.json`, costruisce un piano ordinato di requisiti e decisioni,
e per ogni voce non ancora nel ledger di idempotenza emette un *save intent*
attraverso due adapter iniettati:

- ogni `requirement` → `gsd_requirement_save`;
- ogni `decision` → `gsd_decision_save`.

Gli adapter di default (`createFileOutboxAdapters`,
`src/discussion-arena-ingestion.ts:361`) accodano ogni intent come riga JSON a
`ingestion-outbox.jsonl` — un handoff durevole per chi poi esegue i veri
`gsd_requirement_save`/`gsd_decision_save`. Poiché il modulo accetta adapter
iniettati con la shape stabile dell'extractor, l'harness può anche fornire
adapter che chiamano i tool direttamente e la logica resta la stessa.

## Step 9 — cleanup

Una volta che l'ingestion ha letto i file pending, l'hook cleanup di
`milestone_end` li rimuove così che nessun artefatto di ricerca stale possa
sopravvivere. `cleanupPendingResearch`
(`src/discussion-arena-pending-research.ts:236`) elimina entrambi i file
(ENOENT ignorato), e un fallback TTL su `unit_start` copre il caso in cui
`milestone_end` non sia mai arrivato (ad esempio una sessione crashata).

## Idempotenza

L'ingestion è idempotente per costruzione: `ingestPendingResearch` mantiene un
`ingestion-ledger.json` accanto ai file pending e registra una chiave
deterministica per ogni voce già salvata (requisito: il suo `id` o un hash
stabile di title+description; decisione: un hash stabile dello statement).
Ri-eseguire l'ingestion sullo stesso albero salta tutto ciò che è già nel
ledger, e un append sull'outbox non duplica mai. Vale tra processi perché la
chiave è una funzione pura dell'input — nessun timestamp.

## Troubleshooting

| Sintomo | Causa | Fix |
| --- | --- | --- |
| L'ingestion non ha fatto nulla | `ingestion.enabled` è `false` o assente nel coordination file | Imposta `ingestion: { enabled: true }` |
| "no pending-research file" | `pending-research.json` non è mai stato scritto o è già stato pulito | Ri lancia la discussion arena e approva il gate |
| Requisiti/decisioni duplicati | Ledger azzerato o contenuto sorgente cambiato di chiave | Conferma che `ingestion-ledger.json` esista; non cancellarlo a mano |
| Intent di decisione mancante | Lo statement estratto non era un bullet di primo livello di `## Decisioni` | Controlla la forma del transcript del Scribe |
| Nulla appare in REQUIREMENTS.md | L'adapter harness che chiama i veri tool `gsd_*` non ha consumato l'outbox | Consuma `ingestion-outbox.jsonl` o inietta gli adapter reali |

## Documentazione correlata

- [Riferimento architetturale](index.it.md) — indice del riferimento interno
- [Hook](hooks.it.md) — come il tool viene iniettato e gli hook vengono attachati
- [Orchestrazione dei round](round-orchestration.it.md) — come viene assemblato il transcript del Scribe
- [User Guide](../user-guide/index.it.md) — installare e usare l'estensione
- [README](../../README.it.md) — panoramica, quickstart e limiti noti
