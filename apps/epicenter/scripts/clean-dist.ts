#!/usr/bin/env bun
/** Remove generated trusted-SPA assets before composing a fresh desktop build. */

import { rm } from 'node:fs/promises';
import { join } from 'node:path';

const dist = join(import.meta.dir, '..', 'dist');
await Promise.all(
	['query', 'whispering'].map((application) =>
		rm(join(dist, application), { recursive: true, force: true }),
	),
);
