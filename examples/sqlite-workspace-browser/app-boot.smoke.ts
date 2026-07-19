/**
 * App boot gate smoke: `bun app-boot.smoke.ts honeycrisp|whispering`.
 *
 * Runs on WebKit by default (the Safari engine the physical iPhone gate
 * depends on; SMOKE_BROWSER=chromium overrides). Builds the app's
 * production static site, serves it with no isolation headers, blocks every
 * non-loopback request (offline-equivalent boot), and proves the app boots
 * signed-out Device mode through its WorkspaceGate to the real shell.
 *
 * For Honeycrisp it additionally proves the held-storage path end to end:
 * a raw worker holding the SAH-pool access handles (a suspended owner that
 * cannot hand off) yields the blocking held-storage screen instead of the
 * blank page the physical Safari check found, and the screen's own Try
 * again action recovers once the holder releases. Whispering shares the
 * identical gate component and boot contract, so its run checks the boot
 * path only.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type Browser,
	type BrowserContext,
	chromium,
	type Page,
	webkit,
} from 'playwright';

const HELD_TEXT = "Another window is using this app's storage";
const FAILURE_TEXTS = [HELD_TEXT, 'Failed to load workspace'];

const APPS = {
	honeycrisp: {
		dir: join(import.meta.dir, '../../apps/honeycrisp'),
		port: 5218,
		readySelector: 'input[placeholder="Search notes…"]',
		heldScenario: true,
	},
	whispering: {
		dir: join(import.meta.dir, '../../apps/whispering'),
		port: 5219,
		// The booted shell always renders interactive controls; pair with the
		// failure-text absence check below to prove the gate passed.
		readySelector: 'button',
		heldScenario: false,
	},
} as const;

const appName = process.argv[2] as keyof typeof APPS;
const app = APPS[appName];
if (!app) throw new Error('Usage: bun app-boot.smoke.ts honeycrisp|whispering');

const engineName =
	process.env.SMOKE_BROWSER === 'chromium' ? 'chromium' : 'webkit';
const engine = engineName === 'chromium' ? chromium : webkit;
const origin = `http://127.0.0.1:${app.port}`;

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const build = Bun.spawnSync(['bun', 'run', 'build'], {
	cwd: app.dir,
	stdout: 'inherit',
	stderr: 'inherit',
});
if (!build.success) throw new Error(`${appName} production build failed`);

const root = join(app.dir, 'build');
const server = Bun.serve({
	hostname: '127.0.0.1',
	port: app.port,
	async fetch(request) {
		const path = new URL(request.url).pathname;
		// A same-origin page that never boots the app, so a holder worker can
		// retain access handles without becoming a cooperative owner.
		if (path === '/holder') {
			return new Response('<!doctype html><title>holder</title>', {
				headers: { 'content-type': 'text/html' },
			});
		}
		const file = Bun.file(
			join(root, path === '/' ? 'index.html' : path.slice(1)),
		);
		if (await file.exists()) return new Response(file);
		return new Response(Bun.file(join(root, 'index.html')));
	},
});

async function assertBooted(page: Page): Promise<void> {
	await page.waitForSelector(app.readySelector);
	const text = await page.evaluate(() => document.body.innerText);
	for (const failure of FAILURE_TEXTS) {
		assert(
			!text.includes(failure),
			`boot landed on failure screen: ${failure}`,
		);
	}
}

let browser: Browser | undefined;
const pageErrors: string[] = [];
const watched: Page[] = [];
function watch(page: Page): Page {
	page.setDefaultTimeout(30_000);
	page.on('pageerror', (error) =>
		pageErrors.push(error.stack ?? error.message),
	);
	watched.push(page);
	return page;
}

const profile = mkdtempSync(join(tmpdir(), 'app-boot-profile-'));
let context: BrowserContext | undefined;
try {
	if (engineName === 'webkit') {
		// Playwright WebKit's ephemeral context has no OPFS (getDirectory
		// rejects with UnknownError); a persistent profile restores the real
		// Safari storage behavior the gate depends on.
		context = await engine.launchPersistentContext(profile, {
			headless: true,
		});
	} else {
		browser = await engine.launch({ headless: true });
		context = await browser.newContext();
	}
	// Block everything off-loopback: boot must not depend on any hosted API.
	// The pattern deliberately never matches loopback (or non-http schemes):
	// WebKit + Playwright interception breaks worker script loading, so
	// loopback traffic must stay entirely un-intercepted.
	await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.abort());

	process.stdout.write('step: boot\n');
	const first = watch(await context.newPage());
	await first.goto(origin);
	await assertBooted(first);
	// Close the booted owner so its handles release and the pool files exist.
	await first.close();

	if (app.heldScenario) {
		process.stdout.write('step: hold\n');
		const holder = await context.newPage();
		await holder.goto(`${origin}/holder`);
		const heldCount = await holder.evaluate(async () => {
			const worker = new Worker(
				URL.createObjectURL(
					new Blob(
						[
							`(async () => {
								try {
									const held = [];
									// The pool keeps its SAH files nested (an .opaque
									// subdirectory), so hold every file recursively.
									async function holdAll(dir) {
										for await (const [, entry] of dir) {
											if (entry.kind === 'directory') {
												await holdAll(entry);
												continue;
											}
											try {
												held.push(await entry.createSyncAccessHandle());
											} catch {}
										}
									}
									const root = await navigator.storage.getDirectory();
									for await (const [name, entry] of root) {
										if (entry.kind !== 'directory') continue;
										if (!name.startsWith('.epicenter-sahpool-')) continue;
										await holdAll(entry);
									}
									self.postMessage(held.length);
								} catch (cause) {
									self.postMessage('holder failed: ' + cause);
								}
							})();`,
						],
						{ type: 'text/javascript' },
					),
				),
			);
			return await new Promise((resolve) => {
				worker.onmessage = (event) => resolve(event.data);
				worker.onerror = (event) => resolve(`holder error: ${event.message}`);
			});
		});
		assert(
			typeof heldCount === 'number' && heldCount > 0,
			`holder acquired no access handles (${String(heldCount)})`,
		);

		process.stdout.write('step: held-screen\n');
		const blocked = watch(await context.newPage());
		await blocked.goto(origin);
		await blocked.getByText(HELD_TEXT).waitFor();

		process.stdout.write('step: retry\n');
		await holder.close();
		await blocked.getByRole('button', { name: 'Try again' }).click();
		await assertBooted(blocked);
		await blocked.close();
	}

	assert(pageErrors.length === 0, `Page errors: ${pageErrors.join('; ')}`);
	process.stdout.write(
		`${appName} boot gate passed on ${engineName}: offline device boot${app.heldScenario ? ', held-storage screen, and Try again recovery' : ''}.\n`,
	);
} catch (cause) {
	// process.exit in finally would swallow the throw; report before exiting.
	console.error(cause);
	for (const page of watched) {
		if (page.isClosed()) continue;
		const text = await page
			.evaluate(() => document.body.innerText)
			.catch(() => '(unreadable)');
		console.error(`--- page body ---\n${text.slice(0, 2000)}`);
	}
	if (pageErrors.length > 0) {
		console.error(`--- page errors ---\n${pageErrors.join('\n')}`);
	}
	process.exitCode = 1;
} finally {
	await context?.close();
	await browser?.close();
	server.stop(true);
	rmSync(profile, { recursive: true, force: true });
	process.exit(process.exitCode ?? 0);
}
