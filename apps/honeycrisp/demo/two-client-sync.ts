/**
 * Two independent browser replicas converging through one authority.
 *
 * This is the runnable proof of ADR-0177: a browser replica is owned by the
 * storage partition the user agent resolves for a document paired with that
 * document's origin. The demo holds the origin fixed and varies only the
 * partition, so the two facts it prints are the two halves of that invariant:
 *
 *   same partition, same origin -> the second document is REFUSED
 *   other partition, same origin -> the second document is ADMITTED, and the
 *                                   two replicas converge only through the
 *                                   authority
 *
 * Two isolated browser profiles are how this run obtains a second partition.
 * That is a proof recipe, not the architecture; nothing here is a supported
 * deployment topology.
 *
 * Development exercises the production contract exactly: the pages talk to the
 * authority over its real origin, so real CORS, the real bearer, and the real
 * ETag revision headers are all in play. There is no proxy and no same-origin
 * `/api` facade, and the run fails if any request takes one.
 *
 *   bun run --cwd apps/honeycrisp demo:two-client
 *
 * Everything it writes (instance data, browser profiles) lives in a temporary
 * directory that is removed on success.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateInstanceToken } from '@epicenter/auth';
import { APPS } from '@epicenter/constants/apps';
import { type BrowserContext, chromium, type Page } from 'playwright';

const repoRoot = resolve(import.meta.dirname, '../../..');
const authorityPort = Number(process.env.DEMO_AUTHORITY_PORT ?? 8791);
const authority = `http://localhost:${authorityPort}`;
const origin = `http://localhost:${APPS.HONEYCRISP.port}`;
const token = generateInstanceToken();
const workDir = mkdtempSync(join(tmpdir(), 'honeycrisp-two-client-'));

/** Every authority response either client saw, for the direct-path assertions. */
const wire: {
	client: string;
	method: string;
	url: string;
	status: number;
	allowOrigin: string | undefined;
	etag: string | undefined;
}[] = [];

const failures: string[] = [];

const refusalMessage =
	'Browser Epicenter is already open in another tab for this origin';

function check(condition: boolean, description: string): void {
	if (condition) {
		process.stdout.write(`  ok    ${description}\n`);
		return;
	}
	failures.push(description);
	process.stdout.write(`  FAIL  ${description}\n`);
}

/**
 * Report a step that proved itself by completing: {@link observe} throws when an
 * edit never arrives, so reaching this line IS the result. Kept separate from
 * {@link check} so nothing prints `ok` for a condition no one evaluated.
 */
function report(description: string): void {
	process.stdout.write(`  ok    ${description}\n`);
}

function startProcess(
	name: string,
	command: string[],
	env: Record<string, string>,
): { kill(): void } {
	const child = spawn(command[0] as string, command.slice(1), {
		cwd: repoRoot,
		env: { ...process.env, ...env },
		stdio: 'pipe',
	});
	child.stderr.on('data', (chunk: Buffer) => {
		process.stderr.write(`[${name}] ${chunk.toString()}`);
	});
	return { kill: () => child.kill('SIGTERM') };
}

async function waitForHttp(url: string, label: string): Promise<void> {
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		try {
			await fetch(url);
			return;
		} catch {
			await new Promise((settle) => setTimeout(settle, 250));
		}
	}
	throw new Error(`${label} did not come up at ${url}`);
}

/**
 * Open one client in its own persistent profile, which is what gives it its own
 * storage partition. The instance setting is seeded before any script runs so
 * the app boots straight against the disposable authority.
 */
async function openClient(
	name: string,
	profileDir: string,
): Promise<{ context: BrowserContext; page: Page }> {
	const context = await chromium.launchPersistentContext(profileDir, {
		headless: true,
	});
	await context.addInitScript(
		({ baseURL, bearer }) => {
			localStorage.setItem(
				'honeycrisp.instance',
				JSON.stringify({ baseURL, token: bearer }),
			);
		},
		{ baseURL: authority, bearer: token },
	);
	const page = await context.newPage();
	page.on('response', (response) => {
		const url = response.url();
		if (!url.startsWith(authority) && !url.startsWith(`${origin}/api`)) return;
		wire.push({
			client: name,
			method: response.request().method(),
			url,
			status: response.status(),
			allowOrigin: response.headers()['access-control-allow-origin'],
			etag: response.headers().etag,
		});
	});
	await page.goto(origin, { waitUntil: 'networkidle' });
	await page.waitForTimeout(2_500);
	return { context, page };
}

async function writeNote(page: Page, text: string): Promise<void> {
	await page.locator('button:has(svg.lucide-plus.size-4)').last().click();
	await page.waitForTimeout(1_200);
	const editor = page.locator('[contenteditable="true"]').first();
	await editor.click();
	await editor.pressSequentially(text, { delay: 12 });
	// Blur so the note row's title and preview settle (ADR-0110).
	await page.locator('body').click({ position: { x: 5, y: 5 } });
	await page.waitForTimeout(1_500);
}

/** Wait for a peer's edit to arrive through this client's normal pull policy. */
async function observe(page: Page, text: string): Promise<number> {
	const started = Date.now();
	while (Date.now() - started < 60_000) {
		const body = await page.evaluate(() => document.body.innerText);
		if (body.includes(text)) return Date.now() - started;
		await new Promise((settle) => setTimeout(settle, 500));
	}
	throw new Error(`Timed out waiting for '${text}' to arrive`);
}

const instance = startProcess(
	'authority',
	['bun', 'apps/self-host/server.ts'],
	{
		INSTANCE_TOKEN: token,
		PORT: String(authorityPort),
		DATA_DIR: join(workDir, 'authority-data'),
		// The one exact origin the authority trusts. Production sets the same var.
		TRUSTED_BROWSER_ORIGINS: origin,
	},
);
const ui = startProcess(
	'honeycrisp',
	[
		'bun',
		'run',
		'--cwd',
		'apps/honeycrisp',
		'dev:web',
		'--port',
		String(APPS.HONEYCRISP.port),
		'--strictPort',
	],
	{},
);

let exitCode = 0;
try {
	await waitForHttp(`${authority}/api/session`, 'self-host authority');
	await waitForHttp(origin, 'Honeycrisp origin');
	process.stdout.write(
		`\nauthority ${authority}\norigin    ${origin}\nprofiles  ${workDir}\n\n`,
	);

	const profileA = join(workDir, 'profile-a');
	const profileB = join(workDir, 'profile-b');
	const clientA = await openClient('A', profileA);
	const clientB = await openClient('B', profileB);

	process.stdout.write('storage-partition ownership\n');
	// A different partition on the SAME origin must be admitted, not refused.
	const admitted = await clientB.page.evaluate(() => document.body.innerText);
	check(
		!admitted.includes(refusalMessage),
		'a second partition on one origin is admitted while the first is open',
	);

	// Same partition as A, same origin: the Web Lock must refuse this document.
	const sameProfileTab = await clientA.context.newPage();
	await sameProfileTab.goto(origin, { waitUntil: 'domcontentloaded' });
	await sameProfileTab.waitForTimeout(4_000);
	const refusal = await sameProfileTab.evaluate(() => document.body.innerText);
	check(
		refusal.includes(refusalMessage),
		'a second tab in one partition is refused immediately',
	);
	await sameProfileTab.close();

	process.stdout.write('\nconvergence through the authority\n');
	const stamp = Date.now().toString(36).toUpperCase();
	const noteFromA = `FROM-A-${stamp}`;
	await writeNote(clientA.page, noteFromA);
	const observedInB = await observe(clientB.page, noteFromA);
	report(`B observed A's edit in ${observedInB}ms`);

	const noteFromB = `FROM-B-${stamp}`;
	await writeNote(clientB.page, noteFromB);
	const observedInA = await observe(clientA.page, noteFromB);
	report(`A observed B's edit in ${observedInA}ms`);

	// Close B, write while it is gone, reopen the SAME profile: it must catch up.
	await clientB.context.close();
	const noteWhileClosed = `WHILE-CLOSED-${stamp}`;
	await writeNote(clientA.page, noteWhileClosed);
	const reopenedB = await openClient('B', profileB);
	const caughtUp = await observe(reopenedB.page, noteWhileClosed);
	report(`a reopened partition caught up in ${caughtUp}ms`);

	process.stdout.write('\ndirect authority path\n');
	const proxied = wire.filter((entry) => entry.url.startsWith(`${origin}/api`));
	check(
		proxied.length === 0,
		`no request went through the Vite origin (${proxied.length} seen)`,
	);
	check(
		wire.length > 0 && wire.every((entry) => entry.allowOrigin === origin),
		`every authority response allowed exactly ${origin} (${wire.length} responses)`,
	);
	const withEtag = wire.filter((entry) => entry.etag !== undefined);
	check(
		withEtag.length > 0,
		`ETag revision headers exercised (${withEtag.length})`,
	);
	check(
		wire.every((entry) => entry.status !== 401 && entry.status !== 403),
		'the instance bearer authenticated every request',
	);

	await clientA.context.close();
	await reopenedB.context.close();
} catch (cause) {
	failures.push(cause instanceof Error ? cause.message : String(cause));
	process.stderr.write(`\n${cause instanceof Error ? cause.stack : cause}\n`);
} finally {
	instance.kill();
	ui.kill();
	if (failures.length === 0) {
		rmSync(workDir, { recursive: true, force: true });
	} else {
		exitCode = 1;
		process.stderr.write(
			`\n${failures.length} check(s) failed; kept ${workDir}\n`,
		);
	}
}

process.stdout.write(
	failures.length === 0
		? '\ntwo-client demo: passed\n'
		: '\ntwo-client demo: FAILED\n',
);
process.exit(exitCode);
