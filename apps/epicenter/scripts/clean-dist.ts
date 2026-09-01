#!/usr/bin/env bun
/**
 * Remove generated trusted-SPA assets before composing a fresh desktop build.
 *
 * The list is derived, not written down twice. It was written down twice, and
 * drifted: it still named `query`, a directory no build has produced since Home
 * was renamed, and it never named `home`, so the one document the host serves
 * from its own build survived every clean.
 */

import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { COMPILED_APPLICATIONS } from '../src/applications.ts';

const dist = join(import.meta.dir, '..', 'dist');
const generated = ['home', ...COMPILED_APPLICATIONS.map(({ id }) => id)];
await Promise.all(
	generated.map((directory) =>
		rm(join(dist, directory), { recursive: true, force: true }),
	),
);
