#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cp, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

type RunRecord = {
	id: string;
	mission: string;
	nativeAgentId?: string;
	nativeSessionId?: string;
	sourcePath: string;
	replicaPath: string;
	snapshotId: string;
	checkpointPath: string;
	startedAt: string;
	continuedAt?: string;
};

type StartOptions = {
	name: string;
	wait: boolean;
	dryRun: boolean;
};

type FollowUpOptions = {
	id: string;
	wait: boolean;
};

const pollIntervalSeconds = 5;

function usage() {
	console.error('Usage: consult-claude.ts start [--name <name>] [--wait] [--dry-run]\n       consult-claude.ts follow-up <run-id> [--wait]\n       consult-claude.ts status <run-id>');
}

export function parseStartOptions(args: readonly string[]): StartOptions | undefined {
	let name: string | undefined;
	let wait = false;
	let dryRun = false;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === '--wait' && !wait) {
			wait = true;
			continue;
		}
		if (argument === '--dry-run' && !dryRun) {
			dryRun = true;
			continue;
		}
		if (argument === '--name' && name === undefined) {
			const candidate = args[index + 1];
			if (!candidate || candidate.startsWith('--')) return undefined;
			name = candidate;
			index += 1;
			continue;
		}
		return undefined;
	}
	return { name: name ?? `research-${Date.now().toString(36)}`, wait, dryRun };
}

export function parseNativeAgentId(output: string) {
	return output.match(/^backgrounded\s+·\s+(\S+)$/m)?.[1];
}

export function parseFollowUpOptions(args: readonly string[]): FollowUpOptions | undefined {
	const [id, ...options] = args;
	if (!id) return undefined;
	if (options.length === 0) return { id, wait: false };
	if (options.length === 1 && options[0] === '--wait') return { id, wait: true };
	return undefined;
}

function run(command: string, args: readonly string[], cwd?: string) {
	const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(result.stderr.trim() || `${command} exited ${result.status}`);
	return result.stdout;
}

function stateRoot() {
	return process.env.CLAUDE_RESEARCH_ROOT ?? join(homedir(), '.cache', 'codex-claude-research');
}

function safeName(name: string) {
	const normalized = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
	if (!normalized) throw new Error('Run name must contain a letter or number.');
	return normalized;
}

async function readMission() {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	const mission = Buffer.concat(chunks).toString('utf8').trim();
	if (!mission) throw new Error('Research brief is empty.');
	return mission;
}

async function copyUntracked(sourcePath: string, replicaPath: string, paths: readonly string[]) {
	for (const path of paths) {
		if (path.startsWith('../') || path.startsWith('/')) throw new Error(`Unsafe untracked path from git: ${path}`);
		const source = join(sourcePath, path);
		const destination = join(replicaPath, path);
		await mkdir(dirname(destination), { recursive: true });
		await cp(source, destination, { dereference: false, preserveTimestamps: true });
	}
}

async function untrackedHash(sourcePath: string, paths: readonly string[]) {
	const hash = createHash('sha256');
	for (const path of paths) {
		const source = join(sourcePath, path);
		const details = await lstat(source);
		hash.update(path);
		hash.update(details.mode.toString());
		hash.update(await readFile(source));
	}
	return hash.digest('hex');
}

export async function createSnapshot(sourcePath: string, replicaPath: string) {
	const head = run('git', ['rev-parse', 'HEAD'], sourcePath).trim();
	const patch = run('git', ['diff', '--binary', 'HEAD'], sourcePath);
	const untracked = run('git', ['ls-files', '--others', '--exclude-standard', '-z'], sourcePath).split('\0').filter(Boolean);
	const snapshotId = createHash('sha256').update(head).update(patch).update(await untrackedHash(sourcePath, untracked)).digest('hex').slice(0, 16);
	await mkdir(dirname(replicaPath), { recursive: true });
	run('git', ['clone', '--no-local', sourcePath, replicaPath]);
	run('git', ['remote', 'remove', 'origin'], replicaPath);
	if (patch) {
		const patchPath = join(replicaPath, '.consult-claude.patch');
		await writeFile(patchPath, patch);
		try {
			run('git', ['apply', '--index', patchPath], replicaPath);
		} finally {
			await rm(patchPath, { force: true });
		}
	}
	await copyUntracked(sourcePath, replicaPath, untracked);
	return snapshotId;
}

function laboratoryPrompt(record: RunRecord) {
	return `Mission: ${record.mission}


You own an editable laboratory at ${record.replicaPath}, an independent

repository snapshot ${record.snapshotId}. Change files, write experiments,

create commits, and run tests there whenever doing so clarifies the work.

This laboratory is the only repository you may access. Codex alone owns the

living checkout and independently decides what, if anything, to recreate there.


Follow evidence rather than the starting framing. Prefer attempts to break your

current theory. Cite factual claims as path:line@${record.snapshotId}, explain

what would change your mind, and leave useful candidate changes in the lab.

WebSearch may inform research; direct fetches, shell network access, remotes,

and external actions are outside this consultation.


Write ${record.checkpointPath} whenever your theory changes, you need a Codex

decision, or the outcome is met. Start it with exactly one of:

state: working

state: needs-decision

state: complete


A needs-decision checkpoint is an invitation for Codex to continue this same

laboratory conversation. Stop only when the next useful step belongs in the

living checkout.`;
}

export function laboratorySettings() {
	return {
		permissions: {
			deny: ['Agent', 'AskUserQuestion', 'WebFetch'],
		},
		sandbox: {
			enabled: true,
			failIfUnavailable: true,
			allowUnsandboxedCommands: false,
			network: { allowedDomains: [], strictAllowlist: true },
		},
		// The runner already gives each background session its own sealed clone.
		worktree: { bgIsolation: 'none' },
	};
}

function agentFor(record: RunRecord) {
	return {
		'codex-laboratory': {
			description: 'Autonomous repository laboratory that cannot affect the living checkout.',
			prompt: laboratoryPrompt(record),
			tools: ['Bash', 'Read', 'Glob', 'Grep', 'Edit', 'Write', 'NotebookEdit', 'WebSearch'],
			disallowedTools: ['Agent', 'AskUserQuestion', 'WebFetch'],
			permissionMode: 'auto',
			effort: 'high',
		},
	};
}

async function writeRecord(record: RunRecord) {
	const runPath = dirname(record.replicaPath);
	await writeFile(join(runPath, 'run.json'), `${JSON.stringify(record, null, 2)}\n`);
	await writeFile(join(runPath, 'settings.json'), `${JSON.stringify(laboratorySettings(), null, 2)}\n`);
}

async function readRecord(id: string) {
	const normalized = safeName(id);
	if (normalized !== id) throw new Error('Run ID must be the exact ID printed by start.');
	return JSON.parse(await readFile(join(stateRoot(), normalized, 'run.json'), 'utf8')) as RunRecord;
}

async function assertNewRun(runPath: string, id: string) {
	try {
		await lstat(runPath);
		throw new Error(`Research run "${id}" already exists. Choose a new --name rather than replacing its evidence.`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
		throw error;
	}
}

async function printStatus(id: string) {
	const record = await readRecord(id);
	console.log(JSON.stringify(record, null, 2));
	try {
		console.log(await readFile(record.checkpointPath, 'utf8'));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		console.error('[consult-claude] No checkpoint yet. Inspect the native session with claude agents.');
	}
}

function nativeSessionIdFor(nativeAgentId: string) {
	try {
		const agents = JSON.parse(run('claude', ['agents', '--json', '--all'])) as Array<{ id?: unknown; sessionId?: unknown }>;
		const sessionId = agents.find((agent) => agent.id === nativeAgentId)?.sessionId;
		return typeof sessionId === 'string' ? sessionId : undefined;
	} catch {
		return undefined;
	}
}

function recordNativeSession(record: RunRecord, output: string) {
	record.nativeAgentId = parseNativeAgentId(output);
	record.nativeSessionId = record.nativeAgentId ? nativeSessionIdFor(record.nativeAgentId) : undefined;
}

function launchLaboratory(record: RunRecord, prompt: string, continuation?: string) {
	const launch = spawnSync('claude', [
		...(continuation ? ['--resume', continuation] : []),
		'--agent', 'codex-laboratory',
		'--agents', JSON.stringify(agentFor(record)),
		'--settings', join(dirname(record.replicaPath), 'settings.json'),
		'--strict-mcp-config',
		'--permission-mode', 'auto',
		'--bg', prompt,
	], { cwd: record.replicaPath, encoding: 'utf8' });
	if (launch.error) throw launch.error;
	if (launch.status !== 0) throw new Error(launch.stderr.trim() || `claude exited ${launch.status}`);
	return launch.stdout;
}

async function archiveTerminalCheckpoint(record: RunRecord) {
	const checkpoint = await readFile(record.checkpointPath, 'utf8');
	if (!/^state: (?:needs-decision|complete)$/m.test(checkpoint)) {
		throw new Error('Claude has not reached a decision checkpoint. Use claude agents to reply while the laboratory is working.');
	}
	const historyPath = join(dirname(record.checkpointPath), 'history', `checkpoint-${Date.now()}.md`);
	await mkdir(dirname(historyPath), { recursive: true });
	await writeFile(historyPath, checkpoint);
	await rm(record.checkpointPath);
}

function waitForTerminalCheckpoint(record: RunRecord) {
	while (true) {
		try {
			const checkpoint = readFileSync(record.checkpointPath, 'utf8');
			if (/^state: (?:needs-decision|complete)$/m.test(checkpoint)) {
				process.stdout.write(checkpoint);
				return;
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}
		run('sleep', [String(pollIntervalSeconds)]);
	}
}

async function start(options: StartOptions) {
	const mission = await readMission();
	const sourcePath = run('git', ['rev-parse', '--show-toplevel']).trim();
	const id = safeName(options.name);
	const runPath = join(stateRoot(), id);
	const replicaPath = join(runPath, 'replica');
	const checkpointPath = join(replicaPath, '.claude-research', 'checkpoint.md');
	const record: RunRecord = {
		id,
		mission,
		sourcePath,
		replicaPath,
		snapshotId: 'pending',
		checkpointPath,
		startedAt: new Date().toISOString(),
	};
	if (options.dryRun) {
		console.log(JSON.stringify({ ...record, settings: laboratorySettings() }, null, 2));
		return;
	}
	await assertNewRun(runPath, id);
	record.snapshotId = await createSnapshot(sourcePath, replicaPath);
	await mkdir(dirname(checkpointPath), { recursive: true });
	await writeRecord(record);
	const output = launchLaboratory(record, laboratoryPrompt(record));
	recordNativeSession(record, output);
	await writeRecord(record);
	process.stdout.write(output);
	console.log(`CONSULT_CLAUDE_RUN_ID=${record.id}`);
	if (record.nativeAgentId) console.log(`CONSULT_CLAUDE_NATIVE_AGENT_ID=${record.nativeAgentId}`);
	if (record.nativeSessionId) console.log(`CONSULT_CLAUDE_NATIVE_SESSION_ID=${record.nativeSessionId}`);
	console.log(`CONSULT_CLAUDE_CHECKPOINT=${record.checkpointPath}`);
	if (options.wait) await waitForTerminalCheckpoint(record);
}

async function followUp(options: FollowUpOptions) {
	const record = await readRecord(options.id);
	const message = await readMission();
	const sessionId = record.nativeSessionId ?? (record.nativeAgentId ? nativeSessionIdFor(record.nativeAgentId) : undefined);
	if (!sessionId) throw new Error('The native Claude session is no longer available. Start a new laboratory snapshot.');
	await archiveTerminalCheckpoint(record);
	const output = launchLaboratory(record, `Codex follow-up: ${message}\n\nContinue working in the same laboratory. Update the checkpoint when you next need a decision or complete the outcome.`, sessionId);
	record.continuedAt = new Date().toISOString();
	recordNativeSession(record, output);
	await writeRecord(record);
	process.stdout.write(output);
	console.log(`CONSULT_CLAUDE_RUN_ID=${record.id}`);
	if (record.nativeAgentId) console.log(`CONSULT_CLAUDE_NATIVE_AGENT_ID=${record.nativeAgentId}`);
	if (record.nativeSessionId) console.log(`CONSULT_CLAUDE_NATIVE_SESSION_ID=${record.nativeSessionId}`);
	console.log(`CONSULT_CLAUDE_CHECKPOINT=${record.checkpointPath}`);
	if (options.wait) await waitForTerminalCheckpoint(record);
}

async function main() {
	const [command, ...args] = process.argv.slice(2);
	if (command === 'start') {
		const options = parseStartOptions(args);
		if (!options) {
			usage();
			process.exitCode = 2;
			return;
		}
		await start(options);
		return;
	}
	if (command === 'follow-up') {
		const options = parseFollowUpOptions(args);
		if (!options) {
			usage();
			process.exitCode = 2;
			return;
		}
		await followUp(options);
		return;
	}
	if (command === 'status' && args.length === 1) {
		await printStatus(args[0]);
		return;
	}
	usage();
	process.exitCode = 2;
}

if (import.meta.main) {
	await main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
