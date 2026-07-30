#!/usr/bin/env bun
/**
 * Publish a directory of already-built app outputs as the next-start trusted
 * app catalog generation (ADR-0153). This is the promotion step only: it
 * validates and copies finished `dist/` trees, it does not install
 * dependencies or run build scripts. A running Epicenter keeps serving the
 * generation it selected at startup; the published one activates at the next
 * full restart.
 *
 * Usage:
 *   bun run scripts/publish-app-catalog.ts <candidate-dir> [--data-dir <dir>]
 *
 * `<candidate-dir>` holds one directory per app: `<id>/index.html ...`.
 * `--data-dir` defaults to EPICENTER_DATA_DIR.
 */

import { join, resolve } from 'node:path';
import { promoteAppCatalogCandidate } from '../src/app-catalog.ts';
import { SURFACE_ROUTES } from '../src/routes.ts';

function usage(): never {
	console.error(
		'Usage: bun run scripts/publish-app-catalog.ts <candidate-dir> [--data-dir <dir>]',
	);
	process.exit(1);
}

const args = Bun.argv.slice(2);
const dataDirFlag = args.indexOf('--data-dir');
const dataDir =
	dataDirFlag === -1
		? process.env.EPICENTER_DATA_DIR
		: args.splice(dataDirFlag, 2)[1];
const [candidate] = args;
if (candidate === undefined || args.length !== 1) usage();
if (!dataDir) {
	console.error(
		'Pass --data-dir or set EPICENTER_DATA_DIR to the Epicenter app data directory.',
	);
	process.exit(1);
}

const { generation, apps } = await promoteAppCatalogCandidate(
	join(dataDir, 'app-catalog'),
	resolve(candidate),
	{ reservedIds: Object.keys(SURFACE_ROUTES) },
);
console.log(`Published catalog generation ${generation}:`);
for (const app of apps) {
	console.log(`  ${app.id} (${app.title})`);
}
if (apps.length === 0) console.log('  (no apps)');
console.log('It takes effect after the next full Epicenter restart.');
