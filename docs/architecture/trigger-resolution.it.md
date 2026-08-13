**Languages:** [English](trigger-resolution.md) · [Italiano](trigger-resolution.it.md)

[Architecture Reference](index.md) — Risoluzione del trigger

# Risoluzione del trigger

`resolveTrigger` (`trigger-resolver.ts:114`) è la funzione pura che decide
se la discussion arena è *forzata* nella sessione di planning o soltanto
*disponibile*. Implementa un fallback a tre tier — variabile d'ambiente,
poi `PREFERENCES.md`, poi un default sicuro — e, per contratto, **non lancia
mai**: ogni percorso della funzione ritorna una decisione, e gli input
malformati emergono come `warnings` e `parseErrors` invece che come
eccezione. Tutto in questa pagina è ancorato al sorgente: ogni simbolo e
riga citati qui sono verificati contro il codice corrente da
`tests/architecture-refs.test.ts`, quindi un rename o uno spostamento di
una funzione fa fallire la suite invece di lasciare marcire questa pagina.

## Il contratto della decisione: `ResolveTriggerOutput` (`trigger-resolver.ts:28`)

```ts
export interface ResolveTriggerOutput {
 decision: "forced" | "available-only";
 source: "env" | "preferences" | "fallback";
 warnings: string[];
 parseErrors: string[];
}
```

La decisione è binaria e la `source` spiega da dove arriva. I tre tier
sotto si mappano esattamente su tre combinazioni:

| Tier | Trigger | `decision` | `source` |
| --- | --- | --- | --- |
| 1 | `GSD_DISCUSSION_ARENA_AUTO === "1"` nell'ambiente | `forced` | `env` |
| 2 | `PREFERENCES.md` abilita la discussion arena per questo milestone o globalmente | `forced` | `preferences` |
| 3 | fallback, quando i tier 1–2 non hanno forzato nulla | `available-only` | `fallback` |

`warnings` raccoglie i problemi soft (file delle preferenze illeggibile, un
errore inatteso durante la lettura); `parseErrors` raccoglie le righe
malformate trovate durante il parsing del blocco `discussion_arena:`.
Nessuno dei due array viene mai lanciato: i caller che vogliono visibilità
li leggono, quelli che non la vogliono li ignorano in sicurezza.

## Tier 1 — la variabile d'ambiente

Il controllo d'ambiente è un'uguaglianza stretta sulla stringa grezza
(`trigger-resolver.ts:121`):

```ts
if (input.env.GSD_DISCUSSION_ARENA_AUTO === "1") {
```

Solo la stringa esatta `"1"` forza la discussion arena. Qualsiasi altra cosa — `"0"`,
stringa vuota, variabile non settata — ricade al tier 3: l'estensione non
tenta mai di interpretare `"0"` come override negativo, e non tratta mai
nessun altro valore come abilitazione. L'oggetto `env` viene passato
esplicitamente nell'`input` (`{ cwd, milestoneId, env }`), il che rende la
funzione pura e unit-testabile senza toccare l'ambiente di processo reale.

## Tier 2 — `PREFERENCES.md`

Se l'ambiente non ha forzato nulla, `parsePreferences`
(`trigger-resolver.ts:48`) legge `.gsd/PREFERENCES.md` sotto `cwd`,
estrae il blocco `discussion_arena:` e valuta due livelli di abilitazione,
in quest'ordine:

1. **Specifico per milestone** — `discussion_arena.milestones.<milestoneId>.enabled === true`;
2. **Globale** — `discussion_arena.enabled === true`.

Vince il primo hit: una entry di milestone ha precedenza sulla flag globale,
e un `enabled: false` esplicito per un milestone *sopprime* il default
globale per quel milestone. Un file mancante, privo di sezione
`discussion_arena:` o con sole entry negative non produce alcuna forzatura
e ricade al tier 3. Il campo `mode` che il wizard TUI scrive
(`per-milestone` / `always-on` / `availability-only`) è trasportato dal
blocco ma **non** viene consultato dal resolver: la decisione è guidata
esclusivamente dalle flag `enabled`.

Il file delle preferenze è lo stesso che `attachDiscussionArenaWizard`
scrive quando l'utente sceglie una strategia di attivazione all'avvio del
milestone (vedi la pagina [Invocation flow](invocation-flow.md)) — il
resolver è il lato di lettura di quella scrittura.

## Tier 3 — il fallback

Quando né l'ambiente né le preferenze hanno forzato la discussion arena, il resolver
ritorna `{ decision: "available-only", source: "fallback" }`. Il tool della
discussion arena resta registrato e chiamabile, ma gli hook di planning non
inietteranno l'istruzione e non esporranno il tool come forzato. Questo è
il default *sicuro*: l'auto-mode non si blocca mai su un file delle
preferenze mancante o corrotto.

## Il parser condiviso: `parseDiscussionArenaBlock` (`src/parse-discussion-arena-block.ts:103`)

Il parsing del blocco `discussion_arena:` è delegato al parser condiviso in
`src/`, non a un parser di proprietà del modulo trigger. La forma del blocco
è: sub-chiavi a 2 spazi, ID di milestone a 4 spazi, chiavi di milestone a 6
spazi, e gli ID di milestone rispettano la forma permissiva
`[A-Za-z0-9_.-]+` — la stessa forma che scrive il wizard TUI, così gli ID
contenenti `_` o `.` fanno round-trip attraverso `resolveTrigger` invece di
essere ignorati silenziosamente (il drift storico tra i due parser
pre-refactor proprio su questa regex è il motivo per cui il parser condiviso
esiste).

Il trigger lo consuma nella modalità default `strict: false`, quindi le
chiavi sconosciute e le indentazioni malformate vengono saltate in silenzio
— semantica identica ai parser pre-refactor. La modalità strict (che lancia
`DiscussionArenaParseError`) esiste per il path di validazione dei file di
override in S02 e non è usata dal trigger. L'import passa da
`src/shared-parser.ts`, il punto di re-export lessicalmente neutro che
tiene `trigger-resolver.ts` disaccoppiato dalla disposizione dei moduli in
`src/` (D004: zero dipendenze, manipolazione pura di righe, nessun pacchetto
YAML).

## Errori e osservabilità

Il contratto never-throw ha due lati visibili:

- **File delle preferenze mancante** — `ENOENT` viene inghiottito e
  trattato come "nessuna configurazione": il resolver ricade al tier 3
  senza warning. Questo è ciò che mantiene l'estensione utilizzabile in un
  repository che non ha mai scritto un `.gsd/PREFERENCES.md`.
- **Qualsiasi altra cosa** — gli errori di lettura inattesi vengono
  raccolti in `warnings`; le righe malformate in `parseErrors`. Nessuno dei
  due ferma la risoluzione.

Per i caller che vogliono una riga di log, `resolveTriggerWithLogging`
(`trigger-resolver.ts:190`) avvolge la funzione pura e scrive su stderr con
il prefisso strutturato `LOG_PREFIX` (`src/log-prefix.ts:12`), il cui
valore è il letterale `[discussion-arena]`:

```text
[discussion-arena] trigger resolved: decision=forced source=env
```

## Dove la decisione viene consumata

`activate` (`index.ts:903`) chiama `resolveTrigger` durante il load
dell'estensione (`index.ts:918`) come fire-and-forget: il risultato viene
passato a `attachDiscussionArenaHooks` in caso di successo, e in caso di
fallimento un messaggio viene scritto su stderr
(`[discussion-arena] error resolving trigger during activate: ...` a
`index.ts:931`) senza bloccare l'attivazione. L'id di milestone usato per
la lookup del tier 2 viene da `process.env.GSD_MILESTONE_ID`, con fallback
al letterale `"unknown"`. Come la decisione guida gli hook di planning —
iniezione dell'istruzione ed esposizione del tool set — è trattato nella
pagina [*Hooks*](hooks.md).

## Documentazione correlata

- [Architecture Reference](index.md) — indice del reference interno
- [Invocation flow](invocation-flow.md) — attivazione, registrazione e gli entry point che conducono al motore
- [Hooks](hooks.md) — cosa fa la decisione `forced` una volta arrivata alla sessione di planning
- [User Guide](../user-guide/index.md) — installazione e uso dell'estensione
- [Contributor Guide](../contributor-guide/index.md) — convenzioni del repository
- [README](../../README.md) — panoramica, quickstart e limitazioni note
