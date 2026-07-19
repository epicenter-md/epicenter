#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const POLL_INTERVAL_MS = 30_000;
const HEARTBEAT_MS = 60_000;
const CLAUDE_BIN = process.env.DELEGATE_CLAUDE_BIN ?? 'claude';

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
  delegate-claude.ts reply <id>`);
}

function refuseNestedDelegation() {
	if (process.env.CLAUDECODE !== '1') return false;
	console.error(
		'[delegate-claude] Refusing reciprocal or nested Claude delegation.',
	);
	process.exitCode = EXIT_CODE.usage;
	return true;
}

async function readPacket() {
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

	let name = `codex-delegate-${Date.now().toString(36)}`;
	for (let index = 0; index < args.length; index += 1) {
		if (
			args[index] !== '--name' ||
			!args[index + 1] ||
			index + 2 !== args.length
		) {
			usage();
			process.exitCode = EXIT_CODE.usage;
			return;
		}
		name = args[index + 1];
		index += 1;
	}

	const packet = await readPacket();
	if (!packet.trim()) {
		console.error('[delegate-claude] Execution packet is empty.');
		process.exitCode = EXIT_CODE.usage;
		return;
	}

	const launchedAt = Date.now();
	const result = runClaude([
		'--bg',
		'--effort',
		'high',
		'--permission-mode',
		'auto',
		'--name',
		name,
		packet,
	]);
	reportLaunchedJob(result, name, launchedAt);
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
	// recover the ID from the supervisor roster by the session's display name.
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

async function reply(id: string) {
	if (refuseNestedDelegation()) return;

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

	const answer = await readPacket();
	if (!answer.trim()) {
		console.error('[delegate-claude] Reply is empty.');
		process.exitCode = EXIT_CODE.usage;
		return;
	}

	// Resuming spawns a fresh worker for the same conversation, so the old
	// process must be gone first. Tolerate stop failures only when the job is
	// already terminal.
	const outcome = classifyAgent(agent);
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

	const launchedAt = Date.now();
	const result = runClaude(['--bg', '--resume', agent.sessionId, answer]);
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
	if (command === 'reply' && args.length === 1) return reply(args[0]);

	usage();
	process.exitCode = EXIT_CODE.usage;
}

if (import.meta.main) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = EXIT_CODE.failed;
	});
}
