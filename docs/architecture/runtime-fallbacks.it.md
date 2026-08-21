**Languages:** [English](runtime-fallbacks.md) · [Italiano](runtime-fallbacks.it.md)

[Architecture Reference](index.md) — Runtime fallbacks

# Runtime fallbacks

Questa pagina è lo spazio di atterraggio per i sette fallback runtime
(R1–R7) elencati nella Vision v2 §10 relativamente all'integrazione con
`gsd-pi`. Le sezioni sottostanti sono scheletri volutamente vuoti: saranno
compilate dai milestone che implementano ciascuna mitigazione. Una
intestazione `## Rn` vuota significa "mitigazione non ancora implementata" —
un segnale onesto, mai una chiusura della questione.

## R1

## R2

## R3

## R4

**Rischio:** Esecuzione della matrice 6×6 (6 capability profile × 6
fasi attive = 36 celle) con spawn del binario reale `gsd` (caricato
da `@opengsd/gsd-pi@latest`) in ogni cella, in CI. Lo spawn è
time-consuming (timeout 30 s per cella, ~3 min totali al carico
nominale), dipende da un side-effect esterno (npm registry per
l'install globale) e può divergere se l'upstream di
`@opengsd/gsd-pi` modifica la firma del marker stderr
(`[discussion-arena DEGRADED]`) che il runner parsa per determinare
il tier osservato.

### Registro del rischio

| Campo | Valore |
| ------- | -------- |
| Probability | Low |
| Impact | Medium |
| Mitigation type | Trigger `workflow_dispatch` manuale + skip contract a 4 stati + integration test sugli helper pubblici |
| PR candidacy | candidate |
| Upstream issue | D109 (trigger), D022 (no spawn su push) |

### Mitigazione attuale

**Command pattern CI prescelto**: il job `e2e-real` in
`.github/workflows/ci.yml` esegue, in ordine:

1. `actions/checkout@v4` del repo corrente.
2. `actions/setup-node@v4` con `node-version: "22"` + `cache: npm`.
3. `npm ci` (install delle dipendenze del repo).
4. `npm install -g @opengsd/gsd-pi@latest` (popola PATH con il
   binario `gsd`; l'helper `findGsd` di `scripts/e2e-real.mjs` lo
   risolve automaticamente).
5. `npm run e2e-real` (invoca lo script con il loader TS).

Il runner è orchestrato da `scripts/e2e-real.mjs`, modulo ESM
(Node ≥ 18) che:

- importa la matrice dichiarativa da `src/runtime-profiles.ts`
  (`SCENARIO_MATRIX`, 36 celle);
- esegue `findGsd` per risolvere il path assoluto del binario;
- per ogni cella crea una `os.tmpdir()` isolata con prefisso
  `e2e-real-<profile>-<phase>-`, copia il minimo `.gsd/runtime/` +
  `gsd.db` vuoto, spawna il child `gsd` con `GSD_E2E_PROFILE` +
  `GSD_E2E_PHASE` + `GSD_VERSION` (o unset) + `GSD_PROJECT_ID`;
- parsa la riga `[discussion-arena DEGRADED]` su stderr per dedurre
  il tier osservato;
- emette una summary line grep-friendly per scenario:
  `[e2e-real] <profile>/<phase>: tier=<F|A|D> reasons=[...] exit=<0|1>`;
- in caso di mismatch emette la FAIL line diagnostica:
  `[e2e-real] FAIL scenario=<profile>/<phase> expected=<F|A|D> got=<F|A|D|?> reasons=[...]`.

**Skip mode contract a 4 stati**:

| Stato | Trigger | Exit code | Significato |
| --- | --- | --- | --- |
| Skip esplicito | `GSD_E2E_SKIP=1` | 0 | L'utente richiede lo skip; nessuna matrice. |
| Skip implicito | `gsd` non su PATH | 2 | `findGsd` ritorna `null`; la CI deve aver installato `@opengsd/gsd-pi@latest`. |
| OK | tutti gli scenari matchano | 0 | Tutti i 36 scenari hanno `observedTier === expectedTier`. |
| FAIL | almeno un mismatch | 1 | Almeno una cella degradata o con tier inatteso. |

### Contratto comportamentale

Il job `e2e-real` NON scatta su `push:` né su `pull_request:` (D022:
nessuno spawn di `gsd` reale su push CI). Scatta solo on-demand via
`gh workflow run e2e-real`, coperto dal trigger `workflow_dispatch:`
top-level del file (riga 11 di `.github/workflows/ci.yml`). La
condizione `if: github.event_name == 'workflow_dispatch'` sul job
rende esplicita la semantica on-demand.

Le 36 celle della matrice sono coperte dallo script senza mock: lo
spawn del child `gsd` è reale, l'env var override è reale, il tier
osservato è parsato dalla stderr reale del child. Il contratto di
classificazione (`[discussion-arena DEGRADED] reason: <code1>,<code2>`)
è documentato come forward contract in `scripts/e2e-real.mjs` (header
JSDoc). Le 18 celle `fake-gsd-only` (Tier D non riproducibili contro
il binario reale) sono short-circuitate con `skipped: true, exitCode: 0`
senza spawn.

### Test

- `tests/integration/s02-e2e-real.test.ts` — 12 `test()` cases sui
  4 helper pubblici di `scripts/e2e-real.mjs` (`findGsd`,
  `parseTierLine`, `envForScenario` + `buildSpawnEnv`,
  `formatSummaryLine` + `formatFailLine`), `SCENARIO_MATRIX.length === 36`,
  2 path `runScenario` (skip mode + end-to-end con fake-gsd in
  `tests/fixtures/fake-gsd/gsd`), e CI yaml sanity (T12 cross-check
  con T01).
- `tests/runtime-fallbacks-r4.test.ts` — guardia bilingue:
  asserisce che questa sezione `## R4` sia presente con i campi
  obbligatori in EN e IT in modo speculare.

## R5

## R6

**Rischio:** Race tra `writePendingResearch` eseguito dal callback
`discussion_arena.execute` (unità `research-decision`) e l'ingestion su
`milestone_end` (lifecycle hook `attachPendingResearchLifecycleHooks`)
quando più processi operano in concorrenza sullo stesso `<cwd>`.

### Registro del rischio

| Campo | Valore |
| ------- | -------- |
| Probability | Medium |
| Impact | High |
| Mitigation type | Cross-process lock file + serial critical section |
| PR candidacy | candidate |
| Upstream issue | TBD |

### Mitigazione attuale

Lock file `<cwd>/.gsd/discussion-arena/pending-research.lock` con claim
atomico `open(path, "wx")` (POSIX `O_CREAT|O_EXCL`), attesa bounded
(`timeoutMs=5000` di default), stale recovery (`staleAfterMs=30000`),
corrupt recovery, release ownership-safe (rifiuta l'unlink se il lock
corrente ha `(pid, createdAtMs)` diversi dal proprio handle;
idempotente su doppia release), wrapper
`withPendingResearchLock(cwd, fn, opts?)` che garantisce `try/finally`
anche su throw. Le primitive sono esportate da
`src/discussion-arena-pending-research.ts`:
`acquirePendingResearchLock`, `releasePendingResearchLock`,
`withPendingResearchLock`, `pendingResearchLockPath`,
`PendingResearchLockTimeoutError`, `PENDING_RESEARCH_LOCK_FILENAME`.

Il wiring è applicato in due punti:

1. `index.ts` — `buildDiscussionArenaExecute(api, { stderr })`
   cattura `getCurrentUnitType(api)` (fornito da T01 in
   `src/hooks-unit-aware.ts`) all'inizio dell'invoke; quando l'unità è
   `research-decision` e l'extractor NON cade in fallback, esegue
   `writePendingResearch` dentro `withPendingResearchLock(ctx.cwd, ...,
   { stderr })`; il flag `details.pendingResearchWritten` riflette se
   il write ha mutato i file (idempotente per stesso payload).
2. `src/discussion-arena-ingestion.ts` —
   `attachPendingResearchLifecycleHooks(api, options)` registra un
   UNICO listener `milestone_end` che esegue
   `ingestPendingResearch(cwd)` → `cleanupPendingResearch(cwd)` nella
   STESSA sezione critica di `withPendingResearchLock`: l'ingestion
   osserva i file pending, il cleanup li rimuove, un writer successivo
   arriva DOPO il rilascio e non viene rimosso dal cleanup precedente.
   Su `PendingResearchLockTimeoutError` il lifecycle preserva i file
   pending (TTL logico: retry alla prossima `milestone_end` o recovery
   stale-based). Log stderr strutturato con prefisso canonico
   `[discussion-arena]` per acquisizione, attesa (singolo evento,
   niente spam), stale-recovery, corrupt-recovery, timeout e rilascio.

### Contratto comportamentale

Due processi distinti sullo stesso `<cwd>` NON entrano MAI
simultaneamente nella sezione critica del lock. La proprietà è
garantita dal kernel (POSIX `O_CREAT|O_EXCL`), non da primitive
in-process. I log strutturati permettono di diagnosticare
serializzazione, attesa, recovery e timeout senza ispezione manuale
del file system. I fallimenti di estrazione o persistenza restano
non-fatali ma osservabili (`details.pendingResearchWritten === false`
segnala il mancato write senza abortire il tool). Un timeout del
lifecycle preserva i file pending per retry/TTL — la pulizia non viene
forzata a costo di perdita dati.

### Test

- `tests/unit/pending-research-lock.test.ts` — 16 test: acquire con
  prefisso canonico, mkdir ricorsivo, release idempotente, release
  ownership-safe (lock rubato), stale recovery, corrupt recovery,
  timeout strutturato, `withPendingResearchLock` su success / throw /
  acquire-timeout, e due test cross-process (main attende child +
  due child distinct che serializzano un contatore condiviso e
  producono `2`).
- `tests/integration/s01-tool-call-site.test.ts` — 7 test del
  call-site cablato: research-decision scrive, planning/unknown/
  fallback/replay non scrivono, lock timeout non propaga al return,
  run throw → error details; `details.pendingResearchWritten`
  osservabile.
- `tests/integration/s01-race-condition.test.ts` — 4 test
  cross-process: RC-1 due execute concorrenti serializzati dal lock
  con lock events in ordine strict + idempotenza osservata sul
  secondo execute; RC-2 ingestion-then-cleanup dentro lo stesso lock;
  RC-3 cleanup-only quando ingestion è disattivata; RC-4 no-op su
  pending assenti.
- `tests/runtime-fallbacks-r6.test.ts` — guardia bilingue: asserisce
  che questa sezione `## R6` sia presente con i campi obbligatori in
  EN e IT in modo speculare.

## R7
