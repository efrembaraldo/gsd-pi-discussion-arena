/**
 * Entry point del resolve hook per eseguire i test TypeScript con `node --test`
 * senza bundler (D019, D004).
 *
 * Usato da `npm test` come `node --import ./tests/ts-esm-loader.mjs --test`.
 * Registra gli hook ESM reali, che vivono in tests/ts-hooks.mjs (il pattern
 * `register(hooksObject)` inline non è più valido su Node v24: l'argomento
 * deve essere un URL a un modulo che esporta `resolve`/`load`).
 *
 * Vedi tests/ts-hooks.mjs per la logica di rimappatura `.js` -> `.ts` e della
 * redirezione dello specifier bare `@gsd/pi-coding-agent` allo stub locale.
 */
import { register } from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const hooksUrl = pathToFileURL(path.join(process.cwd(), "tests", "ts-hooks.mjs")).href;
register(hooksUrl, { parentURL: pathToFileURL(process.cwd() + "/").href });