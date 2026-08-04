/**
 * Hook ESM reali per eseguire i test TypeScript con `node --test` (D019, D004).
 *
 * Registrati da tests/ts-esm-loader.mjs. Due compiti:
 *
 * 1. Rimappatura specifier relativi `.js` -> sibling `.ts`
 *    participants.ts / index.ts importano i moduli interni con estensione
 *    `.js` (convenzione TS moduleResolution esnext/bundler). Sotto `node
 *    --test` nativo, questi puntano a file `.js` inesistenti sul disco (i
 *    sorgenti sono `.ts`), quindi il resolution di default fallisce con
 *    ERR_MODULE_NOT_FOUND. Qui, se il `.js` reale manca ma esiste il sibling
 *    `.ts`, rimappa all'estensione `.ts`.
 *
 * 2. Redirezione dello specifier bare `@gsd/pi-coding-agent`
 *    È una peerDependency opzionale non installata in node_modules (risolta
 *    solo a compile-time via tsconfig `paths` verso un checkout sibling). A
 *    runtime viene ridiretta allo stub locale self-contained
 *    tests/fixtures/pi-coding-agent-stub.ts, così la suite è riproducibile
 *    ovunque, anche in CI con un clone fresco (S04), senza il checkout esterno.
 *
 * Nessuna dipendenza npm: node:path, node:fs, node:url. Lo strip-types nativo
 * di V8 resta attivo per i file `.ts` (nessun transform hook necessario).
 *
 * Tutto ciò che non corrisponde ai due casi è delegato a `next` (default
 * resolver), e per i builtin node (node:test, node:assert...) non passiamo
 * casualmente nessuna rimappatura (nextResolve resta intatto).
 */
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function resolve(specifier, context, nextResolve) {
	// 1) Specifier bare @gsd/pi-coding-agent -> stub locale.
	if (specifier === "@gsd/pi-coding-agent") {
		const root = path.resolve(process.cwd());
		const stubPath = path.join(root, "tests", "fixtures", "pi-coding-agent-stub.ts");
		const url = pathToFileURL(stubPath).href;
		return { url, shortCircuit: true };
	}

	// 2) Specifier relativi `.js` che puntano a un sibling `.ts` (convenzione
	//    TS bundler resolution).
	if (specifier.startsWith("./") && specifier.endsWith(".js")) {
		const parentURL = context && context.parentURL;
		if (parentURL && parentURL.startsWith("file:")) {
			const parentPath = fileURLToPath(parentURL);
			const candidateJs = path.resolve(path.dirname(parentPath), specifier);
			// Se il `.js` reale non esiste ma il sibling `.ts` esiste, rimappa.
			if (!fs.existsSync(candidateJs)) {
				const candidateTs = candidateJs.replace(/\.js$/, ".ts");
				if (fs.existsSync(candidateTs)) {
					return {
						url: pathToFileURL(candidateTs).href,
						shortCircuit: true,
					};
				}
			}
		}
	}

	// Tutto il resto: risoluzione di default.
	return nextResolve(specifier, context);
}