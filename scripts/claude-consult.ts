#!/usr/bin/env bun

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

type ClaudeEnvelope = {
	errors?: unknown;
	is_error?: boolean;
	result?: unknown;
};

const defaultBudgetUsd = 25;

function parseArgs(argv: string[]) {
	const options = {
		mode: 'review' as ConsultMode,
		question: '',
		context: [] as string[],
		budgetUsd: defaultBudgetUsd,
		maxTurns: undefined as number | undefined,
		bare: false,
		readFiles: false,
	};

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

async function main() {
	const options = parseArgs(Bun.argv.slice(2));
	const stdin = await new Response(Bun.stdin.stream()).text();
	const contextText = await readContext(options.context);
	const prompt = buildPrompt(options, stdin.trim(), contextText);
	const args = [
		...(options.bare ? ['--bare'] : []),
		'-p',
		prompt,
		'--output-format',
		'json',
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

	const child = Bun.spawn(['claude', ...args], {
		stdout: 'pipe',
		stderr: 'pipe',
	});

	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);

	if (exitCode !== 0) {
		const envelope = parseClaudeEnvelope(stdout);
		printClaudeError(envelope);
		if (stderr.trim()) console.error(stderr.trim());
		if (stdout.trim() && typeof envelope.result !== 'string') {
			console.error(stdout.trim());
		}
		fail(`claude exited with status ${exitCode}`);
	}

	const envelope = parseClaudeEnvelope(stdout);
	if (envelope.is_error) {
		printClaudeError(envelope);
		fail('claude returned is_error=true');
	}

	if (typeof envelope.result !== 'string') {
		if (stdout.trim()) console.error(stdout.trim());
		fail('claude returned JSON without a string result');
	}

	console.log(envelope.result.trim());
}

function readValue(flag: string, value: string | undefined): string {
	if (!value || value.startsWith('-')) fail(`Missing value for ${flag}`);
	return value;
}

async function readContext(paths: string[]): Promise<string> {
	const blocks = await Promise.all(
		paths.map(async (path) => {
			const file = Bun.file(path);
			if (!(await file.exists())) fail(`Context file does not exist: ${path}`);
			const text = await file.text();
			return `### ${path}\n\n${text}`;
		}),
	);

	return blocks.join('\n\n');
}

function buildPrompt(
	options: ReturnType<typeof parseArgs>,
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

function printHelp() {
	console.log(`Usage:
  bun run claude:consult -- --question "What is risky in this diff?"
  git diff -- src/foo.ts | bun run claude:consult -- --mode review --question "Find behavioral bugs only"

Options:
  --question, -q <text>    Required concrete consult question
  --mode <mode>            review | design | tests | docs (default: review)
  --context, -c <path>     Add a file as context, repeatable
  --budget-usd <amount>    Claude Code max spend cap in USD (default: ${defaultBudgetUsd}, min: 1)
  --max-turns <count>      Optional Claude Code max turns
  --bare                   Skip ambient Claude Code config. Requires auth that works in bare mode.
  --read-files             Let Claude use Read, Grep, and Glob
`);
}

function fail(message: string): never {
	console.error(message);
	process.exit(1);
}

await main();
