import { describe, expect, test } from 'bun:test';
import {
	buildClaudeCodeConsultInvocation,
	createConsultDetails,
	formatClaudeCodeConsultResult,
	getConsultFailure,
	parseClaudeCodeJson,
	type SpawnClaudeResult,
	wrapConsultPrompt,
} from './claude-code-consult.ts';

describe('buildClaudeCodeConsultInvocation', () => {
	test('builds a read-only plan-mode invocation with MCP stripped by default', () => {
		const invocation = buildClaudeCodeConsultInvocation(
			{ prompt: 'Review this API.' },
			'/repo',
		);

		expect(invocation.command).toBe('claude');
		expect(invocation.cwd).toBe('/repo');
		expect(invocation.args).toEqual([
			'-p',
			'--output-format',
			'json',
			'--permission-mode',
			'plan',
			'--strict-mcp-config',
			'--disallowedTools',
			'mcp__*',
		]);
		expect(invocation.prompt).toContain('Pi owns execution');
		expect(invocation.prompt).toContain('Consult request:\nReview this API.');
	});

	test('adds optional continuation and cost controls', () => {
		const invocation = buildClaudeCodeConsultInvocation(
			{
				prompt: 'Continue the review.',
				cwd: '/other',
				session_id: 'session-123',
				model: 'opus',
				effort: 'high',
				max_budget_usd: 0.5,
				allow_mcp: true,
			},
			'/repo',
		);

		expect(invocation.cwd).toBe('/other');
		expect(invocation.args).toEqual([
			'-p',
			'--output-format',
			'json',
			'--permission-mode',
			'plan',
			'--model',
			'opus',
			'--effort',
			'high',
			'--max-budget-usd',
			'0.5',
			'--resume',
			'session-123',
		]);
	});
});

describe('wrapConsultPrompt', () => {
	test('instructs Claude to consult and delegate token-heavy context gathering', () => {
		const prompt = wrapConsultPrompt('Should we simplify this boundary?');

		expect(prompt).toContain('read-only Claude Code consultant');
		expect(prompt).toContain(
			'delegate token-heavy context gathering to Codex subagents',
		);
		expect(prompt).toContain('Should we simplify this boundary?');
	});
});

describe('parseClaudeCodeJson', () => {
	test('parses Claude Code JSON output', () => {
		expect(parseClaudeCodeJson('{"result":"ok","session_id":"abc"}\n')).toEqual(
			{
				result: 'ok',
				session_id: 'abc',
			},
		);
	});

	test('rejects empty output', () => {
		expect(() => parseClaudeCodeJson('\n')).toThrow('no JSON output');
	});

	test('rejects invalid JSON', () => {
		expect(() => parseClaudeCodeJson('not json')).toThrow('invalid JSON');
	});
});

describe('formatClaudeCodeConsultResult', () => {
	test('formats the result with resumable metadata', () => {
		const details = createConsultDetails(
			buildClaudeCodeConsultInvocation({ prompt: 'Review' }, '/repo'),
			okProcess(),
			{
				result: 'Use the smaller API.',
				session_id: 'abc',
				num_turns: 3,
				total_cost_usd: 0.12345,
				permission_denials: [],
			},
		);

		expect(formatClaudeCodeConsultResult(details)).toBe(
			'Use the smaller API.\n\nsession_id: abc · turns: 3 · cost: $0.1235',
		);
	});

	test('includes permission denials when present', () => {
		const details = createConsultDetails(
			buildClaudeCodeConsultInvocation({ prompt: 'Review' }, '/repo'),
			okProcess(),
			{
				result: 'I could not inspect that command.',
				permission_denials: [{ tool: 'Bash' }],
			},
		);

		expect(formatClaudeCodeConsultResult(details)).toContain(
			'denials: [{"tool":"Bash"}]',
		);
	});
});

describe('getConsultFailure', () => {
	test('reports nonzero exit code with stderr', () => {
		const details = createConsultDetails(
			buildClaudeCodeConsultInvocation({ prompt: 'Review' }, '/repo'),
			{ ...okProcess(), exitCode: 1, stderr: 'Not logged in' },
			{},
		);

		expect(getConsultFailure(details)).toContain(
			'Claude Code exited with code 1',
		);
		expect(getConsultFailure(details)).toContain('Not logged in');
	});

	test('reports Claude JSON error markers', () => {
		const details = createConsultDetails(
			buildClaudeCodeConsultInvocation({ prompt: 'Review' }, '/repo'),
			okProcess(),
			{
				is_error: true,
				error: 'Budget exceeded',
			},
		);

		expect(getConsultFailure(details)).toBe('Budget exceeded');
	});
});

function okProcess(): SpawnClaudeResult {
	return { stdout: '', stderr: '', exitCode: 0, aborted: false };
}
