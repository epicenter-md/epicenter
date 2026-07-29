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
 * - Push, pull request creation, and merge are denied on every start and every
 *   resume, and no argument reaches a launch that grants them
 * - `reply` refuses a working job unless the interruption is deliberate
 * - `CLAUDECODE=1` refuses reciprocal delegation
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	classifyAgent,
	findAgent,
	findLaunchedByName,
	NO_PUBLICATION_PROMPT,
	PUBLICATION_DENY_RULES,
	parseBackgroundId,
	parseReplyArgs,
	parseStartArgs,
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

describe('parseStartArgs', () => {
	test('takes a name and generates one otherwise', () => {
		expect(parseStartArgs(['--name', 'x'])).toEqual({ name: 'x' });
		expect(parseStartArgs([])?.name).toMatch(/^codex-delegate-/);
	});

	test('rejects unknown or malformed flags', () => {
		expect(parseStartArgs(['--name'])).toBeUndefined();
		expect(parseStartArgs(['fixture'])).toBeUndefined();
		expect(parseStartArgs(['--name', 'a', '--name', 'b'])).toBeUndefined();
		expect(parseStartArgs(['--name', '--something'])).toBeUndefined();
	});

	test('offers no argument that widens publication authority', () => {
		// A supervisor reaching for authority gets a usage error, never a launch
		// that quietly granted nothing or, worse, quietly granted something.
		for (const flag of [
			'--allow-external-writes',
			'--allow-push',
			'--allow-pr-create',
			'--allow-pr-merge',
			'--dangerously-skip-permissions',
		]) {
			expect(parseStartArgs([flag])).toBeUndefined();
			expect(parseStartArgs(['--name', 'x', flag])).toBeUndefined();
		}
	});
});

describe('parseReplyArgs', () => {
	test('requires an ID and defaults the interruption off', () => {
		expect(parseReplyArgs(['7c5dcf5d'])).toEqual({
			id: '7c5dcf5d',
			interrupt: false,
		});
		expect(parseReplyArgs(['7c5dcf5d', '--interrupt'])?.interrupt).toBe(true);
		expect(parseReplyArgs([])).toBeUndefined();
		expect(parseReplyArgs(['--interrupt'])).toBeUndefined();
	});

	test('rejects anything that is not the interruption flag', () => {
		expect(parseReplyArgs(['7c5dcf5d', '--yolo'])).toBeUndefined();
		expect(
			parseReplyArgs(['7c5dcf5d', '--allow-external-writes']),
		).toBeUndefined();
		expect(parseReplyArgs(['7c5dcf5d', '--allow-pr-create'])).toBeUndefined();
	});
});

describe('command lifecycle', () => {
	test('starts, finds, watches, and reads one supervisor job', () => {
		const fixtureDirectory = mkdtempSync(join(tmpdir(), 'delegate-claude-'));
		const fakeClaude = join(fixtureDirectory, 'claude-fixture.ts');
		const argsLog = join(fixtureDirectory, 'args.jsonl');
		writeFileSync(
			fakeClaude,
			`#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(argsLog)}, JSON.stringify(args) + '\\n');
if (args[0] === '--bg' && args.includes('--resume')) {
  console.log('backgrounded · a5b4a85d');
} else if (args[0] === '--bg') {
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

		/** Every `claude` invocation the launcher made, oldest first. */
		const launches = () =>
			readFileSync(argsLog, 'utf8')
				.split('\n')
				.filter(Boolean)
				.map((line) => JSON.parse(line) as string[]);
		/** `back(0)` is the newest invocation, `back(1)` the one before it. */
		const back = (offset: number) => {
			const all = launches();
			return all[all.length - 1 - offset];
		};
		const lastLaunch = () => back(0);
		const finalArg = (args: string[]) => args[args.length - 1];

		/**
		 * `--disallowed-tools` is variadic, so an argument that is not a flag
		 * immediately after the rule list would be eaten as another rule.
		 */
		const expectPublicationDenied = (args: string[]) => {
			const deny = args.indexOf('--disallowed-tools');
			expect(deny).toBeGreaterThanOrEqual(0);
			expect(args[deny + 1]).toBe(PUBLICATION_DENY_RULES);
			expect(args[deny + 2]?.startsWith('--')).toBe(true);
			const guard = args.indexOf('--append-system-prompt');
			expect(args[guard + 1]).toBe(NO_PUBLICATION_PROMPT);
		};

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
			const startArgs = lastLaunch();
			expect(startArgs).toContain('--bg');
			expect(startArgs).not.toContain('--model');
			for (const flag of ['--effort', 'high', '--permission-mode', 'auto'])
				expect(startArgs).toContain(flag);
			expect(finalArg(startArgs)).toBe('Mission: fixture');
			expectPublicationDenied(startArgs);

			// The flag that used to widen authority now fails the launch outright
			// rather than reaching `claude` as an unguarded start.
			const launchCount = launches().length;
			const refused = spawnSync(
				'bun',
				[cli, 'start', '--name', 'fixture', '--allow-external-writes'],
				{ encoding: 'utf8', env: environment, input: 'Mission: fixture' },
			);
			expect(refused.status).toBe(2);
			expect(launches().length).toBe(launchCount);

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
			const resumeArgs = lastLaunch();
			expect(resumeArgs).toContain('--resume');
			expect(resumeArgs).toContain(baseAgent.sessionId);
			expect(finalArg(resumeArgs)).toBe('pear');
			// Claude does not carry deny rules across `--resume`, so an unguarded
			// resume would silently restore publication for the rest of the
			// conversation. The reply reapplies the guard every time.
			expectPublicationDenied(resumeArgs);

			const busy = spawnSync('bun', [cli, 'reply', '7c5dcf5d'], {
				encoding: 'utf8',
				env: { ...environment, FIXTURE_STATE: 'working' },
				input: 'pear',
			});
			expect(busy.status).toBe(2);
			expect(busy.stderr).toContain('still working');
			expect(lastLaunch()).toContain('agents');

			const interrupted = spawnSync(
				'bun',
				[cli, 'reply', '7c5dcf5d', '--interrupt'],
				{
					encoding: 'utf8',
					env: { ...environment, FIXTURE_STATE: 'working' },
					input: 'pear',
				},
			);
			expect(interrupted.status).toBe(0);
			expect(interrupted.stdout).toContain('DELEGATE_CLAUDE_JOB_ID=a5b4a85d');
			expect(back(1)[0]).toBe('stop');
			// Interrupting a live turn is a supervision decision, not a widening
			// of what the resumed session may do.
			expectPublicationDenied(lastLaunch());

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
