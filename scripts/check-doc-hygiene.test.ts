/**
 * Doc-hygiene gate tests.
 *
 * The gate's smell #2 (orphaned / stale Proposed ADR) never fires on the real
 * repo, because every ADR so far was born Accepted. That makes it the part most
 * likely to rot unnoticed: ~40% of the script, zero live exercise. These tests
 * drive the script end-to-end against throwaway git repos so both smells, and
 * the Proposed-ADR forward guard in particular, stay honest.
 *
 * The script reads everything relative to its process cwd (`git ls-files`,
 * `git log`, relative `readFileSync`), so spawning it with `cwd` set to a
 * fixture repo exercises the real code path with no refactor.
 */

import { expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(
	new URL('./check-doc-hygiene.ts', import.meta.url),
);

function git(cwd: string, args: string[], date?: string): void {
	execFileSync('git', args, {
		cwd,
		stdio: 'pipe',
		env: date
			? { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
			: process.env,
	});
}

/** Fresh git repo with the docs/adr + specs skeleton the gate expects. */
function makeRepo(): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), 'doc-hygiene-'));
	git(dir, ['init', '-q', '-b', 'main']);
	git(dir, ['config', 'user.email', 'fixture@test.local']);
	git(dir, ['config', 'user.name', 'Fixture']);
	git(dir, ['config', 'commit.gpgsign', 'false']);
	mkdirSync(path.join(dir, 'docs/adr'), { recursive: true });
	mkdirSync(path.join(dir, 'specs'), { recursive: true });
	return dir;
}

function write(dir: string, rel: string, body: string): void {
	writeFileSync(path.join(dir, rel), body);
}

/** Commit everything; `date` backdates the commit (used to age an ADR). */
function commitAll(dir: string, date?: string): void {
	git(dir, ['add', '-A']);
	git(dir, ['commit', '-q', '-m', 'fixture'], date);
}

function run(dir: string): { code: number | null; out: string } {
	const r = spawnSync('bun', [scriptPath], { cwd: dir, encoding: 'utf8' });
	return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function withRepo(fn: (dir: string) => void): void {
	const dir = makeRepo();
	try {
		fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test('clean repo (Draft spec, no ADRs) passes', () => {
	withRepo((dir) => {
		write(dir, 'specs/20260101T000000-x.md', '# X\n\n**Status**: Draft\n');
		commitAll(dir);
		const { code, out } = run(dir);
		expect(code).toBe(0);
		expect(out).toContain('clean');
	});
});

test('smell 1: a terminal-status spec is flagged', () => {
	withRepo((dir) => {
		write(
			dir,
			'specs/20260101T000000-x.md',
			'# X\n\n**Status**: Implemented\n',
		);
		commitAll(dir);
		const { code, out } = run(dir);
		expect(code).toBe(1);
		expect(out).toContain('SPEC TERMINAL STATUS');
	});
});

test('smell 1: a blockquoted terminal-status spec is flagged', () => {
	withRepo((dir) => {
		write(
			dir,
			'specs/20260101T000000-x.md',
			'# X\n\n> **Status: Superseded** by ADR-0001\n',
		);
		commitAll(dir);
		const { code, out } = run(dir);
		expect(code).toBe(1);
		expect(out).toContain('SPEC TERMINAL STATUS');
	});
});

test('smell 2: an old Proposed ADR nothing depends on is clean', () => {
	withRepo((dir) => {
		write(
			dir,
			'docs/adr/0001-some-decision.md',
			'# 0001. Some decision\n\n- **Status:** Proposed\n- **Unbuilt:** all of it\n',
		);
		// Age is not a defect: Proposed is the resting state.
		commitAll(dir, '2000-01-01T00:00:00');
		const { code, out } = run(dir);
		expect(code).toBe(0);
		expect(out).toContain('clean');
	});
});

test('smell 2: a Proposed ADR another ADR reasons from is flagged', () => {
	withRepo((dir) => {
		write(
			dir,
			'docs/adr/0001-some-decision.md',
			'# 0001. Some decision\n\n- **Status:** Proposed\n- **Unbuilt:** all of it\n',
		);
		write(
			dir,
			'docs/adr/0002-another-decision.md',
			'# 0002. Another decision\n\n- **Status:** Accepted\n\nFollows from ADR-0001.\n',
		);
		commitAll(dir);
		const { code, out } = run(dir);
		expect(code).toBe(1);
		expect(out).toContain('ADR PROPOSED, DEPENDED ON');
		expect(out).toContain('0002 reason from it');
	});
});

test('smell 2: a Proposed ADR with no Unbuilt line is flagged', () => {
	withRepo((dir) => {
		write(
			dir,
			'docs/adr/0001-some-decision.md',
			'# 0001. Some decision\n\n- **Status:** Proposed\n',
		);
		commitAll(dir);
		const { code, out } = run(dir);
		expect(code).toBe(1);
		expect(out).toContain('no `Unbuilt:` line');
	});
});
