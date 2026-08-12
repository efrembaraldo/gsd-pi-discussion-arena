/**
 * Entry point CLI standalone della discussion-arena (S02/M004).
 *
 * Invocabile SENZA gsd-pi attivo e senza passare dal default export
 * `activate` di index.ts (che richiede il runtime estensione): basta il
 * loader ESM dei test per eseguire il TypeScript direttamente:
 *
 *   node --import ./tests/ts-esm-loader.mjs src/discussion-arena-cli-main.ts --dump-participants
 *
 * La blast radius del CLI è così isolata dal runtime gsd-pi (Integration
 * Closure S02): questo modulo importa solo `dumpParticipantsCli`, che a sua
 * volta importa `participants.ts` (stub di @gsd/pi-coding-agent via loader).
 *
 * `dumpParticipantsCli` termina il processo con `process.exit(exitCode)`:
 * nessuna logica aggiuntiva qui.
 */

import { dumpParticipantsCli } from "./discussion-arena-cli.js";

dumpParticipantsCli(process.argv, process.cwd());
