/**
 * delegate-claude Launcher Tests
 *
 * Verifies the pure launch/lookup/classification functions and the complete
 * start/watch lifecycle against a fake `claude` binary, without launching a
 * real background session.
 *
 * Key behaviors:
 * - Launch-line parsing survives ANSI color and falls back to a roster lookup
 *   by chosen name when the research-preview line changes shape
 * - Short and full session IDs resolve to the same agent record
 * - working/blocked/terminal states map to watcher outcomes and exit codes
 * - `reply` stops the job and resumes the same conversation as a new job
 * - `CLAUDECODE=1` refuses reciprocal delegation
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	classifyAgent,
	findAgent,
	findLaunchedByName,
	parseBackgroundId,
} from './delegate-claude';

const baseAgent = {
	id: '7c5dcf5d',
	sessionId: '7c5dcf5d-9c3d-427b-85f9-9bdecff9ccfa',
	name: 'example',
	kind: 'background' as const,
	cwd: '/repo',
	startedAt: 1,
};

describe('parseBackgroundId', () => {
	test('reads the documented background launch line', () => {
		expect(parseBackgroundId('backgrounded · 7c5dcf5d · example\n')).toBe(
			'7c5dcf5d',
		);
	});

	test('strips ANSI color around the ID', () => {
		expect(
			parseBackgroundId(
				'backgrounded · \u001B[36m7c5dcf5d\u001B[39m · example\n',
			),
		).toBe('7c5dcf5d');
	});

	test('returns undefined for unrelated output', () => {
		expect(parseBackgroundId('Starting background service…')).toBeUndefined();
	});
});

describe('findLaunchedByName', () => {
	test('returns the newest fresh background session with the chosen name', () => {
		const older = { ...baseAgent, id: 'aaaaaaaa', startedAt: 1_000 };
		const newer = { ...baseAgent, id: 'bbbbbbbb', startedAt: 2_000 };
		expect(findLaunchedByName([older, newer], 'example', 1_000)).toBe(newer);
	});

	test('ignores stale sessions and other names', () => {
		const stale = { ...baseAgent, startedAt: 1_000 };
		const otherName = { ...baseAgent, name: 'unrelated', startedAt: 50_000 };
		expect(
			findLaunchedByName([stale, otherName], 'example', 50_000),
		).toBeUndefined();
	});
});

describe('findAgent', () => {
	test('accepts short and full session IDs', () => {
		expect(findAgent([baseAgent], '7c5dcf5d')).toBe(baseAgent);
		expect(findAgent([baseAgent], baseAgent.sessionId)).toBe(baseAgent);
	});
});

describe('classifyAgent', () => {
	test('recognizes terminal outcomes', () => {
		expect(classifyAgent({ ...baseAgent, state: 'done' })).toBe('done');
		expect(classifyAgent({ ...baseAgent, state: 'failed' })).toBe('failed');
		expect(classifyAgent({ ...baseAgent, state: 'stopped' })).toBe('stopped');
	});

	test('treats every waiting shape as blocked', () => {
		expect(classifyAgent({ ...baseAgent, state: 'blocked' })).toBe('blocked');
		expect(classifyAgent({ ...baseAgent, status: 'waiting' })).toBe('blocked');
		expect(classifyAgent({ ...baseAgent, waitingFor: 'input needed' })).toBe(
			'blocked',
		);
	});

	test('defaults live sessions to working', () => {
		expect(classifyAgent({ ...baseAgent, state: 'working' })).toBe('working');
	});
});

describe('command lifecycle', () => {
	test('starts, finds, watches, and reads one supervisor job', () => {
		const fixtureDirectory = mkdtempSync(join(tmpdir(), 'delegate-claude-'));
		const fakeClaude = join(fixtureDirectory, 'claude-fixture.ts');
		writeFileSync(
			fakeClaude,
			`#!/usr/bin/env bun
const args = process.argv.slice(2);
if (args[0] === '--bg' && args[1] === '--resume') {
  if (args[2] !== '${baseAgent.sessionId}' || args[3] !== 'pear') process.exit(9);
  console.log('backgrounded · a5b4a85d');
} else if (args[0] === '--bg') {
  const required = ['--effort', 'high', '--permission-mode', 'auto', '--name', 'fixture'];
  if (args.includes('--model') || !required.every((value) => args.includes(value)) || args.at(-1) !== 'Mission: fixture') process.exit(7);
  console.log(process.env.FIXTURE_LAUNCH_LINE ?? 'backgrounded · 7c5dcf5d · fixture');
} else if (args[0] === 'stop') {
  console.log('stopped ' + args[1]);
} else if (args[0] === 'agents') {
  console.log(JSON.stringify([{
    ...${JSON.stringify(baseAgent)},
    name: process.env.FIXTURE_AGENT_NAME ?? 'example',
    startedAt: process.env.FIXTURE_AGENT_FRESH ? Date.now() : 1,
    state: process.env.FIXTURE_STATE ?? 'done',
  }]));
} else {
  process.exit(8);
}
`,
		);
		chmodSync(fakeClaude, 0o755);

		// The suite itself may run inside Claude Code; drop its recursion marker
		// so only the dedicated refusal case sets it.
		const environment: Record<string, string | undefined> = {
			...process.env,
			DELEGATE_CLAUDE_BIN: fakeClaude,
		};
		delete environment.CLAUDECODE;
		const cli = join(import.meta.dir, 'delegate-claude.ts');

		try {
			const started = spawnSync('bun', [cli, 'start', '--name', 'fixture'], {
				encoding: 'utf8',
				env: environment,
				input: 'Mission: fixture',
			});
			expect(started.status).toBe(0);
			expect(started.stdout).toContain('DELEGATE_CLAUDE_JOB_ID=7c5dcf5d');

			const recovered = spawnSync('bun', [cli, 'start', '--name', 'fixture'], {
				encoding: 'utf8',
				env: {
					...environment,
					FIXTURE_LAUNCH_LINE: 'Session dispatched.',
					FIXTURE_AGENT_NAME: 'fixture',
					FIXTURE_AGENT_FRESH: '1',
				},
				input: 'Mission: fixture',
			});
			expect(recovered.status).toBe(0);
			expect(recovered.stdout).toContain('DELEGATE_CLAUDE_JOB_ID=7c5dcf5d');

			const watched = spawnSync('bun', [cli, 'watch', '7c5dcf5d'], {
				encoding: 'utf8',
				env: environment,
			});
			expect(watched.status).toBe(0);
			expect(watched.stderr).toContain('7c5dcf5d: done');

			const blocked = spawnSync('bun', [cli, 'watch', '7c5dcf5d'], {
				encoding: 'utf8',
				env: { ...environment, FIXTURE_STATE: 'blocked' },
			});
			expect(blocked.status).toBe(10);
			expect(blocked.stderr).toContain('7c5dcf5d: blocked');

			const replied = spawnSync('bun', [cli, 'reply', '7c5dcf5d'], {
				encoding: 'utf8',
				env: { ...environment, FIXTURE_STATE: 'blocked' },
				input: 'pear',
			});
			expect(replied.status).toBe(0);
			expect(replied.stdout).toContain('DELEGATE_CLAUDE_JOB_ID=a5b4a85d');

			const nested = spawnSync('bun', [cli, 'start'], {
				encoding: 'utf8',
				env: { ...environment, CLAUDECODE: '1' },
				input: 'Mission: fixture',
			});
			expect(nested.status).toBe(2);
			expect(nested.stderr).toContain('Refusing reciprocal');
		} finally {
			rmSync(fixtureDirectory, { recursive: true, force: true });
		}
	});
});
