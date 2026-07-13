/**
 * Consult Claude runner tests.
 *
 * Verifies the fixed read-only invocation, normalized output, process cleanup,
 * nesting protection, and environment isolation around the Claude CLI.
 */
import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { buildClaudeArgs, buildClaudeEnvironment } from './consult-claude.ts';

const scriptPath = fileURLToPath(new URL('./consult-claude.ts', import.meta.url));

function setup() {
	const cwd = mkdtempSync(path.join(os.tmpdir(), 'consult-claude-test-'));
	const binDirectory = path.join(cwd, 'bin');
	const claudePath = path.join(binDirectory, 'claude');
	mkdirSync(binDirectory, { recursive: true });
	writeFileSync(
		claudePath,
		`#!/usr/bin/env bun
import { writeFileSync } from 'node:fs';

const prompt = await new Response(Bun.stdin.stream()).text();
writeFileSync('args.json', JSON.stringify(Bun.argv.slice(2)));
writeFileSync('prompt.txt', prompt);
writeFileSync('secret.txt', process.env.SECRET_SENTINEL ?? 'missing');

if (prompt.includes('WAIT_FOR_TIMEOUT')) {
  process.on('SIGTERM', () => {
    writeFileSync('terminated.txt', 'yes');
    process.exit(0);
  });
  await new Promise(() => {});
}

if (prompt.includes('MALFORMED')) {
  console.log('not json');
  process.exit(0);
}

if (prompt.includes('EXIT_NONZERO')) {
  console.error('fake claude failed');
  process.exit(23);
}

console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fake-session' }));
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'thinking' }] } }));
console.log(JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'FAKE RESULT',
  session_id: 'fake-session',
  total_cost_usd: 0.01,
  duration_ms: 42,
  num_turns: 1,
  modelUsage: { fake: { inputTokens: 1, outputTokens: 1 } },
  permission_denials: [],
  terminal_reason: 'completed',
  stop_reason: 'end_turn'
}));
`,
		'utf8',
	);
	chmodSync(claudePath, 0o755);

	return {
		cwd,
		run(prompt: string, extraEnvironment: Record<string, string> = {}) {
			return spawnSync(Bun.argv[0] ?? 'bun', [scriptPath], {
				cwd,
				encoding: 'utf8',
				input: prompt,
				env: {
					...process.env,
					PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ''}`,
					SECRET_SENTINEL: 'must-not-reach-claude',
					...extraEnvironment,
				},
			});
		},
	};
}

function parseOutput(output: string) {
	return JSON.parse(output) as {
		status: string;
		result: string | null;
		error: string | null;
		session_id: string | null;
		total_cost_usd: number | null;
		runner: { last_event: string };
	};
}

test('uses one fixed read-only Claude invocation and returns normalized metadata', () => {
	const context = setup();
	const result = context.run('A decision-complete consult brief.');

	expect(result.status).toBe(0);
	const output = parseOutput(String(result.stdout));
	expect(output.status).toBe('completed');
	expect(output.result).toBe('FAKE RESULT');
	expect(output.session_id).toBe('fake-session');
	expect(output.total_cost_usd).toBe(0.01);
	expect(output.runner.last_event).toBe('result:success');
	expect(JSON.parse(readFileSync(path.join(context.cwd, 'args.json'), 'utf8'))).toEqual(buildClaudeArgs());
	expect(readFileSync(path.join(context.cwd, 'prompt.txt'), 'utf8')).toBe('A decision-complete consult brief.');
	expect(readFileSync(path.join(context.cwd, 'secret.txt'), 'utf8')).toBe('missing');
});

test('fails closed on malformed Claude output', () => {
	const context = setup();
	const result = context.run('MALFORMED');

	expect(result.status).toBe(70);
	const output = parseOutput(String(result.stdout));
	expect(output.status).toBe('failed');
	expect(output.error).toContain('non-JSON');
});

test('surfaces Claude process failures', () => {
	const context = setup();
	const result = context.run('EXIT_NONZERO');

	expect(result.status).toBe(1);
	const output = parseOutput(String(result.stdout));
	expect(output.status).toBe('failed');
	expect(output.error).toContain('fake claude failed');
});

test('terminates the Claude process group at the hard timeout', () => {
	const context = setup();
	const result = context.run('WAIT_FOR_TIMEOUT', {
		CONSULT_CLAUDE_TIMEOUT_MS: '500',
	});

	expect(result.status).toBe(124);
	const output = parseOutput(String(result.stdout));
	expect(output.status).toBe('timed_out');
	expect(existsSync(path.join(context.cwd, 'terminated.txt'))).toBe(true);
});

test('refuses to bypass Claude Code nesting protection', () => {
	const context = setup();
	const result = context.run('Do not run.', { CLAUDECODE: '1' });

	expect(result.status).toBe(64);
	const output = parseOutput(String(result.stdout));
	expect(output.status).toBe('failed');
	expect(output.error).toContain('CLAUDECODE=1');
	expect(existsSync(path.join(context.cwd, 'args.json'))).toBe(false);
});

test('inherits only the environment needed by Claude', () => {
	const environment = buildClaudeEnvironment({
		PATH: '/bin',
		HOME: '/tmp/home',
		ANTHROPIC_API_KEY: 'allowed',
		SECRET_SENTINEL: 'blocked',
		CODEX_HOME: '/tmp/codex',
	});

	expect(environment).toEqual({
		HOME: '/tmp/home',
		PATH: '/bin',
		ANTHROPIC_API_KEY: 'allowed',
	});
});
