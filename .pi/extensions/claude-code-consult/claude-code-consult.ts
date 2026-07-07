import { spawn } from 'node:child_process';

const PROCESS_KILL_GRACE_MS = 5_000;
const STDERR_LIMIT_BYTES = 64 * 1024;

export const CONSULTANT_INSTRUCTIONS = `You are a read-only Claude Code consultant called from Pi.

Pi owns execution. Do not edit files, do not run write-capable actions, and do not treat your answer as final authority. Stay in plan/review mode.

When available, delegate token-heavy context gathering to Codex subagents instead of spending Claude budget on broad exploration. Use bounded handoff-style prompts: give each Codex subagent exact paths or commands to inspect, one concrete question, required evidence, and a stop condition. Good delegated work includes repository search, grep, file reading, command-output capture, diff inspection, external-doc lookup, and first-pass summaries.

Treat Codex outputs as evidence, not authority. Your job is to synthesize, challenge assumptions, name risks, identify the smallest useful next action, and explain what would change your recommendation.

Return advice in this shape:
- Recommendation
- Evidence used
- Risks and tradeoffs
- Suggested implementation plan, if useful
- What Pi should verify before acting`;

export type ClaudeCodeConsultParams = {
	prompt: string;
	cwd?: string;
	session_id?: string;
	model?: string;
	effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
	max_budget_usd?: number;
	allow_mcp?: boolean;
};

export type ClaudeCodeConsultArgs = {
	command: 'claude';
	args: string[];
	cwd: string;
	prompt: string;
};

export type ClaudeCodeJsonResult = {
	type?: string;
	result?: string;
	session_id?: string;
	num_turns?: number;
	total_cost_usd?: number;
	usage?: unknown;
	permission_denials?: unknown;
	is_error?: boolean;
	subtype?: string;
	error?: string;
};

export type ClaudeCodeConsultDetails = {
	command: string;
	args: string[];
	cwd: string;
	exitCode: number;
	stderr: string;
	raw: ClaudeCodeJsonResult;
	sessionId?: string;
	turns?: number;
	costUsd?: number;
	usage?: unknown;
	permissionDenials?: unknown;
};

export type SpawnClaudeResult = {
	stdout: string;
	stderr: string;
	exitCode: number;
	aborted: boolean;
};

export function buildClaudeCodeConsultInvocation(
	params: ClaudeCodeConsultParams,
	defaultCwd: string,
): ClaudeCodeConsultArgs {
	const args = ['-p', '--output-format', 'json', '--permission-mode', 'plan'];

	if (!params.allow_mcp)
		args.push('--strict-mcp-config', '--disallowedTools', 'mcp__*');
	if (params.model) args.push('--model', params.model);
	if (params.effort) args.push('--effort', params.effort);
	if (params.max_budget_usd !== undefined)
		args.push('--max-budget-usd', String(params.max_budget_usd));
	if (params.session_id) args.push('--resume', params.session_id);

	return {
		command: 'claude',
		args,
		cwd: params.cwd ?? defaultCwd,
		prompt: wrapConsultPrompt(params.prompt),
	};
}

export function wrapConsultPrompt(prompt: string): string {
	return `${CONSULTANT_INSTRUCTIONS}\n\nConsult request:\n${prompt}`;
}

export async function spawnClaudeCodeConsult(
	invocation: ClaudeCodeConsultArgs,
	signal?: AbortSignal,
): Promise<SpawnClaudeResult> {
	return await new Promise<SpawnClaudeResult>((resolve, reject) => {
		const child = spawn(invocation.command, invocation.args, {
			cwd: invocation.cwd,
			shell: false,
			stdio: ['pipe', 'pipe', 'pipe'],
		});

		let stdout = '';
		let stderr = '';
		let aborted = false;
		let exited = false;
		let killTimer: ReturnType<typeof setTimeout> | undefined;

		const onAbort = () => {
			aborted = true;
			child.kill('SIGTERM');
			killTimer = setTimeout(() => {
				if (!exited) child.kill('SIGKILL');
			}, PROCESS_KILL_GRACE_MS);
		};

		const cleanup = () => {
			exited = true;
			if (killTimer) clearTimeout(killTimer);
			signal?.removeEventListener('abort', onAbort);
		};

		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');

		child.stdout.on('data', (chunk: string) => {
			stdout += chunk;
		});

		child.stderr.on('data', (chunk: string) => {
			stderr = appendWithByteLimit(stderr, chunk, STDERR_LIMIT_BYTES);
		});

		child.on('error', (error) => {
			cleanup();
			reject(error);
		});

		child.on('close', (code) => {
			cleanup();
			resolve({ stdout, stderr, exitCode: code ?? 1, aborted });
		});

		if (signal?.aborted) onAbort();
		else signal?.addEventListener('abort', onAbort, { once: true });

		child.stdin.end(invocation.prompt);
	});
}

export function parseClaudeCodeJson(stdout: string): ClaudeCodeJsonResult {
	const trimmed = stdout.trim();
	if (!trimmed) throw new Error('Claude Code returned no JSON output.');

	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch (error) {
		throw new Error(
			`Claude Code returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	if (!isRecord(parsed))
		throw new Error('Claude Code JSON output was not an object.');
	return parsed;
}

export function formatClaudeCodeConsultResult(
	details: ClaudeCodeConsultDetails,
): string {
	const result =
		typeof details.raw.result === 'string' && details.raw.result.trim()
			? details.raw.result.trim()
			: '(no result)';
	const footer = [
		details.sessionId ? `session_id: ${details.sessionId}` : undefined,
		details.turns !== undefined ? `turns: ${details.turns}` : undefined,
		details.costUsd !== undefined
			? `cost: $${details.costUsd.toFixed(4)}`
			: undefined,
		hasPermissionDenials(details.permissionDenials)
			? `denials: ${JSON.stringify(details.permissionDenials)}`
			: undefined,
	]
		.filter((part): part is string => Boolean(part))
		.join(' · ');

	return footer ? `${result}\n\n${footer}` : result;
}

export function createConsultDetails(
	invocation: ClaudeCodeConsultArgs,
	processResult: SpawnClaudeResult,
	raw: ClaudeCodeJsonResult,
): ClaudeCodeConsultDetails {
	return {
		command: invocation.command,
		args: invocation.args,
		cwd: invocation.cwd,
		exitCode: processResult.exitCode,
		stderr: processResult.stderr,
		raw,
		sessionId: raw.session_id,
		turns: raw.num_turns,
		costUsd: raw.total_cost_usd,
		usage: raw.usage,
		permissionDenials: raw.permission_denials,
	};
}

export function getConsultFailure(
	details: ClaudeCodeConsultDetails,
): string | undefined {
	if (details.exitCode !== 0) {
		return [
			`Claude Code exited with code ${details.exitCode}.`,
			details.stderr.trim() ? `stderr:\n${details.stderr.trim()}` : undefined,
			typeof details.raw.error === 'string'
				? `error: ${details.raw.error}`
				: undefined,
		]
			.filter(Boolean)
			.join('\n\n');
	}

	if (details.raw.is_error) {
		return typeof details.raw.error === 'string' && details.raw.error.trim()
			? details.raw.error
			: 'Claude Code marked the consult result as an error.';
	}

	return undefined;
}

function appendWithByteLimit(
	current: string,
	chunk: string,
	limit: number,
): string {
	const combined = current + chunk;
	if (Buffer.byteLength(combined, 'utf8') <= limit) return combined;

	let trimmed = combined.slice(-limit);
	while (Buffer.byteLength(trimmed, 'utf8') > limit) trimmed = trimmed.slice(1);
	return trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasPermissionDenials(value: unknown): boolean {
	return Array.isArray(value) ? value.length > 0 : Boolean(value);
}
