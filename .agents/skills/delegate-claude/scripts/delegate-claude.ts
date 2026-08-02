#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const POLL_INTERVAL_MS = 30_000;
const HEARTBEAT_MS = 60_000;
const CLAUDE_BIN = process.env.DELEGATE_CLAUDE_BIN ?? 'claude';

/**
 * Publication commands a delegated session can never reach. Deny rules outrank
 * `auto` permission mode. Cover common direct and option-prefixed forms. This
 * is a command guard, not a shell or network sandbox.
 */
export const PUBLICATION_DENY_RULES = [
	'Bash(git push)',
	'Bash(git push:*)',
	'Bash(git * push)',
	'Bash(git * push:*)',
	'Bash(command git push)',
	'Bash(command git push:*)',
	'Bash(command git * push)',
	'Bash(command git * push:*)',
	'Bash(gh pr create)',
	'Bash(gh pr create:*)',
	'Bash(gh * pr create)',
	'Bash(gh * pr create:*)',
	'Bash(gh pr merge)',
	'Bash(gh pr merge:*)',
	'Bash(gh * pr merge)',
	'Bash(gh * pr merge:*)',
].join(',');

/**
 * Every background session already carries a standing instruction to commit,
 * push, and open a draft pull request without stopping to ask. Invitation prose
 * loses to it, so the refusal has to arrive at the same altitude.
 */
export const NO_PUBLICATION_PROMPT =
	'This session may commit locally in its worktree. It must not push, open or merge a pull request, deploy, or perform another external write. Report work and requested external actions to the calling session. Publication requires separate user authorization.';

/**
 * Applied to every launch and every resume, with no flag that lifts it.
 * The launcher never grants publication authority, so it cannot be forgotten
 * or accidentally inherited on a resumed session.
 *
 * Placed ahead of every other flag: `--disallowed-tools` is variadic, so it
 * swallows following arguments, including the invitation itself, until it reaches
 * the next flag.
 */
const PUBLICATION_GUARD_ARGS = [
	'--disallowed-tools',
	PUBLICATION_DENY_RULES,
	'--append-system-prompt',
	NO_PUBLICATION_PROMPT,
];

type AgentRecord = {
	id?: string;
	sessionId?: string;
	name?: string;
	kind: 'background' | 'interactive';
	cwd: string;
	startedAt: number;
	state?: 'working' | 'blocked' | 'done' | 'failed' | 'stopped';
	status?: string;
	waitingFor?: string;
};

type WatchOutcome = 'working' | 'blocked' | 'done' | 'failed' | 'stopped';

const EXIT_CODE = {
	failed: 1,
	usage: 2,
	missing: 3,
	statusFailure: 4,
	blocked: 10,
} as const;

function usage() {
	console.error(`Usage:
  delegate-claude.ts start [--name <name>]
  delegate-claude.ts status <id>
  delegate-claude.ts watch <id>
  delegate-claude.ts continue <id> [--interrupt]

Common direct forms of \`git push\`, \`gh pr create\`, and \`gh pr merge\` are
denied on every launch and resume, and no flag grants them. This guard is not a
shell or network sandbox. Other external writes remain outside the user's request
and require separate user authorization after appropriate verification.`);
}

/**
 * There is deliberately no flag here that widens authority. An unknown flag is
 * rejected rather than ignored, so a caller reaching for one that used to
 * exist gets a usage error instead of a silent no-op.
 */
export function parseStartArgs(args: string[]) {
	let name: string | undefined;

	for (let index = 0; index < args.length; index += 1) {
		// A name is never allowed to look like a flag: `--name --something` is a
		// typo, not a session called that.
		if (
			args[index] === '--name' &&
			args[index + 1] &&
			!args[index + 1].startsWith('--') &&
			name === undefined
		) {
			name = args[index + 1];
			index += 1;
			continue;
		}
		return undefined;
	}

	return { name: name ?? `codex-delegate-${Date.now().toString(36)}` };
}

export function parseContinueArgs(args: string[]) {
	const [id, ...flags] = args;
	if (!id || id.startsWith('--')) return undefined;

	let interrupt = false;
	for (const flag of flags) {
		if (flag !== '--interrupt' || interrupt) return undefined;
		interrupt = true;
	}

	return { id, interrupt };
}

function refuseNestedDelegation() {
	if (process.env.CLAUDECODE !== '1') return false;
	console.error(
		'[delegate-claude] Refusing reciprocal or nested Claude delegation.',
	);
	process.exitCode = EXIT_CODE.usage;
	return true;
}

async function readInvitation() {
	const rawTerminal = process.stdin.isTTY;
	if (rawTerminal) process.stdin.setRawMode(true);

	const chunks: Buffer[] = [];
	try {
		for await (const chunk of process.stdin) {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			if (!rawTerminal) {
				chunks.push(buffer);
				continue;
			}

			const eotIndex = buffer.indexOf(0x04);
			if (eotIndex === -1) {
				chunks.push(buffer);
				continue;
			}

			chunks.push(buffer.subarray(0, eotIndex));
			break;
		}
	} finally {
		if (rawTerminal) process.stdin.setRawMode(false);
	}

	return Buffer.concat(chunks).toString('utf8');
}

export function parseBackgroundId(output: string) {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI color codes from the launch line
	const plain = output.replace(/\u001B\[[0-9;]*m/g, '');
	return plain.match(/backgrounded\s+·\s+([0-9a-f]{8})\b/i)?.[1];
}

export function findLaunchedByName(
	agents: AgentRecord[],
	name: string,
	launchedAt: number,
) {
	return agents
		.filter(
			(agent) =>
				agent.kind === 'background' &&
				agent.name === name &&
				agent.id &&
				agent.startedAt >= launchedAt - 5_000,
		)
		.sort((a, b) => b.startedAt - a.startedAt)[0];
}

export function findAgent(agents: AgentRecord[], id: string) {
	return agents.find(
		(agent) =>
			agent.id === id ||
			agent.sessionId === id ||
			agent.sessionId?.startsWith(`${id}-`),
	);
}

export function classifyAgent(agent: AgentRecord): WatchOutcome {
	if (agent.state === 'done') return 'done';
	if (agent.state === 'failed') return 'failed';
	if (agent.state === 'stopped') return 'stopped';
	if (
		agent.state === 'blocked' ||
		agent.status === 'waiting' ||
		agent.waitingFor
	) {
		return 'blocked';
	}
	return 'working';
}

function runClaude(args: string[]) {
	return spawnSync(CLAUDE_BIN, args, {
		cwd: process.cwd(),
		encoding: 'utf8',
		env: process.env,
	});
}

function listAgents() {
	const result = runClaude(['agents', '--json', '--all']);
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(
			result.stderr.trim() || `claude agents exited ${result.status}`,
		);
	}

	return JSON.parse(result.stdout) as AgentRecord[];
}

function getAgent(id: string) {
	return findAgent(listAgents(), id);
}

function printAgent(agent: AgentRecord, outcome: WatchOutcome) {
	console.error(
		`[delegate-claude] ${agent.id ?? agent.sessionId}: ${outcome}${
			agent.waitingFor ? ` (${agent.waitingFor})` : ''
		}`,
	);
	console.log(JSON.stringify(agent, null, 2));
}

async function start(args: string[]) {
	if (refuseNestedDelegation()) return;

	const options = parseStartArgs(args);
	if (!options) {
		usage();
		process.exitCode = EXIT_CODE.usage;
		return;
	}

	const invitation = await readInvitation();
	if (!invitation.trim()) {
		console.error('[delegate-claude] Invitation is empty.');
		process.exitCode = EXIT_CODE.usage;
		return;
	}

	const launchedAt = Date.now();
	const result = runClaude([
		'--bg',
		...PUBLICATION_GUARD_ARGS,
		'--effort',
		'high',
		'--permission-mode',
		'auto',
		'--name',
		options.name,
		invitation,
	]);
	reportPublicationGuard();
	reportLaunchedJob(result, options.name, launchedAt);
}

function reportPublicationGuard() {
	console.error(
		'[delegate-claude] Direct git push, gh pr create, and gh pr merge commands are denied. Other external writes still require separate user authorization.',
	);
}

function reportLaunchedJob(
	result: ReturnType<typeof runClaude>,
	fallbackName: string | undefined,
	launchedAt: number,
) {
	if (result.stdout) process.stdout.write(result.stdout);
	if (result.stderr) process.stderr.write(result.stderr);
	if (result.error) throw result.error;
	if (result.status !== 0) {
		process.exitCode = result.status ?? EXIT_CODE.failed;
		return;
	}

	// The launch line is research-preview CLI output. When it changes shape,
	// recover the ID from the agent roster by the session's display name.
	const id =
		parseBackgroundId(result.stdout) ??
		(fallbackName
			? findLaunchedByName(listAgents(), fallbackName, launchedAt)?.id
			: undefined);
	if (!id) {
		console.error(
			`[delegate-claude] Claude accepted the launch but no job ID was found; inspect \`claude agents\`${
				fallbackName ? ` for a session named ${fallbackName}` : ''
			}.`,
		);
		process.exitCode = EXIT_CODE.failed;
		return;
	}

	console.log(`DELEGATE_CLAUDE_JOB_ID=${id}`);
}

async function continueTask(args: string[]) {
	if (refuseNestedDelegation()) return;

	const options = parseContinueArgs(args);
	if (!options) {
		usage();
		process.exitCode = EXIT_CODE.usage;
		return;
	}
	const { id } = options;

	const agent = getAgent(id);
	if (!agent) {
		console.error(`[delegate-claude] No Claude job found for ${id}.`);
		process.exitCode = EXIT_CODE.missing;
		return;
	}
	if (!agent.sessionId) {
		console.error(`[delegate-claude] ${id} has no session ID to resume.`);
		process.exitCode = EXIT_CODE.failed;
		return;
	}

	const continuation = await readInvitation();
	if (!continuation.trim()) {
		console.error('[delegate-claude] Continuation is empty.');
		process.exitCode = EXIT_CODE.usage;
		return;
	}

	// Resuming spawns a fresh worker for the same conversation, so the old
	// process must be gone first. Tolerate stop failures only when the job is
	// already terminal.
	const outcome = classifyAgent(agent);
	if (outcome === 'working' && !options.interrupt) {
		console.error(
			`[delegate-claude] ${id} is still working; continuing would discard the turn in flight. Read \`claude logs ${id}\` first, then pass --interrupt to stop it deliberately.`,
		);
		process.exitCode = EXIT_CODE.usage;
		return;
	}
	if (outcome !== 'stopped') {
		const stopped = runClaude(['stop', id]);
		if (stopped.error) throw stopped.error;
		if (
			stopped.status !== 0 &&
			(outcome === 'working' || outcome === 'blocked')
		) {
			console.error(
				stopped.stderr.trim() ||
					`[delegate-claude] Could not stop ${id} before replying.`,
			);
			process.exitCode = EXIT_CODE.failed;
			return;
		}
	}

	// Resume does not inherit the launch flags, so the guard is reapplied here
	// or it is silently gone for the rest of the conversation.
	const launchedAt = Date.now();
	const result = runClaude([
		'--bg',
		...PUBLICATION_GUARD_ARGS,
		'--resume',
		agent.sessionId,
		continuation,
	]);
	reportPublicationGuard();
	reportLaunchedJob(result, agent.name, launchedAt);
}

function status(id: string) {
	const agent = getAgent(id);
	if (!agent) {
		console.error(`[delegate-claude] No Claude job found for ${id}.`);
		process.exitCode = EXIT_CODE.missing;
		return;
	}
	printAgent(agent, classifyAgent(agent));
}

async function watch(id: string) {
	let lastSignature: string | undefined;
	let lastHeartbeat = 0;
	let consecutiveFailures = 0;

	while (true) {
		try {
			const agent = getAgent(id);
			if (!agent) {
				console.error(`[delegate-claude] No Claude job found for ${id}.`);
				process.exitCode = EXIT_CODE.missing;
				return;
			}

			consecutiveFailures = 0;
			const outcome = classifyAgent(agent);
			const signature = JSON.stringify({
				state: agent.state,
				status: agent.status,
				waitingFor: agent.waitingFor,
			});
			const now = Date.now();
			if (signature !== lastSignature || now - lastHeartbeat >= HEARTBEAT_MS) {
				printAgent(agent, outcome);
				lastSignature = signature;
				lastHeartbeat = now;
			}

			if (outcome === 'done') return;
			if (outcome === 'blocked') {
				process.exitCode = EXIT_CODE.blocked;
				return;
			}
			if (outcome === 'failed' || outcome === 'stopped') {
				process.exitCode = EXIT_CODE.failed;
				return;
			}
		} catch (error) {
			consecutiveFailures += 1;
			console.error(
				`[delegate-claude] Status check ${consecutiveFailures} failed: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			if (consecutiveFailures >= 3) {
				process.exitCode = EXIT_CODE.statusFailure;
				return;
			}
		}

		await delay(POLL_INTERVAL_MS);
	}
}

async function main() {
	const [command, ...args] = process.argv.slice(2);
	if (command === 'start') return start(args);
	if (command === 'status' && args.length === 1) return status(args[0]);
	if (command === 'watch' && args.length === 1) return watch(args[0]);
	if (command === 'continue') return continueTask(args);

	usage();
	process.exitCode = EXIT_CODE.usage;
}

if (import.meta.main) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = EXIT_CODE.failed;
	});
}
