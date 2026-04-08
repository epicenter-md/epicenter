#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const isBun = typeof Bun !== 'undefined';

if (!isBun) {
	const bunCheck = spawnSync('bun', ['--version'], { stdio: 'ignore' });

	if (bunCheck.status === 0) {
		const result = spawnSync(
			'bun',
			[fileURLToPath(import.meta.url), ...process.argv.slice(2)],
			{ stdio: 'inherit' },
		);
		process.exit(result.status ?? 1);
	}

	console.error(`Epicenter CLI requires Bun.

Install it:

  curl -fsSL https://bun.sh/install | bash

Then run this command again. Learn more: https://bun.sh`);
	process.exit(1);
}

await import('../src/bin.ts');
