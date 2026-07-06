import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Drift guard for `.env.example`: Local Mail's BYO path documents exactly the
 * single Gmail OAuth Desktop client pair it reads at connect and refresh time.
 */

/** Extract the `NAME=` variable names from `.env.example`-style lines. */
function envNames(lines: string[]): string[] {
	return lines
		.filter((line) => /^[A-Z0-9_]+=/.test(line))
		.map((line) => line.slice(0, line.indexOf('=')));
}

test('.env.example lists exactly the BYO Gmail OAuth keyset', () => {
	const file = readFileSync(
		join(import.meta.dir, '..', '.env.example'),
		'utf8',
	);
	const documented = envNames(file.split('\n'));

	expect(documented).toEqual(['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET']);
});
