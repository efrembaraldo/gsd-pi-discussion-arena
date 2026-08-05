#!/usr/bin/env node
// scripts/setup-types.mjs
//
// Copies @gsd/pi-coding-agent .d.ts files from a built gsd-pi checkout into
// ./vendor/pi-coding-agent/dist/. Required because @gsd/pi-coding-agent is a
// workspace package inside the gsd-pi monorepo, NOT published as a standalone
// npm package, so `npm install` cannot fetch it.
//
// Idempotent: exits 0 if types already present.
//
// Resolution priority:
//   1. GSD_PI_CHECKOUT env var (explicit override; CI uses /tmp/gsd-pi)
//   2. /home/opengsd/repos/open-gsd_gsd-pi (canonical local dev path)
//   3. /tmp/gsd-pi (CI default)

import {
	existsSync,
	mkdirSync,
	readdirSync,
	statSync,
	copyFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);
const DEST_DIST = join(ROOT, "vendor", "pi-coding-agent", "dist");
const DEST_INDEX = join(DEST_DIST, "index.d.ts");

if (existsSync(DEST_INDEX)) {
	console.log(
		"[setup-types] vendor/pi-coding-agent/dist/index.d.ts already present, skipping",
	);
	process.exit(0);
}

const candidates = [
	process.env.GSD_PI_CHECKOUT,
	"/home/opengsd/repos/open-gsd_gsd-pi",
	"/tmp/gsd-pi",
];

let sourcePkg = null;
let sourcePath = null;
for (const candidate of candidates) {
	if (!candidate) continue;
	const pkg = join(candidate, "packages", "pi-coding-agent");
	if (existsSync(join(pkg, "dist", "index.d.ts"))) {
		sourcePkg = pkg;
		sourcePath = candidate;
		break;
	}
}

if (!sourcePkg) {
	console.error(
		"[setup-types] FAIL: no built gsd-pi checkout found with packages/pi-coding-agent/dist/index.d.ts",
	);
	console.error("");
	console.error("  Tried:");
	for (const c of candidates.filter(Boolean)) {
		console.error(`    - ${c}/packages/pi-coding-agent/dist/index.d.ts`);
	}
	console.error("");
	console.error("  Fix:");
	console.error(
		"  - Set GSD_PI_CHECKOUT=<path> to a gsd-pi checkout with packages/pi-coding-agent/dist/",
	);
	console.error(
		"  - OR build it: cd <gsd-pi-checkout> && pnpm install && pnpm --filter @gsd/pi-coding-agent build",
	);
	console.error(
		"  - OR clone+build it: git clone https://github.com/open-gsd/gsd-pi.git /tmp/gsd-pi && cd /tmp/gsd-pi && pnpm install && pnpm --filter @gsd/pi-coding-agent build",
	);
	process.exit(1);
}

const sourceDist = join(sourcePkg, "dist");
console.log(`[setup-types] copying .d.ts from ${sourceDist} -> ${DEST_DIST}`);
mkdirSync(DEST_DIST, { recursive: true });

function copyDtsOnly(srcDir, dstDir) {
	for (const entry of readdirSync(srcDir)) {
		const srcPath = join(srcDir, entry);
		const dstPath = join(dstDir, entry);
		const stat = statSync(srcPath);
		if (stat.isDirectory()) {
			mkdirSync(dstPath, { recursive: true });
			copyDtsOnly(srcPath, dstPath);
		} else if (entry.endsWith(".d.ts")) {
			copyFileSync(srcPath, dstPath);
		}
	}
}

copyDtsOnly(sourceDist, DEST_DIST);
console.log(`[setup-types] done (from ${sourcePath})`);
