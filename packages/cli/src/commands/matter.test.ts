/**
 * `epicenter matter check` command tests, spawning the real binary against fixtures and the bundled
 * example vault. These pin the command contract, not the engine internals (`@epicenter/matter-core`
 * has its own unit tests): the marker-based scope (ADR-0029), exit codes, the un-evaluable-reference
 * note for a lone table, the `--json` shape, and the fatal tiers.
 *
 *   - exit 0  every loaded row is healthy (an untyped `{}` folder counts; a path that is not a table
 *             and has no marked children is "no tables", not a failure; references un-evaluable in
 *             isolation are a note, not a failure)
 *   - exit 1  a loaded row needs attention, or a cross-table reference does not resolve
 *   - exit 2  a folder or Markdown file is unreadable, or a matter.json is a corrupt contract
 */

import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// The CLI package root: `bun src/bin.ts` runs from here, fixture paths resolve against it, and the
// example vault sits two levels up at the repo's `examples/` (same depth the old app test used).
const cliRoot = resolve(import.meta.dir, '../..');
const fixtureRoot = 'fixtures/matter-check';
const exampleVault = '../../examples/matter/content-vault';

type CommandResult = { exitCode: number; stdout: string; stderr: string };

async function runCheck(args: string[]): Promise<CommandResult> {
	const proc = Bun.spawn(['bun', 'src/bin.ts', 'matter', 'check', ...args], {
		cwd: cliRoot,
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, stdout, stderr };
}

describe('matter check: single-table scope', () => {
	test('exit 0 prints the ready roll-up for a passing folder', async () => {
		const result = await runCheck([`${fixtureRoot}/pass`]);
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe('');
		expect(result.stdout).toBe('2 ready (1 table, 2 rows)\n');
	});

	test('exit 2 groups findings and unreadable files for the mixed fixture', async () => {
		const result = await runCheck([`${fixtureRoot}/mixed`]);
		expect(result.exitCode).toBe(2);
		expect(result.stdout).toContain('needs value');
		expect(result.stdout).toContain('invalid: got "five", expected integer');
		expect(result.stdout).toContain(
			'invalid: got "idea", expected one of draft, ready, published',
		);
		expect(result.stdout).toContain('mixed/broken-yaml.md');
		expect(result.stdout).toContain('1 unreadable file');
	});

	test('exit 0 treats an untyped folder (a {} marker) as valid', async () => {
		const result = await runCheck([`${fixtureRoot}/missing-model`]);
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe('');
		expect(result.stdout).toContain('untyped');
	});

	test('exit 0 with no tables when the path is not a table and has no marked children', async () => {
		// A folder with no matter.json and no marked children is not a table (ADR-0029): there is
		// nothing to check, so it is "no tables here", not an untyped pass.
		const result = await runCheck([`${fixtureRoot}/not-a-table`]);
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe('');
		expect(result.stdout).toContain('0 tables');
		expect(result.stdout).not.toContain('untyped');
	});

	test('exit 0 notes references as un-evaluable when checking one table', async () => {
		const result = await runCheck([`${exampleVault}/adaptations`]);
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe('');
		expect(result.stdout).toContain('references not checked');
		expect(result.stdout).toContain('page -> pages');
	});
});

describe('matter check: vault scope', () => {
	test('exit 1 resolves references across the example vault and reports the dangling ones', async () => {
		const result = await runCheck([exampleVault]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toBe('');
		// Both deliberately-dangling rows, caught by cross-table resolution.
		expect(result.stdout).toContain('dangling');
		expect(result.stdout).toContain('ghost-page');
		expect(result.stdout).toContain('deleted-adaptation');
		// Every target table is present, so nothing is missing-target here.
		expect(result.stdout).not.toContain('references not checked');
	});

	test('--json carries the serialized violations and summary', async () => {
		const result = await runCheck(['--json', exampleVault]);
		const report = JSON.parse(result.stdout);
		expect(result.exitCode).toBe(1);
		expect(
			report.violations.every(
				(v: { kind: string }) => v.kind === 'dangling-reference',
			),
		).toBe(true);
		expect(report.violations).toHaveLength(2);
		expect(report.summary.totals.tables).toBe(3);
	});

	test('--json computes the expected value for an invalid-type violation', async () => {
		const result = await runCheck(['--json', `${fixtureRoot}/mixed`]);
		const report = JSON.parse(result.stdout);
		const invalid = report.violations.find(
			(v: { kind: string; field: string }) =>
				v.kind === 'invalid-type' && v.field === 'duration',
		);
		expect(invalid).toMatchObject({
			kind: 'invalid-type',
			field: 'duration',
			raw: 'five',
			expected: { kind: 'integer' },
		});
	});
});

describe('matter check: fatal tiers', () => {
	test('exit 2 names a Markdown file that cannot become a row', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'matter-check-'));
		try {
			await writeFile(
				join(dir, 'matter.json'),
				JSON.stringify({ fields: { title: { type: 'string' } } }),
			);
			await writeFile(join(dir, 'ready.md'), '---\ntitle: Ready\n---');
			await writeFile(join(dir, 'broken.md'), '---\ntitle: [bad\n---');

			const text = await runCheck([dir]);
			expect(text.exitCode).toBe(2);
			expect(text.stdout).toContain('broken.md');
			expect(text.stdout).toContain('1 unreadable file');
			expect(text.stdout).toContain('(1 table, 1 row)');

			const json = await runCheck(['--json', dir]);
			const report = JSON.parse(json.stdout);
			expect(json.exitCode).toBe(2);
			expect(report.summary.unreadableFiles).toEqual([
				expect.objectContaining({
					fileName: 'broken.md',
					message: expect.stringContaining('Frontmatter is not valid YAML'),
				}),
			]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test('exit 2 for a corrupt matter.json', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'matter-check-'));
		try {
			await writeFile(join(dir, 'matter.json'), '{ not json\n');
			await writeFile(join(dir, 'ready.md'), '---\ntitle: X\n---');

			const result = await runCheck([dir]);
			expect(result.exitCode).toBe(2);
			expect(result.stdout).toContain('invalid contract');
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test('exit 2 for a folder that cannot be read', async () => {
		const result = await runCheck(['./does-not-exist-xyz']);
		expect(result.exitCode).toBe(2);
		expect(result.stdout).toContain("can't read");
	});

	test('a usage error on an unknown option is rejected by yargs', async () => {
		// Usage errors are now yargs' domain (the command parses with `.strict()`), not the engine's
		// exit ladder: an unknown flag fails the parse, bin.ts catches it and exits 1.
		const result = await runCheck(['--bogus']);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain('Unknown argument: bogus');
	});
});
