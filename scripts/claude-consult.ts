#!/usr/bin/env bun

import { spawn } from 'node:child_process';
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const modeInstructions = {
	review: [
		'Review the provided context for behavioral bugs, regressions, missing tests, and risky assumptions.',
		'Do not comment on style unless it hides a correctness problem.',
	],
	design: [
		'Critique the API, ownership boundary, naming, and abstraction shape.',
		'Look for cleaner options, asymmetric wins, and clean breaks before suggesting local patches.',
	],
	tests: [
		'Identify the smallest useful tests that should exist for the provided change or bug.',
		'Call out overfit tests, missing edge cases, and test setup that hides the actual behavior.',
	],
	docs: [
		'Review the provided prose or API docs for vague claims, stale terminology, missing examples, and misleading promises.',
		'Prefer exact replacement suggestions when a small edit would fix the issue.',
	],
} as const;

type ConsultMode = keyof typeof modeInstructions;
type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'canceled';
type CommandName = 'start' | 'status' | 'result' | 'cancel' | 'run-job';

type ConsultOptions = {
	mode: ConsultMode;
	question: string;
	context: string[];
	budgetUsd: number;
	maxTurns: number | undefined;
	bare: boolean;
	readFiles: boolean;
	timeoutMs: number;
};

type ClaudeEnvelope = {
	errors?: unknown;
	is_error?: boolean;
	result?: unknown;
};

type ClaudeStreamMessage = {
	type?: string;
	subtype?: string;
	is_error?: boolean;
	result?: unknown;
	message?: {
		content?: Array<{ type?: string; text?: string }>;
	};
	total_cost_usd?: number;
	duration_ms?: number;
	session_id?: string;
};

type ClaudeRunResult = {
	exitCode: number;
	timedOut: boolean;
	stdout: string;
	stderr: string;
	result: string | null;
	finalMessage: ClaudeStreamMessage | null;
};

type JobRequest = {
	options: ConsultOptions;
	prompt: string;
	createdAt: string;
};

type JobRecord = {
	id: string;
	status: JobStatus;
	mode: ConsultMode;
	question: string;
	cwd: string;
	createdAt: string;
	updatedAt: string;
	startedAt?: string;
	completedAt?: string;
	pid?: number;
	exitCode?: number;
	timedOut?: boolean;
	summary?: string;
	result?: string;
	error?: string;
	sessionId?: string;
	totalCostUsd?: number;
	durationMs?: number;
};

type StateFile = {
	jobs: JobRecord[];
};

const commandNames = new Set<CommandName>([
	'start',
	'status',
	'result',
	'cancel',
	'run-job',
]);
const defaultBudgetUsd = 25;
const defaultSyncTimeoutMs = 5 * 60 * 1000;
const defaultJobTimeoutMs = 30 * 60 * 1000;
const stateDirectoryName = '.tmp/claude-consult';

function parseArgs(argv: string[], defaults = {}): ConsultOptions {
	const options = {
		mode: 'review',
		question: '',
		context: [],
		budgetUsd: defaultBudgetUsd,
		maxTurns: undefined,
		bare: false,
		readFiles: false,
		timeoutMs: defaultSyncTimeoutMs,
		...defaults,
	} as ConsultOptions;

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		const next = argv[index + 1];

		if (arg === '--help' || arg === '-h') {
			printHelp();
			process.exit(0);
		}

		if (arg === '--mode') {
			if (!isMode(next)) fail(`Invalid --mode value: ${next ?? '<missing>'}`);
			options.mode = next;
			index += 1;
			continue;
		}

		if (arg === '--question' || arg === '-q') {
			options.question = readValue(arg, next);
			index += 1;
			continue;
		}

		if (arg === '--context' || arg === '-c') {
			options.context.push(readValue(arg, next));
			index += 1;
			continue;
		}

		if (arg === '--budget-usd') {
			const value = readValue(arg, next);
			const budgetUsd = Number(value);
			if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) {
				fail(`Invalid --budget-usd value: ${value}`);
			}
			options.budgetUsd = budgetUsd;
			index += 1;
			continue;
		}

		if (arg === '--max-turns') {
			const value = readValue(arg, next);
			const maxTurns = Number(value);
			if (!Number.isSafeInteger(maxTurns) || maxTurns <= 0) {
				fail(`Invalid --max-turns value: ${value}`);
			}
			options.maxTurns = maxTurns;
			index += 1;
			continue;
		}

		if (arg === '--timeout-ms') {
			const value = readValue(arg, next);
			const timeoutMs = Number(value);
			if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
				fail(`Invalid --timeout-ms value: ${value}`);
			}
			options.timeoutMs = timeoutMs;
			index += 1;
			continue;
		}

		if (arg === '--bare') {
			options.bare = true;
			continue;
		}

		if (arg === '--read-files') {
			options.readFiles = true;
			continue;
		}

		fail(`Unknown argument: ${arg}`);
	}

	if (!options.question) fail('Missing required --question value');
	if (options.budgetUsd < 1)
		fail('--budget-usd must be at least 1 so Claude can return a result');

	return options;
}

function isMode(value: string | undefined): value is ConsultMode {
	return typeof value === 'string' && value in modeInstructions;
}

async function runSync(argv: string[]) {
	const options = parseArgs(argv);
	const stdin = await readStdin();
	const contextText = await readContext(options.context);
	const prompt = buildPrompt(options, stdin.trim(), contextText);
	const run = await runClaude(prompt, options, {
		outputFormat: 'json',
		timeoutMs: options.timeoutMs,
	});

	if (run.exitCode !== 0) {
		const envelope = parseClaudeEnvelope(run.stdout);
		printClaudeError(envelope);
		if (run.stderr.trim()) console.error(run.stderr.trim());
		if (run.stdout.trim() && typeof envelope.result !== 'string') {
			console.error(run.stdout.trim());
		}
		const reason = run.timedOut
			? `timed out after ${options.timeoutMs}ms`
			: `exited with status ${run.exitCode}`;
		fail(`claude ${reason}`);
	}

	const envelope = parseClaudeEnvelope(run.stdout);
	if (envelope.is_error) {
		printClaudeError(envelope);
		fail('claude returned is_error=true');
	}

	if (typeof envelope.result !== 'string') {
		if (run.stdout.trim()) console.error(run.stdout.trim());
		fail('claude returned JSON without a string result');
	}

	console.log(envelope.result.trim());
}

async function startJob(argv: string[]) {
	const options = parseArgs(argv, { timeoutMs: defaultJobTimeoutMs });
	const stdin = await readStdin();
	const contextText = await readContext(options.context);
	const prompt = buildPrompt(options, stdin.trim(), contextText);
	const id = generateJobId();
	const createdAt = nowIso();
	const record: JobRecord = {
		id,
		status: 'queued',
		mode: options.mode,
		question: options.question,
		cwd: process.cwd(),
		createdAt,
		updatedAt: createdAt,
	};

	ensureJobDirectory(id);
	writeJson(resolveJobRequestFile(id), {
		options,
		prompt,
		createdAt,
	} satisfies JobRequest);
	upsertJob(record);

	const child = spawn(
		Bun.argv[0] ?? 'bun',
		[fileURLToPath(import.meta.url), 'run-job', id],
		{
			cwd: process.cwd(),
			detached: true,
			stdio: ['ignore', 'ignore', 'ignore'],
			env: process.env,
		},
	);
	child.unref();

	upsertJob({
		...record,
		status: 'running',
		pid: child.pid,
		startedAt: nowIso(),
		updatedAt: nowIso(),
	});

	console.log(`Started Claude consult ${id}.`);
	console.log(`Status: bun run claude:consult -- status ${id}`);
	console.log(`Result: bun run claude:consult -- result ${id}`);
}

async function runJob(argv: string[]) {
	const id = argv[0];
	if (!id) fail('Missing job id.');
	const request = readJson<JobRequest>(resolveJobRequestFile(id));
	const startedAt = nowIso();
	updateJob(id, (job) => ({
		...job,
		status: 'running',
		pid: process.pid,
		startedAt: job.startedAt ?? startedAt,
		updatedAt: startedAt,
	}));

	const run = await runClaude(request.prompt, request.options, {
		outputFormat: 'stream-json',
		stdoutFile: resolveJobStdoutFile(id),
		stderrFile: resolveJobStderrFile(id),
		timeoutMs: request.options.timeoutMs,
		onPid(pid) {
			updateJob(id, (job) => ({
				...job,
				pid,
				updatedAt: nowIso(),
			}));
		},
	});

	const completedAt = nowIso();
	if (findJob(readState(), id).status === 'canceled') {
		return;
	}
	if (
		run.exitCode === 0 &&
		run.result !== null &&
		!run.finalMessage?.is_error
	) {
		const result = run.result.trim();
		writeJson(resolveJobResultFile(id), {
			id,
			status: 'completed',
			result,
			finalMessage: run.finalMessage,
			completedAt,
		});
		updateJob(id, (job) => ({
			...job,
			status: 'completed',
			exitCode: run.exitCode,
			timedOut: run.timedOut,
			completedAt,
			updatedAt: completedAt,
			result,
			summary: firstMeaningfulLine(result, 'Claude consult completed.'),
			sessionId: run.finalMessage?.session_id,
			totalCostUsd: run.finalMessage?.total_cost_usd,
			durationMs: run.finalMessage?.duration_ms,
		}));
		return;
	}

	const error = run.timedOut
		? `Claude timed out after ${request.options.timeoutMs}ms.`
		: firstMeaningfulLine(
				run.stderr,
				`Claude exited with status ${run.exitCode}.`,
			);
	writeJson(resolveJobResultFile(id), {
		id,
		status: 'failed',
		error,
		stdout: run.stdout,
		stderr: run.stderr,
		finalMessage: run.finalMessage,
		completedAt,
	});
	updateJob(id, (job) => ({
		...job,
		status: 'failed',
		exitCode: run.exitCode,
		timedOut: run.timedOut,
		completedAt,
		updatedAt: completedAt,
		error,
		summary: error,
		sessionId: run.finalMessage?.session_id,
		totalCostUsd: run.finalMessage?.total_cost_usd,
		durationMs: run.finalMessage?.duration_ms,
	}));
}

function showStatus(argv: string[]) {
	const id = argv[0];
	const state = readState();
	if (id) {
		const job = findJob(state, id);
		console.log(renderJob(job));
		return;
	}

	const jobs = state.jobs
		.slice()
		.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
	if (jobs.length === 0) {
		console.log('No Claude consult jobs found.');
		return;
	}

	console.log('| job | status | mode | updated | summary |');
	console.log('| --- | --- | --- | --- | --- |');
	for (const job of jobs.slice(0, 20)) {
		console.log(
			`| ${job.id} | ${job.status} | ${job.mode} | ${job.updatedAt} | ${escapeTableCell(
				job.summary ?? shorten(job.question, 80),
			)} |`,
		);
	}
}

function showResult(argv: string[]) {
	const id = argv[0] ?? latestFinishedJobId();
	if (!id) fail('No finished Claude consult job was found.');
	const job = findJob(readState(), id);
	if (job.status === 'running' || job.status === 'queued') {
		fail(
			`Claude consult ${id} is still ${job.status}. Run status ${id} first.`,
		);
	}
	if (job.result) {
		console.log(job.result.trim());
		return;
	}
	if (existsSync(resolveJobResultFile(id))) {
		const result = readJson<{ result?: unknown; error?: unknown }>(
			resolveJobResultFile(id),
		);
		if (typeof result.result === 'string') {
			console.log(result.result.trim());
			return;
		}
		if (typeof result.error === 'string') fail(result.error);
	}
	fail(job.error ?? `Claude consult ${id} has no stored result.`);
}

function cancelJob(argv: string[]) {
	const id = argv[0];
	if (!id) fail('Missing job id.');
	const job = findJob(readState(), id);
	if (job.status !== 'running' && job.status !== 'queued') {
		console.log(`Claude consult ${id} is already ${job.status}.`);
		return;
	}
	if (job.pid) {
		try {
			process.kill(job.pid, 'SIGTERM');
		} catch {
			// The process may already be gone; the state update below is still useful.
		}
	}
	const canceledAt = nowIso();
	updateJob(id, (current) => ({
		...current,
		status: 'canceled',
		completedAt: canceledAt,
		updatedAt: canceledAt,
		summary: 'Canceled by user.',
	}));
	console.log(`Canceled Claude consult ${id}.`);
}

async function main(argv: string[]) {
	const command = argv[0];
	if (isCommand(command)) {
		const rest = argv.slice(1);
		switch (command) {
			case 'start':
				await startJob(rest);
				return;
			case 'status':
				showStatus(rest);
				return;
			case 'result':
				showResult(rest);
				return;
			case 'cancel':
				cancelJob(rest);
				return;
			case 'run-job':
				await runJob(rest);
				return;
		}
	}

	await runSync(argv);
}

function isCommand(value: string | undefined): value is CommandName {
	return typeof value === 'string' && commandNames.has(value as CommandName);
}

async function readStdin(): Promise<string> {
	return new Response(Bun.stdin.stream()).text();
}

function readValue(flag: string, value: string | undefined): string {
	if (!value || value.startsWith('-')) fail(`Missing value for ${flag}`);
	return value;
}

async function readContext(paths: string[]): Promise<string> {
	const blocks = await Promise.all(
		paths.map(async (filePath) => {
			const file = Bun.file(filePath);
			if (!(await file.exists()))
				fail(`Context file does not exist: ${filePath}`);
			const text = await file.text();
			return `### ${filePath}\n\n${text}`;
		}),
	);

	return blocks.join('\n\n');
}

export function buildPrompt(
	options: ConsultOptions,
	stdin: string,
	contextText: string,
): string {
	const sections = [
		'You are a read-only Claude Code consultant being invoked by Codex.',
		'Codex owns implementation and final judgment. You must not edit files, commit, push, delete files, run destructive commands, or ask for broad follow-up work.',
		'',
		`Question: ${options.question}`,
		'',
		'Lens:',
		...modeInstructions[options.mode].map((instruction) => `- ${instruction}`),
		'',
		'Answer shape:',
		'- Answer directly from the supplied context before mentioning any missing context.',
		'- Start with one concrete sentence describing the current surface or risk.',
		'- Then list findings ordered by severity.',
		'- For each finding, include evidence from the provided context and the smallest useful next action.',
		'- Separate facts from opinions.',
		'- If the evidence is insufficient, say exactly what is missing and stop.',
	];

	if (contextText) {
		sections.push('', 'Context files:', contextText);
	}

	if (stdin) {
		sections.push('', 'Piped context:', stdin);
	}

	return sections.join('\n');
}

async function runClaude(
	prompt: string,
	options: ConsultOptions,
	runOptions: {
		outputFormat: 'json' | 'stream-json';
		stdoutFile?: string;
		stderrFile?: string;
		timeoutMs: number;
		onPid?: (pid: number) => void;
	},
): Promise<ClaudeRunResult> {
	const args = buildClaudeArgs(prompt, options, runOptions.outputFormat);
	const child = Bun.spawn(['claude', ...args], {
		stdout: 'pipe',
		stderr: 'pipe',
	});
	if (child.pid) runOptions.onPid?.(child.pid);
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill('SIGTERM');
		setTimeout(() => child.kill('SIGKILL'), 5000).unref?.();
	}, runOptions.timeoutMs);
	timer.unref?.();

	const stdoutTask =
		runOptions.outputFormat === 'stream-json'
			? collectStreamJson(child.stdout, runOptions.stdoutFile)
			: collectText(child.stdout, runOptions.stdoutFile);
	const stderrTask = collectText(child.stderr, runOptions.stderrFile);
	const [stdoutResult, stderr, exitCode] = await Promise.all([
		stdoutTask,
		stderrTask,
		child.exited,
	]);
	clearTimeout(timer);

	if (typeof stdoutResult === 'string') {
		return {
			exitCode,
			timedOut,
			stdout: stdoutResult,
			stderr,
			result: null,
			finalMessage: null,
		};
	}

	return {
		exitCode,
		timedOut,
		stdout: stdoutResult.raw,
		stderr,
		result: stdoutResult.result,
		finalMessage: stdoutResult.finalMessage,
	};
}

function buildClaudeArgs(
	prompt: string,
	options: ConsultOptions,
	outputFormat: 'json' | 'stream-json',
): string[] {
	const args = [
		...(options.bare ? ['--bare'] : []),
		'-p',
		prompt,
		'--output-format',
		outputFormat,
		...(outputFormat === 'stream-json' ? ['--verbose'] : []),
		'--max-budget-usd',
		String(options.budgetUsd),
		'--no-session-persistence',
		'--disable-slash-commands',
		'--disallowedTools',
		'Edit,Write,Bash',
		'--permission-mode',
		'dontAsk',
	];

	if (options.readFiles) {
		args.push('--tools', 'Read,Grep,Glob', '--allowedTools', 'Read,Grep,Glob');
	} else {
		args.push('--tools', '');
	}

	if (options.maxTurns !== undefined) {
		args.push('--max-turns', String(options.maxTurns));
	}

	return args;
}

async function collectText(
	stream: ReadableStream<Uint8Array>,
	filePath?: string,
): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let text = '';

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		const chunk = decoder.decode(value, { stream: true });
		text += chunk;
		if (filePath) appendFileSync(filePath, chunk);
	}

	const tail = decoder.decode();
	if (tail) {
		text += tail;
		if (filePath) appendFileSync(filePath, tail);
	}

	return text;
}

async function collectStreamJson(
	stream: ReadableStream<Uint8Array>,
	filePath?: string,
): Promise<{
	raw: string;
	result: string | null;
	finalMessage: ClaudeStreamMessage | null;
}> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let raw = '';
	let buffer = '';
	let result: string | null = null;
	let finalMessage: ClaudeStreamMessage | null = null;

	function handleLine(line: string) {
		if (!line.trim()) return;
		try {
			const message = JSON.parse(line) as ClaudeStreamMessage;
			if (message.type === 'result') {
				finalMessage = message;
				if (typeof message.result === 'string') result = message.result;
			}
		} catch {
			return;
		}
	}

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		const chunk = decoder.decode(value, { stream: true });
		raw += chunk;
		if (filePath) appendFileSync(filePath, chunk);
		buffer += chunk;
		let newlineIndex = buffer.indexOf('\n');
		while (newlineIndex !== -1) {
			const line = buffer.slice(0, newlineIndex);
			buffer = buffer.slice(newlineIndex + 1);
			handleLine(line);
			newlineIndex = buffer.indexOf('\n');
		}
	}

	const tail = decoder.decode();
	if (tail) {
		raw += tail;
		if (filePath) appendFileSync(filePath, tail);
		buffer += tail;
	}
	if (buffer.trim()) handleLine(buffer);

	return { raw, result, finalMessage };
}

function parseClaudeEnvelope(stdout: string): ClaudeEnvelope {
	try {
		return JSON.parse(stdout) as ClaudeEnvelope;
	} catch {
		return {};
	}
}

function printClaudeError(envelope: ReturnType<typeof parseClaudeEnvelope>) {
	if (typeof envelope.result === 'string') console.error(envelope.result);
	if (Array.isArray(envelope.errors)) {
		for (const error of envelope.errors) {
			if (typeof error === 'string') console.error(error);
		}
	}
}

function resolveStateDir() {
	return path.join(process.cwd(), stateDirectoryName);
}

function resolveStateFile() {
	return path.join(resolveStateDir(), 'jobs.json');
}

function resolveJobsDir() {
	return path.join(resolveStateDir(), 'jobs');
}

function resolveJobDir(id: string) {
	return path.join(resolveJobsDir(), id);
}

function resolveJobRequestFile(id: string) {
	return path.join(resolveJobDir(id), 'request.json');
}

function resolveJobStdoutFile(id: string) {
	return path.join(resolveJobDir(id), 'stdout.jsonl');
}

function resolveJobStderrFile(id: string) {
	return path.join(resolveJobDir(id), 'stderr.log');
}

function resolveJobResultFile(id: string) {
	return path.join(resolveJobDir(id), 'result.json');
}

function ensureStateDir() {
	mkdirSync(resolveJobsDir(), { recursive: true });
}

function ensureJobDirectory(id: string) {
	mkdirSync(resolveJobDir(id), { recursive: true });
	for (const file of [resolveJobStdoutFile(id), resolveJobStderrFile(id)]) {
		if (existsSync(file)) unlinkSync(file);
		writeFileSync(file, '', 'utf8');
	}
}

function readState(): StateFile {
	ensureStateDir();
	const stateFile = resolveStateFile();
	if (!existsSync(stateFile)) return { jobs: [] };
	return readJson<StateFile>(stateFile);
}

function writeState(state: StateFile) {
	ensureStateDir();
	writeJson(resolveStateFile(), state);
}

function upsertJob(job: JobRecord) {
	const state = readState();
	const nextJobs = state.jobs.filter((candidate) => candidate.id !== job.id);
	nextJobs.push(job);
	writeState({ jobs: nextJobs });
}

function updateJob(id: string, update: (job: JobRecord) => JobRecord) {
	const state = readState();
	const job = findJob(state, id);
	upsertJob(update(job));
}

function findJob(state: StateFile, id: string): JobRecord {
	const job = state.jobs.find((candidate) => candidate.id === id);
	if (!job) fail(`Claude consult job not found: ${id}`);
	return job;
}

function latestFinishedJobId(): string | null {
	return (
		readState()
			.jobs.filter(
				(job) => job.status === 'completed' || job.status === 'failed',
			)
			.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]
			?.id ?? null
	);
}

function readJson<T>(filePath: string): T {
	return JSON.parse(readFileSync(filePath, 'utf8')) as T;
}

function writeJson(filePath: string, value: unknown) {
	mkdirSync(path.dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function generateJobId() {
	return `claude-${crypto.randomUUID().slice(0, 8)}`;
}

function nowIso() {
	return new Date().toISOString();
}

function firstMeaningfulLine(text: string, fallback: string) {
	return (
		text
			.split(/\r?\n/)
			.map((line) => line.trim())
			.find(Boolean) ?? fallback
	);
}

function shorten(text: string, limit: number) {
	const normalized = text.trim().replace(/\s+/g, ' ');
	if (normalized.length <= limit) return normalized;
	return `${normalized.slice(0, limit - 3)}...`;
}

function escapeTableCell(value: string) {
	return value.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

function renderJob(job: JobRecord) {
	const lines = [
		`Job: ${job.id}`,
		`Status: ${job.status}`,
		`Mode: ${job.mode}`,
		`Created: ${job.createdAt}`,
		`Updated: ${job.updatedAt}`,
		`Question: ${job.question}`,
	];
	if (job.pid) lines.push(`PID: ${job.pid}`);
	if (job.sessionId) lines.push(`Claude session: ${job.sessionId}`);
	if (job.totalCostUsd !== undefined) lines.push(`Cost: $${job.totalCostUsd}`);
	if (job.durationMs !== undefined) lines.push(`Duration: ${job.durationMs}ms`);
	if (job.summary) lines.push(`Summary: ${job.summary}`);
	if (job.error) lines.push(`Error: ${job.error}`);
	lines.push(`Stdout: ${resolveJobStdoutFile(job.id)}`);
	lines.push(`Stderr: ${resolveJobStderrFile(job.id)}`);
	if (existsSync(resolveJobResultFile(job.id))) {
		lines.push(`Stored result: ${resolveJobResultFile(job.id)}`);
	}
	return lines.join('\n');
}

function printHelp() {
	console.log(`Usage:
  bun run claude:consult -- --question "What is risky in this diff?"
  git diff -- src/foo.ts | bun run claude:consult -- --mode review --question "Find behavioral bugs only"
  bun run claude:consult -- start --question "Review this diff"
  bun run claude:consult -- status [job-id]
  bun run claude:consult -- result [job-id]
  bun run claude:consult -- cancel <job-id>

Options:
  --question, -q <text>    Required concrete consult question
  --mode <mode>            review | design | tests | docs (default: review)
  --context, -c <path>     Add a file as context, repeatable
  --budget-usd <amount>    Claude Code max spend cap in USD (default: ${defaultBudgetUsd}, min: 1)
  --max-turns <count>      Optional Claude Code max turns
  --timeout-ms <count>     Kill Claude after this many ms (sync default: ${defaultSyncTimeoutMs}, background default: ${defaultJobTimeoutMs})
  --bare                   Skip ambient Claude Code config. Requires auth that works in bare mode.
  --read-files             Let Claude use Read, Grep, and Glob
`);
}

function fail(message: string): never {
	console.error(message);
	process.exit(1);
}

if (import.meta.main) {
	await main(Bun.argv.slice(2));
}
