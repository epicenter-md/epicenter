#!/usr/bin/env bun
/**
 * Stage Vocab as a candidate directory Epicenter can admit (ADR-0210).
 *
 * An installed app is an inert built folder holding `index.html` and a
 * `lens.json` declaring the namespace it owns. Vocab already has the Lens in
 * source, so this writes it out beside the build rather than asking anyone to
 * keep a second copy in sync by hand.
 *
 * The candidate's inner directory name means nothing: the id is the declared
 * namespace. It is named after it here only so a person reading the staged
 * folder recognizes what is in it.
 *
 * Usage:
 *   bun run build:epicenter          # then publish the printed path
 */

import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vocabLens } from '../vocab.ts';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const built = join(app, 'build');
const candidate = join(app, 'dist-epicenter');
const member = join(candidate, vocabLens.namespace);

if (!(await Bun.file(join(built, 'index.html')).exists())) {
	console.error(
		`No build at ${built}. Run \`bun run --cwd apps/vocab build\` first.`,
	);
	process.exit(1);
}

await rm(candidate, { recursive: true, force: true });
await mkdir(member, { recursive: true });
await cp(built, member, { recursive: true });

// The title is the app's, not the Lens module's: a Lens in source is written
// for the application that binds it, and the name is only needed once it is
// something a host lists.
await Bun.write(
	join(member, 'lens.json'),
	`${JSON.stringify({ ...vocabLens, title: 'Vocab' }, null, '\t')}\n`,
);

console.log(`Candidate staged at ${candidate}`);
console.log(`  ${vocabLens.namespace} (Vocab)`);
console.log('\nAdmit it with `bun run install:vocab` from the repo root, or:');
// An absolute path, because `catalog:publish` runs with `--cwd apps/epicenter`
// and would resolve a relative one against that directory instead of yours.
console.log(
	`  bun run --cwd apps/epicenter catalog:publish ${candidate}\n\nThen quit Epicenter completely and start it again.`,
);
