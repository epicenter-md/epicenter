import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspectWorkspaceCandidate } from '../packages/workspace/src/sqlite/definition.js';
import {
	APPLICATION_GENERATION_LOCK_FORMAT,
	parseApplicationGenerationLock,
} from '../packages/workspace/src/sqlite/generation.js';

type Mode = 'check' | 'check-history' | 'write';

type Options =
	| {
			mode: 'check-history';
			base: string | undefined;
	  }
	| {
			mode: 'check' | 'write';
			lockPath: string;
			candidatePaths: string[];
			base: string | undefined;
	  };

function usage(message?: string): never {
	if (message) console.error(message);
	console.error(
		'Usage:\n  bun run scripts/check-application-generation-locks.ts --check-history [--base <full-commit-sha>]\n  bun run scripts/check-application-generation-locks.ts (--check | --write) --lock <path> --candidate <module> [--candidate <module> ...] [--base <full-commit-sha>]',
	);
	process.exit(1);
}

function parseArguments(argv: string[]): Options {
	let mode: Mode | undefined;
	let lockPath: string | undefined;
	let baseFlag: string | undefined;
	const candidatePaths: string[] = [];

	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		switch (argument) {
			case '--check':
			case '--check-history':
			case '--write': {
				const nextMode = argument.slice(2) as Mode;
				if (mode) usage('Choose exactly one mode.');
				mode = nextMode;
				break;
			}
			case '--lock': {
				if (lockPath) usage('Pass --lock exactly once.');
				lockPath = argv[++index];
				if (!lockPath) usage('--lock requires a path.');
				break;
			}
			case '--candidate': {
				const candidatePath = argv[++index];
				if (!candidatePath) usage('--candidate requires a module path.');
				candidatePaths.push(candidatePath);
				break;
			}
			case '--base': {
				if (baseFlag) usage('Pass --base at most once.');
				baseFlag = argv[++index];
				if (!baseFlag) usage('--base requires a full commit SHA.');
				break;
			}
			default:
				usage(`Unknown argument: ${argument}`);
		}
	}

	if (!mode) usage('Choose exactly one mode.');
	const baseEnvironment = process.env.GENERATION_LOCK_BASE;
	if (baseFlag && baseEnvironment && baseFlag !== baseEnvironment) {
		usage('--base and GENERATION_LOCK_BASE disagree.');
	}

	const base = baseFlag ?? baseEnvironment;
	if (process.env.CI && !base) {
		usage('CI requires --base or GENERATION_LOCK_BASE.');
	}
	if (mode === 'check-history') {
		if (lockPath || candidatePaths.length > 0) {
			usage('--check-history does not accept --lock or --candidate.');
		}
		return { mode, base };
	}
	if (!lockPath) usage('Pass one --lock path.');
	if (candidatePaths.length === 0) {
		usage('Pass at least one explicit --candidate module path.');
	}
	return { mode, lockPath, candidatePaths, base };
}

function hasExactKeys(
	value: Record<string, unknown>,
	expected: string[],
): boolean {
	const actual = Object.keys(value).sort();
	return (
		actual.length === expected.length &&
		actual.every((key, index) => key === expected[index])
	);
}

function readLock(path: string) {
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(path, 'utf8'));
	} catch (error) {
		throw new Error(`Cannot read generation lock '${path}'.`, { cause: error });
	}
	return parseApplicationGenerationLock(value);
}

async function readCandidate(path: string) {
	const moduleUrl = pathToFileURL(resolve(path)).href;
	const candidateModule = (await import(moduleUrl)) as Record<string, unknown>;
	if (!hasExactKeys(candidateModule, ['workspaceCandidate'])) {
		throw new Error(
			`Candidate module '${path}' must export only workspaceCandidate.`,
		);
	}
	const candidate = inspectWorkspaceCandidate(
		candidateModule.workspaceCandidate,
	);
	const parsed = parseApplicationGenerationLock({
		format: APPLICATION_GENERATION_LOCK_FORMAT,
		appId: candidate.appId,
		generations: [candidate.proposedLockEntry],
	});
	const [entry] = parsed.generations;
	if (!entry) throw new Error(`Candidate module '${path}' has no generation.`);
	return { path, appId: parsed.appId, entry };
}

function git(cwd: string, args: string[]): string {
	return execFileSync('git', args, {
		cwd,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	}).trim();
}

function exactBaseSha(repoRoot: string, base: string): string {
	if (!/^[0-9a-f]{40}$/.test(base)) {
		throw new Error(
			`Generation lock base '${base}' must be an exact full commit SHA.`,
		);
	}
	let resolved: string;
	try {
		resolved = git(repoRoot, ['rev-parse', '--verify', `${base}^{commit}`]);
	} catch (error) {
		throw new Error(`Generation lock base '${base}' is unavailable.`, {
			cause: error,
		});
	}
	if (resolved !== base) {
		throw new Error(
			`Generation lock base '${base}' did not resolve to that exact commit.`,
		);
	}
	return base;
}

function repoPath(repoRoot: string, path: string): string {
	const pathFromRoot = relative(repoRoot, resolve(path));
	if (
		pathFromRoot === '..' ||
		pathFromRoot.startsWith(`..${sep}`) ||
		pathFromRoot === ''
	) {
		throw new Error(
			`Generation lock '${path}' must be inside the git repository.`,
		);
	}
	return pathFromRoot.split(sep).join('/');
}

function parseLockText(text: string, label: string) {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw new Error(`${label} is not valid JSON.`, { cause: error });
	}
	try {
		return parseApplicationGenerationLock(value);
	} catch (error) {
		throw new Error(`${label} is not a valid application generation lock.`, {
			cause: error,
		});
	}
}

function readBaseLock({
	repoRoot,
	base,
	path,
	appId,
}: {
	repoRoot: string;
	base: string;
	path: string;
	appId: string;
}) {
	try {
		const text = git(repoRoot, ['show', `${base}:${path}`]);
		return parseLockText(text, `Base generation lock '${path}'`);
	} catch (error) {
		if (
			error instanceof Error &&
			error.message.startsWith(`Base generation lock '${path}'`)
		) {
			throw error;
		}
	}

	let matches = '';
	try {
		matches = git(repoRoot, [
			'grep',
			'-l',
			'-F',
			APPLICATION_GENERATION_LOCK_FORMAT,
			base,
			'--',
			'*.json',
		]);
	} catch {
		return undefined;
	}
	for (const match of matches.split('\n').filter(Boolean)) {
		const oldPath = match.slice(`${base}:`.length);
		if (oldPath === path) continue;
		let oldLock: ReturnType<typeof parseApplicationGenerationLock>;
		try {
			oldLock = parseLockText(
				git(repoRoot, ['show', `${base}:${oldPath}`]),
				`Base generation lock '${oldPath}'`,
			);
		} catch {
			continue;
		}
		if (oldLock.appId === appId) {
			throw new Error(
				`Generation lock for app '${appId}' was renamed from '${oldPath}' to '${path}'. Published locks cannot be renamed.`,
			);
		}
	}
	return undefined;
}

function trackedFiles(repoRoot: string, revision?: string): string[] {
	return (
		revision
			? git(repoRoot, ['ls-tree', '-r', '--name-only', revision])
			: git(repoRoot, ['ls-files'])
	).split('\n');
}

function trackedGenerationLocks(repoRoot: string, revision?: string): string[] {
	return trackedFiles(repoRoot, revision).filter(
		(path) =>
			path === 'generation-lock.json' || path.endsWith('/generation-lock.json'),
	);
}

async function verifyTrackedSources(
	repoRoot: string,
	lockPath: string,
	lock: ReturnType<typeof parseApplicationGenerationLock>,
): Promise<void> {
	const lockDirectory = dirname(lockPath);
	const generationsDirectory =
		lockDirectory === '.'
			? 'src/generations'
			: `${lockDirectory}/src/generations`;
	const candidatePaths = trackedFiles(repoRoot).filter(
		(path) =>
			path.startsWith(`${generationsDirectory}/`) &&
			/^g[1-9][0-9]*\/workspace\.ts$/.test(
				path.slice(`${generationsDirectory}/`.length),
			),
	);
	if (candidatePaths.length === 0) {
		throw new Error(
			`Tracked generation lock '${lockPath}' has no tracked source candidates under '${generationsDirectory}/gN/workspace.ts'.`,
		);
	}
	const candidates = await Promise.all(
		candidatePaths.map((path) => readCandidate(resolve(repoRoot, path))),
	);
	for (const candidate of candidates) {
		const generation = candidate.entry.dataGeneration;
		const expectedPath = `${generationsDirectory}/g${generation}/workspace.ts`;
		const actualPath = repoPath(repoRoot, candidate.path);
		if (actualPath !== expectedPath) {
			throw new Error(
				`Candidate '${actualPath}' proposes data generation ${generation}; expected '${expectedPath}'.`,
			);
		}
	}
	const ordered = candidates.toSorted(
		(left, right) => left.entry.dataGeneration - right.entry.dataGeneration,
	);
	const appId = ordered[0]?.appId;
	if (!appId || ordered.some((candidate) => candidate.appId !== appId)) {
		throw new Error(`Source candidates for '${lockPath}' span multiple apps.`);
	}
	const sourceLock = parseApplicationGenerationLock({
		format: APPLICATION_GENERATION_LOCK_FORMAT,
		appId,
		generations: ordered.map(({ entry }) => entry),
	});
	if (!sameJson(sourceLock, lock)) {
		throw new Error(
			`Tracked generation lock '${lockPath}' does not exactly match its source candidates.`,
		);
	}
}

function sameJson(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function verifyBasePrefix(
	baseLock: ReturnType<typeof parseApplicationGenerationLock>,
	currentLock: ReturnType<typeof parseApplicationGenerationLock>,
): void {
	if (
		baseLock.format !== currentLock.format ||
		baseLock.appId !== currentLock.appId
	) {
		throw new Error('Published generation lock identity changed.');
	}
	if (currentLock.generations.length < baseLock.generations.length) {
		throw new Error('Published generation lock entries were removed.');
	}
	for (const [index, entry] of baseLock.generations.entries()) {
		if (!sameJson(entry, currentLock.generations[index])) {
			throw new Error(
				`Published generation lock entry ${index + 1} changed or moved.`,
			);
		}
	}
}

async function checkHistory(baseInput: string | undefined): Promise<void> {
	const repoRoot = git(process.cwd(), ['rev-parse', '--show-toplevel']);
	const currentPaths = trackedGenerationLocks(repoRoot);
	const currentLocks = new Map(
		currentPaths.map((path) => [path, readLock(resolve(repoRoot, path))]),
	);

	let base: string | undefined;
	if (baseInput) {
		base = exactBaseSha(repoRoot, baseInput);
		const basePaths = trackedGenerationLocks(repoRoot, base);
		const currentPathSet = new Set(currentPaths);
		for (const path of basePaths) {
			if (!currentPathSet.has(path)) {
				throw new Error(
					`Published generation lock '${path}' was deleted or renamed.`,
				);
			}
			const baseLock = parseLockText(
				git(repoRoot, ['show', `${base}:${path}`]),
				`Base generation lock '${path}'`,
			);
			const currentLock = currentLocks.get(path);
			if (!currentLock)
				throw new Error(`Generation lock '${path}' is unavailable.`);
			verifyBasePrefix(baseLock, currentLock);
		}
	}
	await Promise.all(
		[...currentLocks].map(([path, lock]) =>
			verifyTrackedSources(repoRoot, path, lock),
		),
	);
	console.log(
		base
			? `generation-locks: ${currentPaths.length} tracked lock(s) match sources and preserve base ${base}.`
			: `generation-locks: ${currentPaths.length} tracked lock(s) match sources; no base comparison requested.`,
	);
}

async function main(): Promise<void> {
	const options = parseArguments(process.argv.slice(2));
	if (options.mode === 'check-history') {
		await checkHistory(options.base);
		return;
	}
	const candidates = await Promise.all(
		options.candidatePaths.map(readCandidate),
	);
	const appId = candidates[0]?.appId;
	if (!appId || candidates.some((candidate) => candidate.appId !== appId)) {
		throw new Error('Every candidate must belong to the same application.');
	}

	const candidateLock = parseApplicationGenerationLock({
		format: APPLICATION_GENERATION_LOCK_FORMAT,
		appId,
		generations: candidates.map(({ entry }) => entry),
	});
	const currentLock =
		options.mode === 'write' && !existsSync(options.lockPath)
			? undefined
			: readLock(options.lockPath);
	if (currentLock && currentLock.appId !== appId) {
		throw new Error(
			`Generation lock app '${currentLock.appId}' does not match candidate app '${appId}'.`,
		);
	}

	if (options.base) {
		const repoRoot = git(process.cwd(), ['rev-parse', '--show-toplevel']);
		const base = exactBaseSha(repoRoot, options.base);
		const path = repoPath(repoRoot, options.lockPath);
		const baseLock = readBaseLock({ repoRoot, base, path, appId });
		if (baseLock) verifyBasePrefix(baseLock, currentLock ?? candidateLock);
	}

	const sharedLength = Math.min(
		currentLock?.generations.length ?? 0,
		candidateLock.generations.length,
	);
	for (let index = 0; index < sharedLength; index += 1) {
		if (
			!sameJson(
				currentLock?.generations[index],
				candidateLock.generations[index],
			)
		) {
			throw new Error(
				`Candidate for data generation ${candidateLock.generations[index]?.dataGeneration} drifted from the committed lock.`,
			);
		}
	}
	if (
		currentLock &&
		candidateLock.generations.length < currentLock.generations.length
	) {
		throw new Error('A candidate for a published generation is missing.');
	}

	const newEntries = candidateLock.generations.slice(
		currentLock?.generations.length ?? 0,
	);
	if (options.mode === 'check') {
		if (newEntries.length > 0) {
			throw new Error(
				`${newEntries.length} candidate generation(s) are not recorded in '${options.lockPath}'. Run with --write to append them.`,
			);
		}
		console.log(
			`generation-locks: ${appId} has ${currentLock?.generations.length ?? 0} locked generation(s); sources match.`,
		);
		return;
	}

	if (newEntries.length === 0) {
		console.log(`generation-locks: ${appId} is already current.`);
		return;
	}
	const nextLock = currentLock
		? parseApplicationGenerationLock({
				...currentLock,
				generations: [...currentLock.generations, ...newEntries],
			})
		: candidateLock;
	writeFileSync(options.lockPath, `${JSON.stringify(nextLock, null, '\t')}\n`);
	console.log(
		`generation-locks: appended ${newEntries.length} generation(s) to '${options.lockPath}'.`,
	);
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	});
}
