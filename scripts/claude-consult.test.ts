/**
 * Claude Consult Wrapper Tests
 *
 * These tests run the consult wrapper against a fake `claude` binary. They
 * verify the process boundary and job-state behavior without requiring a real
 * Claude login or spending model quota.
 *
 * Key behaviors:
 * - Sync consults invoke Claude with read-only safety flags and return the final result
 * - Background consults use stream-json with `--verbose` and persist status/result state
 * - Prompt construction includes supplied context and the bounded-consult contract
 */

import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPrompt } from './claude-consult.ts';

const scriptPath = fileURLToPath(
	new URL('./claude-consult.ts', import.meta.url),
);

type Setup = {
	cwd: string;
	run(args: string[]): ReturnType<typeof spawnSync>;
	readClaudeArgs(): string[];
};

function setup(): Setup {
	const cwd = mkdtempSync(path.join(os.tmpdir(), 'claude-consult-test-'));
	const binDir = path.join(cwd, 'bin');
	const fakeClaudePath = path.join(binDir, 'claude');
	const fakeClaudeSource = `#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('.fake-claude', { recursive: true });
const args = Bun.argv.slice(2);
writeFileSync('.fake-claude/args.json', JSON.stringify(args, null, 2));
const formatIndex = args.indexOf('--output-format');
const format = formatIndex === -1 ? '' : args[formatIndex + 1];
const promptIndex = args.indexOf('-p');
const prompt = promptIndex === -1 ? '' : args[promptIndex + 1];
if (prompt.includes('WAIT_FOR_CANCEL')) {
	process.on('SIGTERM', () => {
		writeFileSync('.fake-claude/terminated', 'yes');
		process.exit(0);
	});
	setInterval(() => {}, 1000);
	await new Promise(() => {});
}
if (format === 'stream-json') {
	if (!args.includes('--verbose')) {
		console.error('stream-json requires --verbose');
		process.exit(70);
	}
	console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fake-session' }));
	console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'BACKGROUND OK', session_id: 'fake-session', total_cost_usd: 0.01, duration_ms: 42 }));
	process.exit(0);
}
console.log(JSON.stringify({ is_error: false, result: 'SYNC OK' }));
`;

	mkdirSync(binDir, { recursive: true });
	writeFileSync(fakeClaudePath, fakeClaudeSource, 'utf8');
	chmodSync(fakeClaudePath, 0o755);

	return {
		cwd,
		run(args) {
			return spawnSync(Bun.argv[0] ?? 'bun', [scriptPath, ...args], {
				cwd,
				encoding: 'utf8',
				env: {
					...process.env,
					PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
				},
			});
		},
		readClaudeArgs() {
			return JSON.parse(
				readFileSync(path.join(cwd, '.fake-claude/args.json'), 'utf8'),
			) as string[];
		},
	};
}

function expectCommandSuccess(result: ReturnType<typeof spawnSync>) {
	expect(result.error).toBeUndefined();
	expect(result.status).toBe(0);
}

function expectArgValue(args: string[], flag: string, value: string) {
	const index = args.indexOf(flag);
	expect(index).toBeGreaterThanOrEqual(0);
	expect(args[index + 1]).toBe(value);
}

function waitForCompletedJob(setup: Setup, jobId: string) {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		const status = setup.run(['status', jobId]);
		expectCommandSuccess(status);
		const stdout = String(status.stdout);
		if (stdout.includes('Status: completed')) return stdout;
		Bun.sleepSync(25);
	}
	throw new Error(`Timed out waiting for ${jobId}`);
}

function waitForStatus(setup: Setup, jobId: string, expected: string) {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		const status = setup.run(['status', jobId]);
		expectCommandSuccess(status);
		const stdout = String(status.stdout);
		if (stdout.includes(`Status: ${expected}`)) return stdout;
		Bun.sleepSync(25);
	}
	throw new Error(`Timed out waiting for ${jobId} to become ${expected}`);
}

function waitForPath(filePath: string) {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		if (existsSync(filePath)) return;
		Bun.sleepSync(25);
	}
	throw new Error(`Timed out waiting for ${filePath}`);
}

test('sync consult invokes Claude with read-only safety flags and returns the result', () => {
	const context = setup();
	const result = context.run([
		'--question',
		'Give the final answer.',
		'--budget-usd',
		'5',
	]);

	expectCommandSuccess(result);
	expect(String(result.stdout).trim()).toBe('SYNC OK');

	const args = context.readClaudeArgs();
	expectArgValue(args, '--output-format', 'json');
	expectArgValue(args, '--max-budget-usd', '5');
	expectArgValue(args, '--permission-mode', 'dontAsk');
	expectArgValue(args, '--disallowedTools', 'Edit,Write,Bash');
	expectArgValue(args, '--tools', '');
	expect(args).toContain('--no-session-persistence');
	expect(args).toContain('--disable-slash-commands');
});

test('background consult stores streamed result and exposes it through status/result', () => {
	const context = setup();
	const start = context.run([
		'start',
		'--question',
		'Give the final answer.',
		'--budget-usd',
		'5',
	]);

	expectCommandSuccess(start);
	const jobId = String(start.stdout).match(/claude-[a-f0-9]+/)?.[0];
	expect(jobId).toBeTruthy();

	const status = waitForCompletedJob(context, jobId as string);
	expect(status).toContain('Status: completed');
	expect(status).toContain('Claude session: fake-session');
	expect(status).toContain('Cost: $0.01');
	expect(status).toContain('Summary: BACKGROUND OK');

	const result = context.run(['result', jobId as string]);
	expectCommandSuccess(result);
	expect(String(result.stdout).trim()).toBe('BACKGROUND OK');

	const args = context.readClaudeArgs();
	expectArgValue(args, '--output-format', 'stream-json');
	expect(args).toContain('--verbose');
	expectArgValue(args, '--tools', '');
});

test('cancel terminates the active Claude child and marks the job canceled', () => {
	const context = setup();
	const start = context.run([
		'start',
		'--question',
		'WAIT_FOR_CANCEL',
		'--budget-usd',
		'5',
	]);

	expectCommandSuccess(start);
	const jobId = String(start.stdout).match(/claude-[a-f0-9]+/)?.[0];
	expect(jobId).toBeTruthy();
	waitForStatus(context, jobId as string, 'running');
	waitForPath(path.join(context.cwd, '.fake-claude/args.json'));

	const cancel = context.run(['cancel', jobId as string]);
	expectCommandSuccess(cancel);
	expect(String(cancel.stdout)).toContain(`Canceled Claude consult ${jobId}.`);

	const status = waitForStatus(context, jobId as string, 'canceled');
	expect(status).toContain('Summary: Canceled by user.');
	waitForPath(path.join(context.cwd, '.fake-claude/terminated'));
});

test('prompt includes supplied context and keeps Claude in consultant scope', () => {
	const prompt = buildPrompt(
		{
			mode: 'review',
			question: 'Find behavioral bugs.',
			context: [],
			budgetUsd: 5,
			maxTurns: undefined,
			bare: false,
			readFiles: false,
			timeoutMs: 1000,
		},
		'diff --git a/file.ts b/file.ts',
		'### file.ts\n\nconst value = 1;',
	);

	expect(prompt).toContain(
		'You are a read-only Claude Code consultant being invoked by Codex.',
	);
	expect(prompt).toContain('Question: Find behavioral bugs.');
	expect(prompt).toContain('Context files:\n### file.ts');
	expect(prompt).toContain('Piped context:\ndiff --git');
	expect(prompt).toContain(
		'Codex owns implementation and final judgment. You must not edit files',
	);
});
