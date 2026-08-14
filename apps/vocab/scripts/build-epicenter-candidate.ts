#!/usr/bin/env bun
/**
 * Stage Vocab as a candidate directory Epicenter can admit (ADR-0210).
 *
 * An installed app is an inert built folder holding `index.html` and a
 * `workspace.json` declaring the namespace it owns. Vocab already has the workspace in
 * source, so this writes it out beside the build rather than asking anyone to
 * keep a second copy in sync by hand.
 *
 * The candidate's inner directory name means nothing: the id is the declared
 * namespace. It is named after it here only so a person reading the staged
 * folder recognizes what is in it.
 *
 * This runs the build itself rather than expecting one to be sitting there. A
 * build headed for Epicenter has to carry `/apps/<namespace>/` in its own asset
 * URLs, and the namespace is declared in the workspace, so the one step that knows
 * the namespace is the one that must set the prefix. Staging a build made
 * without it produces a folder that admits cleanly and then shows a blank
 * window, which is a failure worth making unreachable rather than documenting.
 *
 * Usage:
 *   bun run build:epicenter          # then publish the printed path
 */

import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vocabWorkspace } from '../vocab.ts';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const built = join(app, 'build');
const candidate = join(app, 'dist-epicenter');
const member = join(candidate, vocabWorkspace.namespace);
const base = `/apps/${vocabWorkspace.namespace}`;

const build = Bun.spawnSync(['bun', 'run', 'build'], {
	cwd: app,
	env: { ...process.env, EPICENTER_APP_BASE: base },
	stdio: ['inherit', 'inherit', 'inherit'],
});
if (!build.success) process.exit(build.exitCode ?? 1);

if (!(await Bun.file(join(built, 'index.html')).exists())) {
	console.error(`Build reported success but wrote no index.html to ${built}.`);
	process.exit(1);
}

await rm(candidate, { recursive: true, force: true });
await mkdir(member, { recursive: true });
await cp(built, member, { recursive: true });

// The title is the app's, not the workspace module's: a declaration in source is written
// for the application that binds it, and the name is only needed once it is
// something a host lists.
await Bun.write(
	join(member, 'workspace.json'),
	`${JSON.stringify({ ...vocabWorkspace, title: 'Vocab' }, null, '\t')}\n`,
);

console.log(`Candidate staged at ${candidate}`);
console.log(`  ${vocabWorkspace.namespace} (Vocab)`);
console.log('\nAdmit it with `bun run install:vocab` from the repo root, or:');
// An absolute path, because `catalog:publish` runs with `--cwd apps/epicenter`
// and would resolve a relative one against that directory instead of yours.
console.log(
	`  bun run --cwd apps/epicenter catalog:publish ${candidate}\n\nThen quit Epicenter completely and start it again.`,
);
