/**
 * Production Browser workspace runtime smoke gate.
 *
 * Serves the built page with NO cross-origin isolation headers and runs the
 * real Bun account authority (records HTTP routes plus row-document
 * WebSockets) on a second origin. Proves independent page Workers share one
 * canonical OPFS replica over the SAH-pool VFS, scalar sync converges a
 * second browser storage context through the real routes, a row document
 * synchronizes across storage contexts over its own WebSocket, deleting the
 * row revokes the remote document, SQLite documents survive release, and a
 * force-terminated Worker can be replaced without losing data.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	createBunAccountAuthorityRuntime,
	createEnvTokenResolver,
	mountCurrentStateRecordsApp,
	mountWorkspaceDocumentsApp,
	requireBearerPrincipal,
	withDocumentAuthorizationDeadline,
} from '@epicenter/server/bun';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
	type Browser,
	type BrowserContext,
	chromium,
	type Page,
	webkit,
} from 'playwright';

// SMOKE_BROWSER=webkit runs the same gate on WebKit (the Safari engine the
// physical iPhone gate depends on); the default stays Chromium.
const engineName =
	process.env.SMOKE_BROWSER === 'webkit' ? 'webkit' : 'chromium';
const engine = engineName === 'webkit' ? webkit : chromium;

const pagePort = 5214;
const apiPort = 5215;
const pageOrigin = `http://127.0.0.1:${pagePort}`;
const apiOrigin = `http://127.0.0.1:${apiPort}`;
const token = `browser-runtime-smoke-${Date.now().toString(36)}-0123456789abcdef`;
const config = 'browser-runtime.vite.config.ts';

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const authorityDir = mkdtempSync(join(tmpdir(), 'epicenter-browser-smoke-'));
const backend = createBunAccountAuthorityRuntime({
	dir: join(authorityDir, 'records'),
});
const resolveBearerPrincipal = createEnvTokenResolver(token);
const app = new Hono();
// The page and the authority run on different loopback origins, exactly like
// a deployed SPA against the hosted API; CORS carries the bearer header.
app.use(
	'*',
	cors({ origin: pageOrigin, allowHeaders: ['authorization', 'content-type'] }),
);
// Documents mount BEFORE records: the records mount guards all of
// /api/workspaces/* with header-only bearer auth, which would 401 a browser
// WebSocket upgrade (whose bearer rides the subprotocol) if it ran first.
mountWorkspaceDocumentsApp(app as never, {
	resolveDocumentPrincipal: withDocumentAuthorizationDeadline(
		resolveBearerPrincipal,
	),
	resolveAuthorities: () => backend.authorities,
});
mountCurrentStateRecordsApp(app as never, {
	auth: requireBearerPrincipal(resolveBearerPrincipal),
	resolveAuthorities: () => backend.authorities,
});
const apiServer = Bun.serve({
	hostname: '127.0.0.1',
	port: apiPort,
	fetch: (request) => app.fetch(request),
	websocket: backend.websocket,
});
backend.bindServer(apiServer);

const build = Bun.spawnSync(['bun', 'x', 'vite', 'build', '--config', config], {
	cwd: import.meta.dir,
	stdout: 'inherit',
	stderr: 'inherit',
});
if (!build.success) throw new Error('Production Browser runtime build failed');

const pageServer = Bun.spawn(
	[
		'bun',
		'x',
		'vite',
		'preview',
		'--config',
		config,
		'--host',
		'127.0.0.1',
		'--port',
		String(pagePort),
	],
	{ cwd: import.meta.dir, stdout: 'ignore', stderr: 'inherit' },
);

const url = `${pageOrigin}/browser-runtime.html?${new URLSearchParams({
	api: apiOrigin,
	token,
})}`;

async function waitForServer(): Promise<void> {
	for (let attempt = 0; attempt < 250; attempt++) {
		try {
			if ((await fetch(url)).ok) return;
		} catch {
			// Vite is still starting.
		}
		await Bun.sleep(50);
	}
	throw new Error('Vite preview did not start');
}

let browser: Browser | undefined;
let context: BrowserContext | undefined;
let remoteContext: BrowserContext | undefined;
const browserErrors: string[] = [];
const profiles: string[] = [];

/**
 * One independent browser storage context (a "device"). Playwright WebKit's
 * ephemeral contexts have no OPFS (getDirectory rejects with UnknownError),
 * so the webkit run uses persistent profiles instead.
 */
async function newStorageContext(): Promise<BrowserContext> {
	if (engineName === 'webkit') {
		const profile = mkdtempSync(join(tmpdir(), 'browser-smoke-profile-'));
		profiles.push(profile);
		return engine.launchPersistentContext(profile, { headless: true });
	}
	browser ??= await engine.launch({ headless: true });
	return browser.newContext();
}

async function openPage(context: BrowserContext): Promise<Page> {
	const page = await context.newPage();
	page.setDefaultTimeout(20_000);
	page.on('pageerror', (error) =>
		browserErrors.push(error.stack ?? error.message),
	);
	page.on('console', (message) => {
		if (message.type() === 'error') {
			browserErrors.push(`console: ${message.text()}`);
		}
	});
	await page.goto(url);
	try {
		await page.waitForFunction(() => document.body.dataset.ready === 'true');
	} catch (cause) {
		throw new Error(
			`Browser runtime did not open: ${browserErrors.join('; ')}`,
			{ cause },
		);
	}
	return page;
}

/**
 * Playwright WebKit shares one OPFS across persistent contexts AND across
 * runs (origin storage lives outside the profile dir), so a webkit run
 * first wipes the origin's OPFS, and the cross-context "second device"
 * segments below are chromium-only: on webkit two contexts would silently
 * share storage and prove nothing about sync. Real Safari multi-device
 * behavior is exactly what the physical iPhone gate measures.
 */
async function wipeOriginStorage(target: BrowserContext): Promise<void> {
	const page = await target.newPage();
	await page.goto(`${pageOrigin}/storage-wipe-placeholder.html`);
	const outcome = await page.evaluate(async () => {
		const worker = new Worker(
			URL.createObjectURL(
				new Blob(
					[
						`(async () => {
							try {
								const root = await navigator.storage.getDirectory();
								for await (const [name] of root) {
									await root.removeEntry(name, { recursive: true });
								}
								self.postMessage('wiped');
							} catch (cause) {
								self.postMessage('wipe failed: ' + cause);
							}
						})();`,
					],
					{ type: 'text/javascript' },
				),
			),
		);
		return await new Promise((resolve) => {
			worker.onmessage = (event) => resolve(event.data);
			worker.onerror = () => resolve('wipe worker error');
		});
	});
	assert(outcome === 'wiped', `origin storage wipe failed: ${String(outcome)}`);
	await page.close();
}

try {
	await waitForServer();
	context = await newStorageContext();
	if (engineName === 'webkit') await wipeOriginStorage(context);
	const first = await openPage(context);
	const firstRow = await first.evaluate(() =>
		window.productionBrowserRuntime.create('first'),
	);
	const firstSettlement = await first.evaluate(() =>
		window.productionBrowserRuntime.settle(),
	);
	assert(
		firstSettlement.outcome === 'caught-up',
		`scalar settlement did not catch up: ${firstSettlement.outcome}`,
	);

	// A second tab of the same app steals the storage (newest tab wins): it
	// reads everything the first tab committed, and the first tab degrades to
	// loud failures instead of corrupting the shared SQLite file.
	process.stdout.write('step: steal-open\n');
	const second = await openPage(context);
	const secondRow = await second.evaluate(() =>
		window.productionBrowserRuntime.create('second'),
	);
	const crossRead = await second.evaluate(
		(id) => window.productionBrowserRuntime.get(id),
		firstRow.id,
	);
	assert(
		crossRead.data?.title === 'first',
		"stealing Worker did not read the previous owner's OPFS state",
	);
	const sqlRows = await second.evaluate(() =>
		window.productionBrowserRuntime.sql(),
	);
	assert(
		sqlRows.length === 2 && sqlRows.some(({ id }) => id === secondRow.id),
		'stealing Worker SQL relation missed committed rows',
	);
	const stolenFailure = await first.evaluate(() =>
		window.productionBrowserRuntime
			.create('after-steal')
			.then(() => undefined)
			.catch((cause: unknown) =>
				cause instanceof Error ? cause.message : String(cause),
			),
	);
	assert(
		typeof stolenFailure === 'string' &&
			/moved to a newer tab/.test(stolenFailure),
		`stolen tab did not fail loudly: ${stolenFailure}`,
	);
	// The steal also notifies the stolen page once through onBackgroundError,
	// which is what apps turn into their blocking moved screen.
	await first.waitForFunction(
		() => window.productionBrowserRuntime.movedNotice() !== undefined,
	);
	await first.close();
	const settlement = await second.evaluate(() =>
		window.productionBrowserRuntime.settle(),
	);
	assert(
		settlement.outcome === 'caught-up',
		`post-steal settlement did not catch up: ${settlement.outcome}`,
	);

	// The row document plane: the draft's dedicated WebSocket completes the
	// bearer-subprotocol handshake against the real authority (both engines).
	process.stdout.write('step: second-open-draft\n');
	await second.evaluate(
		(id) => window.productionBrowserRuntime.openDraft(id),
		firstRow.id,
	);
	await second.evaluate(async () => {
		await window.productionBrowserRuntime.writeDraft('durable document');
	});
	try {
		await second.waitForFunction(
			() =>
				window.productionBrowserRuntime.draftConnectionPhase() === 'connected',
		);
	} catch (cause) {
		const phase = await second.evaluate(() =>
			window.productionBrowserRuntime.draftConnectionPhase(),
		);
		throw new Error(
			`draft never connected (phase=${phase}); ${browserErrors.join('; ')}`,
			{ cause },
		);
	}

	// Chromium-only: a separate storage context as a second device (WebKit
	// shares one OPFS across contexts, so this would prove nothing there),
	// cross-device document sync, and deletion revocation.
	if (engineName !== 'webkit') {
		process.stdout.write('step: remote-context\n');
		remoteContext = await newStorageContext();
		const remote = await openPage(remoteContext);
		await remote.waitForFunction(
			(id) =>
				window.productionBrowserRuntime
					.get(id)
					.then(({ data }) => data?.title === 'second'),
			secondRow.id,
		);
		process.stdout.write('step: remote-open-draft\n');
		await remote.evaluate(
			(id) => window.productionBrowserRuntime.openDraft(id),
			firstRow.id,
		);
		await remote.waitForFunction(
			() =>
				window.productionBrowserRuntime.readDraft().text === 'durable document',
		);

		process.stdout.write('step: delete-row\n');
		// Deleting the row on one device closes the other device's socket and
		// revokes its handle once its scalar plane installs the deletion.
		await second.evaluate(
			(id) => window.productionBrowserRuntime.delete(id),
			firstRow.id,
		);
		try {
			await remote.waitForFunction(
				() => window.productionBrowserRuntime.readDraft().revoked !== undefined,
				undefined,
				{ timeout: 60_000 },
			);
		} catch (cause) {
			const scalar = await remote.evaluate(
				(id) => window.productionBrowserRuntime.get(id),
				firstRow.id,
			);
			const draft = await remote.evaluate(() =>
				window.productionBrowserRuntime.readDraft(),
			);
			throw new Error(
				`revocation did not arrive; remote row=${JSON.stringify(scalar)} draft=${JSON.stringify(draft)}`,
				{ cause },
			);
		}
		await remote.evaluate(() => window.productionBrowserRuntime.dispose());
		await remote.close();
	}

	await second.evaluate(() => window.productionBrowserRuntime.closeDraft());
	// A released document must survive: write a draft on the surviving row,
	// close it, and assert its bytes after the forced reopen below.
	await second.evaluate(
		(id) => window.productionBrowserRuntime.openDraft(id),
		secondRow.id,
	);
	await second.evaluate(async () => {
		await window.productionBrowserRuntime.writeDraft('survives release');
	});
	await second.evaluate(() => window.productionBrowserRuntime.closeDraft());
	// Closing the page force-terminates its Worker without a runtime flush.
	await second.close();

	process.stdout.write('step: reopen\n');
	const reopened = await openPage(context);
	const afterCrash = await reopened.evaluate(
		(id) => window.productionBrowserRuntime.get(id),
		secondRow.id,
	);
	assert(
		afterCrash.data?.title === 'second',
		'force-terminated Worker lost committed OPFS records',
	);
	const survivingDraft = await reopened.evaluate(
		(id) => window.productionBrowserRuntime.openDraft(id),
		secondRow.id,
	);
	assert(
		survivingDraft === 'survives release',
		'SQLite row document did not survive release and reopen',
	);

	// Repeated ownership transfer: a live owner is stolen from, then steals
	// back on reload; each handoff notifies the loser and moves all committed
	// state to the winner.
	process.stdout.write('step: ping-pong\n');
	const rival = await openPage(context);
	const rivalRead = await rival.evaluate(
		(id) => window.productionBrowserRuntime.get(id),
		secondRow.id,
	);
	assert(
		rivalRead.data?.title === 'second',
		'ping-pong rival did not read committed state after its steal',
	);
	await reopened.waitForFunction(
		() => window.productionBrowserRuntime.movedNotice() !== undefined,
	);
	await reopened.reload();
	await reopened.waitForFunction(() => document.body.dataset.ready === 'true');
	const stolenBack = await reopened.evaluate(
		(id) => window.productionBrowserRuntime.get(id),
		secondRow.id,
	);
	assert(
		stolenBack.data?.title === 'second',
		'reload did not steal ownership back with committed state',
	);
	await rival.waitForFunction(
		() => window.productionBrowserRuntime.movedNotice() !== undefined,
	);
	await rival.close();
	await reopened.evaluate(() => window.productionBrowserRuntime.dispose());
	await reopened.close();

	// A suspended previous owner: a raw worker holds OPFS sync access handles
	// on the pool directory and cannot answer the steal notification. Boot
	// must fail with the named held contract instead of a blank page, and
	// releasing the holder then retrying must recover.
	process.stdout.write('step: held-storage\n');
	const holder = await context.newPage();
	await holder.goto(`${pageOrigin}/holder-placeholder.html`);
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
	const blocked = await context.newPage();
	blocked.setDefaultTimeout(30_000);
	await blocked.goto(url);
	await blocked.waitForFunction(
		() => document.body.dataset.bootError === 'WorkspaceStorageHeldError',
	);
	// Closing the holder page terminates its worker and frees the handles;
	// an ordinary retry (reload) then boots.
	await holder.close();
	await blocked.reload();
	await blocked.waitForFunction(() => document.body.dataset.ready === 'true');
	await blocked.evaluate(() => window.productionBrowserRuntime.dispose());
	await blocked.close();

	assert(
		browserErrors.length === 0,
		`Browser errors: ${browserErrors.join('; ')}`,
	);
	process.stdout.write(
		engineName === 'webkit'
			? 'Production Browser runtime passed on webkit: SAH-pool OPFS without isolation headers, newest-tab-wins steal with moved notification, ownership ping-pong, held-storage boot refusal with retry recovery, real record routes, document socket handshake, and forced reopen (cross-device sync segments are chromium-only; WebKit shares one OPFS across contexts).\n'
			: 'Production Browser runtime passed on chromium: SAH-pool OPFS without isolation headers, newest-tab-wins steal with moved notification, ownership ping-pong, held-storage boot refusal with retry recovery, real record routes, cross-context row-document WebSocket sync, deletion revocation, and forced reopen.\n',
	);
} catch (cause) {
	// process.exit in finally would swallow the throw; report before exiting.
	console.error(cause);
	if (browserErrors.length > 0) {
		console.error(`--- browser errors ---\n${browserErrors.join('\n')}`);
	}
	process.exitCode = 1;
} finally {
	await context?.close();
	await remoteContext?.close();
	await browser?.close();
	pageServer.kill();
	await pageServer.exited;
	backend.close();
	await apiServer.stop(true);
	rmSync(authorityDir, { recursive: true, force: true });
	for (const profile of profiles) {
		rmSync(profile, { recursive: true, force: true });
	}
	rmSync(join(import.meta.dir, 'dist-browser-runtime'), {
		recursive: true,
		force: true,
	});
	// The Bun authority backend retains live handles after close(); exit
	// explicitly so the gate terminates once verdicts are printed.
	process.exit(process.exitCode ?? 0);
}
