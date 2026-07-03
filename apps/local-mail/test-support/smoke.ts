/**
 * Headless, dependency-free smoke test for the Local Mail write path.
 *
 * One shot, no browser: it copies the mirror with forged creds, boots the mock
 * Gmail and `local-mail up` against the copy, exchanges a session bearer, fires
 * ONE real triage write through `/api/messages/modify`, and then proves two
 * things the way the manual browser loop does:
 *   1. the write reached the mock (a matching line lands in the modify log), and
 *   2. the REAL mirror's durable state is byte-identical before and after.
 *
 * It tears the mock and app down on the way out and exits non-zero on any
 * failure, so it doubles as a regression guard a future developer can just run:
 *
 *   bun run apps/local-mail/test-support/smoke.ts
 *
 * This is deliberately NOT wired into CI: it needs a real connected mirror to
 * copy from. It is a local proof, not a gate.
 */
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

const SCRIPT_DIR = import.meta.dir;
const APP_DIR = join(SCRIPT_DIR, '..');
const LM_TEST_DIR = process.env.LM_TEST_DIR ?? '/tmp/local-mail-harness';
const MOCK_LOG = join(LM_TEST_DIR, 'modify-log.jsonl');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run a command to completion and return its trimmed stdout, or throw. */
async function run(cmd: string[], env?: Record<string, string>): Promise<string> {
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

const cleanup: Array<() => void> = [];
function onExit() {
	for (const fn of cleanup.reverse()) {
		try {
			fn();
		} catch {
			// best-effort teardown
		}
	}
}

async function main(): Promise<void> {
	// 0. Fingerprint the real mirror BEFORE anything runs.
	const before = await run(['bash', join(SCRIPT_DIR, 'fingerprint.sh')]);

	// 1. Throwaway copy + forged creds.
	const setup = await run(['bash', join(SCRIPT_DIR, 'setup-copy.sh')], {
		LM_TEST_DIR,
	});
	const mockDb = setup.match(/^MOCK_DB (.+)$/m)?.[1];
	if (!mockDb) throw new Error(`setup-copy.sh did not print MOCK_DB:\n${setup}`);
	// Reset the modify log so the assertion only sees this run's writes.
	await Bun.write(MOCK_LOG, '');

	// 2. Mock Gmail on an ephemeral port.
	const mock = Bun.spawn(['bun', 'run', join(SCRIPT_DIR, 'mock-gmail.ts')], {
		env: { ...process.env, MOCK_PORT: '0', MOCK_DB: mockDb, MOCK_LOG },
		stdout: 'pipe',
		stderr: 'inherit',
	});
	cleanup.push(() => mock.kill());
	const mockPort = (
		await waitForLine(mock.stdout, /MOCK_READY (\d+)/, 10_000, 'mock ready')
	)[1];

	// 3. `local-mail up` against the copy + mock, ephemeral port.
	const app = Bun.spawn(['bun', 'run', join(APP_DIR, 'src', 'bin.ts'), 'up'], {
		env: {
			...process.env,
			LOCAL_MAIL_DIR: LM_TEST_DIR,
			LOCAL_MAIL_GMAIL_API_BASE: `http://127.0.0.1:${mockPort}`,
			LOCAL_MAIL_PORT: '0',
			LOCAL_MAIL_NO_OPEN: '1',
		},
		stdout: 'pipe',
		stderr: 'inherit',
	});
	cleanup.push(() => app.kill());
	const launch = await waitForLine(
		app.stdout,
		/http:\/\/127\.0\.0\.1:(\d+)\/#token=([A-Za-z0-9_-]+)/,
		15_000,
		'app launch URL',
	);
	const appOrigin = `http://127.0.0.1:${launch[1]}`;
	const bootstrapToken = launch[2];

	// 4. Exchange the single-use bootstrap for a session bearer.
	const sessionRes = await fetch(`${appOrigin}/api/session`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ token: bootstrapToken }),
	});
	const bearer = ((await sessionRes.json()) as { token?: string }).token;
	if (!bearer) throw new Error('session exchange returned no bearer');
	const auth = { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' };

	// 5. Pick a message and a real label change. Prefer archiving an inbox
	//    message; fall back to toggling STARRED on any message.
	const pick = async (query: string) =>
		((await (await fetch(`${appOrigin}/api/messages?${query}`, { headers: auth })).json()) as {
			messages: { id: string; labelIds: string[] }[];
		}).messages[0];
	let target = await pick('label=INBOX&limit=1');
	let addLabels: string[] = [];
	let removeLabels: string[] = ['INBOX'];
	if (!target) {
		target = await pick('limit=1');
		if (!target) throw new Error('the mirror copy has no messages to modify');
		const starred = target.labelIds.includes('STARRED');
		addLabels = starred ? [] : ['STARRED'];
		removeLabels = starred ? ['STARRED'] : [];
	}

	// 6. Fire the write through the exact route the SPA uses.
	const modifyRes = await fetch(`${appOrigin}/api/messages/modify`, {
		method: 'POST',
		headers: auth,
		body: JSON.stringify({ ids: [target.id], addLabels, removeLabels }),
	});
	const modifyBody = await modifyRes.json();
	if (!modifyRes.ok) {
		throw new Error(`modify failed: ${JSON.stringify(modifyBody)}`);
	}

	// 7. Prove the write reached the mock.
	await sleep(200);
	const logLines = readFileSync(MOCK_LOG, 'utf8').trim().split('\n').filter(Boolean);
	const logged = logLines
		.map((l) => JSON.parse(l) as { id: string; add: string[]; remove: string[] })
		.find((e) => e.id === target.id);
	if (!logged) {
		throw new Error(`no modify for ${target.id} in the mock log:\n${logLines.join('\n')}`);
	}

	// 8. Prove the real mirror is untouched.
	const after = await run(['bash', join(SCRIPT_DIR, 'fingerprint.sh')]);
	if (after !== before) {
		throw new Error(`REAL mirror changed!\nbefore:\n${before}\nafter:\n${after}`);
	}

	console.log('SMOKE PASS');
	console.log(`  wrote add=${JSON.stringify(addLabels)} remove=${JSON.stringify(removeLabels)} to ${target.id}`);
	console.log(`  mock logged: ${JSON.stringify(logged)}`);
	console.log(`  real mirror fingerprint unchanged (${before.split('\n').length} files)`);
}

try {
	await main();
	onExit();
	process.exit(0);
} catch (err) {
	console.error(`SMOKE FAIL: ${err instanceof Error ? err.message : String(err)}`);
	onExit();
	process.exit(1);
}
