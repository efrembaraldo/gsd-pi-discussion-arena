/**
 * scripts/s03-t01-smoke.mjs — Smoke test per runInit() di S03/T01.
 *
 * Estratto dal vecchio verify inline `--eval "..."` (che era strutturalmente
 * rotto perché il contesto `--input-type=module` di Node ESM non espone
 * `require`). Stessa logica, stessi exit code 1-4, stesso controllo su
 * `created.length` / `skipped.length` per la prima e seconda invocazione.
 *
 * Exit codes:
 *   1 — run1: created.length !== 4
 *   2 — run1: skipped.length !== 0
 *   3 — run2 (idempotente): created.length !== 0
 *   4 — run2 (idempotente): skipped.length !== 4
 *
 * Invocato dal verify di T01 via:
 *   node --import ./tests/ts-esm-loader.mjs scripts/s03-t01-smoke.mjs
 */
import * as fs from "node:fs";
import { runInit } from "../src/init.ts";

const cwd = fs.mkdtempSync("/tmp/s03-smoke-");
const r = runInit(cwd);
if (r.created.length !== 4) {
	console.error("FAIL: created.length=" + r.created.length);
	process.exit(1);
}
if (r.skipped.length !== 0) {
	console.error("FAIL: skipped.length=" + r.skipped.length);
	process.exit(2);
}
const r2 = runInit(cwd);
if (r2.created.length !== 0) {
	console.error("FAIL: idempotent violated: created.length=" + r2.created.length);
	process.exit(3);
}
if (r2.skipped.length !== 4) {
	console.error("FAIL: skipped.length=" + r2.skipped.length);
	process.exit(4);
}
console.log("OK");