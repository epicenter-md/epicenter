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
} from 'playwright';

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

try {
	await waitForServer();
	browser = await chromium.launch({ headless: true });
	context = await browser.newContext();
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
		'stealing Worker did not read the previous owner\'s OPFS state',
	);
	const sqlRows = await second.evaluate(() =>
		window.productionBrowserRuntime.sql(),
	);
	assert(
		sqlRows.length === 2 && sqlRows.some(({ id }) => id === secondRow.id),
		'stealing Worker SQL lens missed committed rows',
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
		typeof stolenFailure === 'string' && /moved to a newer tab/.test(stolenFailure),
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

	// A separate storage context is a second device: nothing arrives except
	// through the real records routes.
	process.stdout.write('step: remote-context\n');
	remoteContext = await browser.newContext();
	const remote = await openPage(remoteContext);
	await remote.waitForFunction(
		(id) =>
			window.productionBrowserRuntime
				.get(id)
				.then(({ data }) => data?.title === 'second'),
		secondRow.id,
	);

	// The row document plane: one socket per open document, across contexts.
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
	await remote.waitForFunction(
		() => window.productionBrowserRuntime.readDraft().revoked !== undefined,
	);
	await remote.evaluate(() => window.productionBrowserRuntime.dispose());
	await remote.close();

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
	await reopened.evaluate(() => window.productionBrowserRuntime.dispose());
	await reopened.close();

	assert(
		browserErrors.length === 0,
		`Browser errors: ${browserErrors.join('; ')}`,
	);
	process.stdout.write(
		'Production Browser runtime passed: SAH-pool OPFS without isolation headers, newest-tab-wins storage steal, real record routes, cross-context row-document WebSocket sync, deletion revocation, and forced reopen.\n',
	);
} finally {
	await context?.close();
	await remoteContext?.close();
	await browser?.close();
	pageServer.kill();
	await pageServer.exited;
	backend.close();
	await apiServer.stop(true);
	rmSync(authorityDir, { recursive: true, force: true });
	rmSync(join(import.meta.dir, 'dist-browser-runtime'), {
		recursive: true,
		force: true,
	});
	// The Bun authority backend retains live handles after close(); exit
	// explicitly so the gate terminates once verdicts are printed.
	process.exit(process.exitCode ?? 0);
}
