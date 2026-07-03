/**
 * Shared boot for the Local Mail write harness. Both `smoke.ts` (headless API
 * driver) and `browser-smoke.ts` (Chrome driver) stand up the exact same safe
 * stack through here, so the safety-critical wiring lives in one place:
 *
 *   throwaway mirror copy (forged creds)  +  mock Gmail  +  `local-mail up`
 *
 * See ./README.md for the four independent safety guarantees.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SCRIPT_DIR = import.meta.dir;
const APP_DIR = join(SCRIPT_DIR, '..');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run a command to completion and return its trimmed stdout, or throw. */
export async function run(
	cmd: string[],
	env?: Record<string, string>,
): Promise<string> {
	const proc = Bun.spawn(cmd, {
		env: { ...process.env, ...env },
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) {
		throw new Error(`${cmd.join(' ')} exited ${code}:\n${err || out}`);
	}
	return out.trim();
}

/** Read a spawned process's stdout until `re` matches, or time out. */
async function waitForLine(
	stream: ReadableStream<Uint8Array>,
	re: RegExp,
	timeoutMs: number,
	what: string,
): Promise<RegExpMatchArray> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	const deadline = Date.now() + timeoutMs;
	try {
		while (Date.now() < deadline) {
			const chunk = await Promise.race([
				reader.read(),
				sleep(deadline - Date.now()).then(() => 'timeout' as const),
			]);
			if (chunk === 'timeout') break;
			if (chunk.done) break;
			buffer += decoder.decode(chunk.value, { stream: true });
			const match = buffer.match(re);
			if (match) return match;
		}
	} finally {
		reader.releaseLock();
	}
	throw new Error(`timed out waiting for ${what}; got:\n${buffer}`);
}

/** Hash the REAL mirror's durable state, for the before/after safety proof. */
export function fingerprintReal(): Promise<string> {
	return run(['bash', join(SCRIPT_DIR, 'fingerprint.sh')]);
}

export type BootedHarness = {
	/** e.g. `http://127.0.0.1:53142` (ephemeral). */
	appOrigin: string;
	/** Single-use bootstrap token for the URL fragment / session exchange. */
	bootstrapToken: string;
	/** Absolute path to the mock's modify JSONL log. */
	mockLog: string;
	/** Kill the mock and the app. Idempotent-ish; safe to call once. */
	teardown: () => void;
};

/**
 * Copy the mirror with forged creds, boot the mock (with the requested fold
 * mode) and `local-mail up` against the copy on ephemeral ports, and hand back
 * the launch coordinates. Never touches the real mirror or real Gmail.
 */
export async function bootHarness(opts: {
	/** `false` => modifies omit labelIds, exercising the `folded:false` chip. */
	fold: boolean;
	lmTestDir?: string;
}): Promise<BootedHarness> {
	const lmTestDir = opts.lmTestDir ?? process.env.LM_TEST_DIR ?? '/tmp/local-mail-harness';
	const mockLog = join(lmTestDir, 'modify-log.jsonl');

	const setup = await run(['bash', join(SCRIPT_DIR, 'setup-copy.sh')], {
		LM_TEST_DIR: lmTestDir,
	});
	const mockDb = setup.match(/^MOCK_DB (.+)$/m)?.[1];
	if (!mockDb) throw new Error(`setup-copy.sh did not print MOCK_DB:\n${setup}`);
	await Bun.write(mockLog, ''); // reset so assertions only see this run's writes

	const mock = Bun.spawn(['bun', 'run', join(SCRIPT_DIR, 'mock-gmail.ts')], {
		env: {
			...process.env,
			MOCK_PORT: '0',
			MOCK_DB: mockDb,
			MOCK_LOG: mockLog,
			MOCK_FOLD: opts.fold ? 'true' : 'false',
		},
		stdout: 'pipe',
		stderr: 'inherit',
	});
	const mockPort = (
		await waitForLine(mock.stdout, /MOCK_READY (\d+)/, 10_000, 'mock ready')
	)[1];

	const app = Bun.spawn(['bun', 'run', join(APP_DIR, 'src', 'bin.ts'), 'up'], {
		env: {
			...process.env,
			LOCAL_MAIL_DIR: lmTestDir,
			LOCAL_MAIL_GMAIL_API_BASE: `http://127.0.0.1:${mockPort}`,
			LOCAL_MAIL_PORT: '0',
			LOCAL_MAIL_NO_OPEN: '1',
		},
		stdout: 'pipe',
		stderr: 'inherit',
	});
	const launch = await waitForLine(
		app.stdout,
		/http:\/\/127\.0\.0\.1:(\d+)\/#token=([A-Za-z0-9_-]+)/,
		15_000,
		'app launch URL',
	);

	return {
		appOrigin: `http://127.0.0.1:${launch[1]}`,
		bootstrapToken: launch[2] as string,
		mockLog,
		teardown: () => {
			mock.kill();
			app.kill();
		},
	};
}

export type ModifyLogEntry = {
	id: string;
	add: string[];
	remove: string[];
	folded: boolean;
};

/** The modify entries the mock has logged so far, oldest first. */
export function readModifyLog(mockLog: string): ModifyLogEntry[] {
	if (!existsSync(mockLog)) return [];
	return readFileSync(mockLog, 'utf8')
		.trim()
		.split('\n')
		.filter(Boolean)
		.map((l) => JSON.parse(l) as ModifyLogEntry);
}
