/**
 * Routing collision contract tests.
 *
 * `references/composition-audit.md` documents this script's exit codes and its
 * `phrase -> skill/SKILL.md` line format, so both are contract rather than
 * implementation. These tests exist so the shared-catalog extraction and the
 * `--explain` flag cannot drift them.
 *
 * The two content-coupled assertions are deliberate. "asymmetric wins" having
 * exactly one owner and "simplify this" being disclaimed by control-flow are
 * the two routing facts the composition audit is built around; if a
 * description edit changes either, a failing test here is the report, not
 * noise.
 */

import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(
	new URL('./audit-routing-collisions.ts', import.meta.url),
);

function run(...args: string[]): {
	code: number | null;
	out: string;
	err: string;
} {
	const result = spawnSync('bun', [scriptPath, ...args], { encoding: 'utf8' });
	return { code: result.status, out: result.stdout, err: result.stderr };
}

test('no phrase is a usage error', () => {
	const { code, err } = run();

	expect(code).toBe(2);
	expect(err).toContain('Usage:');
});

test('--help prints usage and succeeds', () => {
	const { code, out } = run('--help');

	expect(code).toBe(0);
	expect(out).toContain('--explain');
});

test('a phrase no description mentions exits 1 with no owner', () => {
	const { code, out, err } = run('zzz-no-skill-claims-this');

	expect(code).toBe(1);
	expect(out).toBe('');
	expect(err).toContain('No skill description claims');
});

test('a single owner exits 0 in the documented line format', () => {
	const { code, out } = run('asymmetric wins');

	expect(code).toBe(0);
	expect(out).toBe('asymmetric wins -> asymmetric-wins/SKILL.md\n');
});

test('--explain annotates without changing the line prefix or exit code', () => {
	const plain = run('asymmetric wins');
	const explained = run('--explain', 'asymmetric wins');

	expect(explained.code).toBe(plain.code);
	expect(explained.out).toBe(
		'asymmetric wins -> asymmetric-wins/SKILL.md [claims]\n',
	);
});

test('--explain separates a sole hit that routes the phrase away', () => {
	// One hit still exits 0, matching the documented verdict. The annotation is
	// what tells the reader the phrase has no real owner.
	const { code, out } = run('--explain', 'simplify this');

	expect(code).toBe(0);
	expect(out).toContain('control-flow/SKILL.md [disclaims]');
});

test('multiple hits exit 1 and list every claimant', () => {
	const { code, out, err } = run('delete disproportionate complexity');

	expect(code).toBe(1);
	expect(out).toContain('asymmetric-wins/SKILL.md');
	expect(out).toContain('greenfield-clean-breaks/SKILL.md');
	expect(err).toContain('Routing collision');
});
