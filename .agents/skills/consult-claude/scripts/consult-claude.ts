#!/usr/bin/env bun

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

const DEFAULT_BUDGET_USD = 5;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const HEARTBEAT_MS = 60 * 1000;
const KILL_GRACE_MS = 5 * 1000;
const MAX_PROMPT_BYTES = 2 * 1024 * 1024;
const MAX_STDOUT_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_BYTES = 1024 * 1024;

type ConsultStatus = 'completed' | 'failed' | 'timed_out' | 'canceled';

type ClaudeEvent = {
	type?: string;
	subtype?: string;
	is_error?: boolean;
	result?: unknown;
	session_id?: string;
	total_cost_usd?: number;
	duration_ms?: number;
	num_turns?: number;
	modelUsage?: unknown;
	permission_denials?: unknown;
	terminal_reason?: string;
	stop_reason?: string;
	message?: unknown;
};

type ConsultOutput = {
	status: ConsultStatus;
	result: string | null;
	error: string | null;
	session_id: string | null;
	total_cost_usd: number | null;
	duration_ms: number | null;
	num_turns: number | null;
	model_usage: unknown;
	permission_denials: unknown;
	terminal_reason: string | null;
	stop_reason: string | null;
	runner: {
		elapsed_ms: number;
		exit_code: number | null;
		exit_signal: NodeJS.Signals | null;
		last_event: string;
	};
};

const inheritedEnvironmentKeys = [
	'HOME',
	'PATH',
	'USER',
	'LOGNAME',
	'SHELL',
	'TMPDIR',
	'LANG',
	'LC_ALL',
	'LC_CTYPE',
	'TERM',
	'XDG_CONFIG_HOME',
	'XDG_CACHE_HOME',
	'SSL_CERT_FILE',
	'SSL_CERT_DIR',
	'NODE_EXTRA_CA_CERTS',
	'HTTP_PROXY',
	'HTTPS_PROXY',
	'ALL_PROXY',
	'NO_PROXY',
	'http_proxy',
	'https_proxy',
	'all_proxy',
	'no_proxy',
	'ANTHROPIC_API_KEY',
	'ANTHROPIC_AUTH_TOKEN',
	'ANTHROPIC_BASE_URL',
	'ANTHROPIC_CUSTOM_HEADERS',
	'CLAUDE_CODE_OAUTH_TOKEN',
	'CLAUDE_CONFIG_DIR',
	'DISABLE_TELEMETRY',
	'DISABLE_ERROR_REPORTING',
	'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
] as const;

export function buildClaudeArgs(budgetUsd = readPositiveNumber('CONSULT_CLAUDE_BUDGET_USD', DEFAULT_BUDGET_USD)): string[] {
	return [
		'-p',
		'--safe-mode',
		'--tools',
		'',
		'--permission-mode',
		'dontAsk',
		'--no-session-persistence',
		'--disable-slash-commands',
		'--no-chrome',
		'--output-format',
		'stream-json',
		'--verbose',
		'--max-budget-usd',
		String(budgetUsd),
	];
}

export function buildClaudeEnvironment(source = process.env): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {};
	for (const key of inheritedEnvironmentKeys) {
		const value = source[key];
		if (value !== undefined) environment[key] = value;
	}
	return environment;
}

async function readPrompt(): Promise<string> {
	const chunks: Buffer[] = [];
	let byteLength = 0;
	for await (const chunk of process.stdin) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		byteLength += buffer.byteLength;
		if (byteLength > MAX_PROMPT_BYTES) {
			throw new Error(`Consult brief exceeds ${MAX_PROMPT_BYTES} bytes.`);
		}
		chunks.push(buffer);
	}
	const prompt = Buffer.concat(chunks).toString('utf8').trim();
	if (!prompt) throw new Error('Consult brief is empty. Write the brief to stdin.');
	return prompt;
}

function readPositiveNumber(key: string, fallback: number): number {
	const raw = process.env[key];
	if (raw === undefined) return fallback;
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error(`${key} must be a positive number.`);
	}
	return value;
}

function terminateProcessGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals) {
	if (!child.pid) return;
	try {
		if (process.platform === 'win32') child.kill(signal);
		else process.kill(-child.pid, signal);
	} catch {
		child.kill(signal);
	}
}

function describeEvent(event: ClaudeEvent): string {
	if (event.type === 'system' && event.subtype) return `system:${event.subtype}`;
	if (event.type === 'assistant') return 'responding';
	if (event.type === 'result') return `result:${event.subtype ?? 'unknown'}`;
	return [event.type, event.subtype].filter(Boolean).join(':') || 'unknown';
}

function createOutput(
	status: ConsultStatus,
	finalEvent: ClaudeEvent | null,
	options: {
		error?: string;
		elapsedMs: number;
		exitCode: number | null;
		exitSignal: NodeJS.Signals | null;
		lastEvent: string;
	},
): ConsultOutput {
	return {
		status,
		result: typeof finalEvent?.result === 'string' ? finalEvent.result.trim() : null,
		error: options.error ?? null,
		session_id: finalEvent?.session_id ?? null,
		total_cost_usd: finalEvent?.total_cost_usd ?? null,
		duration_ms: finalEvent?.duration_ms ?? null,
		num_turns: finalEvent?.num_turns ?? null,
		model_usage: finalEvent?.modelUsage ?? null,
		permission_denials: finalEvent?.permission_denials ?? null,
		terminal_reason: finalEvent?.terminal_reason ?? null,
		stop_reason: finalEvent?.stop_reason ?? null,
		runner: {
			elapsed_ms: options.elapsedMs,
			exit_code: options.exitCode,
			exit_signal: options.exitSignal,
			last_event: options.lastEvent,
		},
	};
}

async function main() {
	if (process.env.CLAUDECODE === '1') {
		throw new Error('Refusing to launch nested Claude Code while CLAUDECODE=1.');
	}

	const prompt = await readPrompt();
	const timeoutMs = readPositiveNumber('CONSULT_CLAUDE_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
	const startedAt = Date.now();
	let lastEvent = 'starting';
	let finalEvent: ClaudeEvent | null = null;
	let stdoutBytes = 0;
	let stderr = '';
	let termination: Exclude<ConsultStatus, 'completed' | 'failed'> | null = null;
	let invalidOutput: string | null = null;
	let spawnError: string | null = null;
	let stdinError: string | null = null;

	const child = spawn('claude', buildClaudeArgs(), {
		cwd: process.cwd(),
		detached: process.platform !== 'win32',
		env: buildClaudeEnvironment(),
		stdio: ['pipe', 'pipe', 'pipe'],
	});
	const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
		child.once('error', (error) => {
			spawnError = error.message;
		});
		child.once('close', (code, signal) => resolve({ code, signal }));
	});
	child.stdin.once('error', (error: NodeJS.ErrnoException) => {
		if (error.code !== 'EPIPE') stdinError = error.message;
	});

	child.stdin.end(prompt);
	console.error('[consult-claude] Claude started.');

	const timeout = setTimeout(() => {
		termination = 'timed_out';
		console.error(`[consult-claude] Hard timeout after ${timeoutMs}ms; terminating Claude.`);
		terminateProcessGroup(child, 'SIGTERM');
		setTimeout(() => terminateProcessGroup(child, 'SIGKILL'), KILL_GRACE_MS).unref();
	}, timeoutMs);
	timeout.unref();

	const heartbeat = setInterval(() => {
		const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
		console.error(`[consult-claude] Still running after ${elapsedSeconds}s; latest event: ${lastEvent}.`);
	}, HEARTBEAT_MS);
	heartbeat.unref();

	const cancel = (signal: NodeJS.Signals) => {
		if (termination) return;
		termination = 'canceled';
		console.error(`[consult-claude] Received ${signal}; canceling Claude.`);
		terminateProcessGroup(child, 'SIGTERM');
		setTimeout(() => terminateProcessGroup(child, 'SIGKILL'), KILL_GRACE_MS).unref();
	};
	const onSigint = () => cancel('SIGINT');
	const onSigterm = () => cancel('SIGTERM');
	process.once('SIGINT', onSigint);
	process.once('SIGTERM', onSigterm);

	child.stderr.on('data', (chunk: Buffer) => {
		const text = chunk.toString('utf8');
		if (stderr.length < MAX_STDERR_BYTES) stderr += text.slice(0, MAX_STDERR_BYTES - stderr.length);
		process.stderr.write(text);
	});

	const lines = createInterface({ input: child.stdout });
	for await (const line of lines) {
		stdoutBytes += Buffer.byteLength(line) + 1;
		if (stdoutBytes > MAX_STDOUT_BYTES) {
			invalidOutput = `Claude output exceeds ${MAX_STDOUT_BYTES} bytes.`;
			terminateProcessGroup(child, 'SIGTERM');
			setTimeout(() => terminateProcessGroup(child, 'SIGKILL'), KILL_GRACE_MS).unref();
			break;
		}

		let event: ClaudeEvent;
		try {
			event = JSON.parse(line) as ClaudeEvent;
		} catch {
			invalidOutput = `Claude emitted non-JSON output: ${line.slice(0, 200)}`;
			continue;
		}

		const description = describeEvent(event);
		if (description !== lastEvent) {
			lastEvent = description;
			if (description === 'responding' || description.startsWith('system:')) {
				console.error(`[consult-claude] ${description}.`);
			}
		}
		if (event.type === 'result') finalEvent = event;
	}

	const exit = await exitPromise;

	clearTimeout(timeout);
	clearInterval(heartbeat);
	process.off('SIGINT', onSigint);
	process.off('SIGTERM', onSigterm);

	const elapsedMs = Date.now() - startedAt;
	let status: ConsultStatus = 'failed';
	let error: string | undefined;
	let exitCode = 1;

	if (termination) {
		status = termination;
		error = termination === 'timed_out' ? `Claude exceeded the ${timeoutMs}ms hard timeout.` : 'Claude consultation was canceled.';
		exitCode = termination === 'timed_out' ? 124 : 130;
	} else if (spawnError) {
		error = `Could not start Claude: ${spawnError}`;
	} else if (stdinError) {
		error = `Could not send the consultation brief to Claude: ${stdinError}`;
	} else if (invalidOutput) {
		error = invalidOutput;
		exitCode = 70;
	} else if (exit.code !== 0) {
		error = stderr.trim() || `Claude exited with status ${exit.code ?? 'unknown'}.`;
	} else if (!finalEvent) {
		error = 'Claude exited without a final result event.';
		exitCode = 70;
	} else if (finalEvent.subtype !== 'success' || finalEvent.is_error || typeof finalEvent.result !== 'string') {
		error = typeof finalEvent.result === 'string' ? finalEvent.result : `Claude returned ${finalEvent.subtype ?? 'an invalid result'}.`;
	} else if (finalEvent.stop_reason === 'refusal') {
		error = 'Claude refused the consultation.';
	} else {
		status = 'completed';
		exitCode = 0;
	}

	console.log(JSON.stringify(createOutput(status, finalEvent, {
		error,
		elapsedMs,
		exitCode: exit.code,
		exitSignal: exit.signal,
		lastEvent,
	})));
	process.exitCode = exitCode;
}

if (import.meta.main) {
	main().catch((error) => {
		const message = error instanceof Error ? error.message : String(error);
		console.log(JSON.stringify(createOutput('failed', null, {
			error: message,
			elapsedMs: 0,
			exitCode: null,
			exitSignal: null,
			lastEvent: 'not_started',
		})));
		process.exitCode = 64;
	});
}
