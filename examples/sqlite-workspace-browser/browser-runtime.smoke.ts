/**
 * Production Browser workspace runtime smoke gate.
 *
 * Proves independent page Workers share one canonical OPFS replica, automatic
 * authority sync converges another Browser context, lossy invalidation reaches
 * another page, live Yjs updates cross tabs, IndexedDB documents survive
 * release, and a force-terminated Worker can be replaced without losing data.
 */
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import {
	type Browser,
	type BrowserContext,
	chromium,
	type Page,
} from 'playwright';
import { createBunSqliteAdapter } from '../../packages/record-sync/src/adapters/bun.js';
import {
	openRecordAuthority,
	RECORD_SYNC_PROTOCOL_MAJOR,
} from '../../packages/record-sync/src/index.js';

const port = 5214;
const origin = `http://127.0.0.1:${port}`;
const authority = `browser-runtime-${Date.now().toString(36)}`;
const config = 'browser-runtime.vite.config.ts';
const authorityDatabase = new Database(':memory:');
const recordAuthority = openRecordAuthority({
	database: createBunSqliteAdapter(authorityDatabase),
	sha256: async (value) => createHash('sha256').update(value).digest('hex'),
});
const recordRequests: string[] = [];

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const build = Bun.spawnSync(['bun', 'x', 'vite', 'build', '--config', config], {
	cwd: import.meta.dir,
	stdout: 'inherit',
	stderr: 'inherit',
});
if (!build.success) throw new Error('Production Browser runtime build failed');

const server = Bun.spawn(
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
		String(port),
	],
	{ cwd: import.meta.dir, stdout: 'ignore', stderr: 'inherit' },
);

const url = `${origin}/browser-runtime.html?${new URLSearchParams({ authority })}`;

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

async function openPage(context: BrowserContext): Promise<Page> {
	const page = await context.newPage();
	page.setDefaultTimeout(20_000);
	page.on('pageerror', (error) => browserErrors.push(error.message));
	await page.goto(url);
	try {
		await page.waitForFunction(() => document.body.dataset.ready === 'true');
	} catch (cause) {
		throw new Error(
			`Browser runtime did not open: ${browserErrors.join('; ')}`,
			{
				cause,
			},
		);
	}
	return page;
}

async function installRecordAuthority(context: BrowserContext): Promise<void> {
	await context.route(`${origin}/api/records/**`, async (route) => {
		const request = route.request();
		const body = request.postDataJSON() as unknown;
		const pathname = new URL(request.url()).pathname;
		recordRequests.push(pathname);
		const response = pathname.endsWith('/push')
			? recordAuthority.push(body as Parameters<typeof recordAuthority.push>[0])
			: pathname.endsWith('/pull')
				? recordAuthority.pull(
						body as Parameters<typeof recordAuthority.pull>[0],
					)
				: pathname.endsWith('/snapshot-chunk')
					? recordAuthority.snapshotChunk(
							body as Parameters<typeof recordAuthority.snapshotChunk>[0],
						)
					: undefined;
		if (!response) throw new Error(`Unexpected record route '${pathname}'`);
		await route.fulfill({
			contentType: 'application/json',
			body: JSON.stringify(await response),
		});
	});
}

let browser: Browser | undefined;
let context: BrowserContext | undefined;
let remoteContext: BrowserContext | undefined;
const browserErrors: string[] = [];

try {
	await waitForServer();
	browser = await chromium.launch({ headless: true });
	context = await browser.newContext();
	await installRecordAuthority(context);
	const first = await openPage(context);
	const second = await openPage(context);

	const [firstRow, secondRow] = await Promise.all([
		first.evaluate(() => window.productionBrowserRuntime.create('first')),
		second.evaluate(() => window.productionBrowserRuntime.create('second')),
	]);
	const crossRead = await second.evaluate(
		(id) => window.productionBrowserRuntime.get(id),
		firstRow.id,
	);
	assert(
		crossRead.data?.title === 'first',
		'second Worker did not read shared OPFS',
	);
	await second.waitForFunction(
		() => window.productionBrowserRuntime.changeCount() >= 2,
	);
	const sqlRows = await first.evaluate(() =>
		window.productionBrowserRuntime.sql(),
	);
	assert(
		sqlRows.length === 2,
		'connection-local SQL lens missed committed rows',
	);
	assert(
		sqlRows.some(({ id }) => id === secondRow.id),
		'first Worker did not project the second Worker write',
	);

	for (let attempt = 0; attempt < 250; attempt++) {
		const pulled = recordAuthority.pull({
			protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
			kind: 'pull',
			cursor: 0,
			limit: 100,
		});
		if (
			pulled.ok &&
			!pulled.snapshotRequired &&
			pulled.entries.some((entry) => entry.rowId === secondRow.id)
		) {
			break;
		}
		if (attempt === 249)
			throw new Error(
				`Browser outbox never reached authority; requests: ${recordRequests.join(', ')}`,
			);
		await Bun.sleep(20);
	}
	remoteContext = await browser.newContext();
	await installRecordAuthority(remoteContext);
	const remote = await openPage(remoteContext);
	await remote.evaluate(
		(id) => window.productionBrowserRuntime.get(id),
		secondRow.id,
	);
	await remote.waitForFunction(
		() => window.productionBrowserRuntime.changeCount() >= 1,
	);
	const remotelyInstalled = await remote.evaluate(
		(id) => window.productionBrowserRuntime.get(id),
		secondRow.id,
	);
	assert(
		remotelyInstalled.data?.title === 'second',
		'automatic startup pull did not install authority state',
	);
	await remote.evaluate(() => window.productionBrowserRuntime.dispose());
	await remote.close();

	await Promise.all([
		first.evaluate(
			(id) => window.productionBrowserRuntime.openDraft(id),
			firstRow.id,
		),
		second.evaluate(
			(id) => window.productionBrowserRuntime.openDraft(id),
			firstRow.id,
		),
	]);
	await first.evaluate(async () => {
		window.productionBrowserRuntime.writeDraft('durable document');
	});
	await second.waitForFunction(
		(id) =>
			window.productionBrowserRuntime
				.openDraft(id)
				.then((text) => text === 'durable document'),
		firstRow.id,
	);
	await first.evaluate(() => window.productionBrowserRuntime.closeDraft());
	const revoked = await first.evaluate(() => {
		try {
			window.productionBrowserRuntime.readReleasedDraft();
			return false;
		} catch {
			return true;
		}
	});
	assert(revoked, 'released document content remained usable');
	await first.evaluate(() => window.productionBrowserRuntime.dispose());
	await first.close();

	// Closing the page force-terminates its Worker without a runtime flush.
	await second.close();

	const reopened = await openPage(context);
	const afterCrash = await reopened.evaluate(
		(id) => window.productionBrowserRuntime.get(id),
		secondRow.id,
	);
	assert(
		afterCrash.data?.title === 'second',
		'force-terminated Worker lost committed OPFS records',
	);
	const draft = await reopened.evaluate(
		(id) => window.productionBrowserRuntime.openDraft(id),
		firstRow.id,
	);
	assert(
		draft === 'durable document',
		'IndexedDB document did not survive reopen',
	);
	await reopened.evaluate(() => window.productionBrowserRuntime.dispose());
	await reopened.close();

	assert(
		browserErrors.length === 0,
		`Browser errors: ${browserErrors.join('; ')}`,
	);
	process.stdout.write(
		'Production Browser runtime passed: two page Workers, shared OPFS, automatic authority sync, invalidation, SQL lenses, durable lazy documents, revocation, and forced reopen.\n',
	);
} finally {
	await context?.close();
	await remoteContext?.close();
	await browser?.close();
	authorityDatabase.close();
	server.kill();
	await server.exited;
	rmSync(join(import.meta.dir, 'dist-browser-runtime'), {
		recursive: true,
		force: true,
	});
}
