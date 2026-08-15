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
 *   bun run scripts/publish-app-catalog.ts <candidate-dir>
 *
 * `<candidate-dir>` holds one directory per app, each with `index.html` and
 * a `workspace.json` declaring the workspace id it owns (ADR-0210). The directory name
 * itself means nothing.
 * The catalog is published into the one Epicenter root, which the host itself
 * resolves at boot; `EPICENTER_DATA_DIR` moves both together (ADR-0201). There
 * is deliberately no second flag for it: a script that could name a different
 * root than the running host would publish a generation nothing ever selects.
 */

import { join, resolve } from 'node:path';
import { epicenterDataRoot } from '@epicenter/constants/app-data';
import { promoteAppCatalogCandidate } from '../src/app-catalog.ts';

function usage(): never {
	console.error(
		'Usage: bun run scripts/publish-app-catalog.ts <candidate-dir>',
	);
	process.exit(1);
}

const args = Bun.argv.slice(2);
const [candidate] = args;
if (candidate === undefined || args.length !== 1) usage();

const { generation, apps } = await promoteAppCatalogCandidate(
	join(epicenterDataRoot(), 'app-catalog'),
	resolve(candidate),
);
console.log(`Published catalog generation ${generation}:`);
for (const app of apps) {
	console.log(`  ${app.id} (${app.title})`);
}
if (apps.length === 0) console.log('  (no apps)');
console.log('It takes effect after the next full Epicenter restart.');
