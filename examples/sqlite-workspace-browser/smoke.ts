import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asPrincipalId } from '@epicenter/identity';
import {
	createBunRecords,
	type Env,
	mountRecordsApp,
} from '@epicenter/server/bun';
import { Hono } from 'hono';
import type { Browser, BrowserContext } from 'playwright';
import { chromium } from 'playwright';

const port = 5198;
const origin = `http://127.0.0.1:${port}`;
const recordsDirectory = mkdtempSync(join(tmpdir(), 'epicenter-records-'));
const records = createBunRecords({
	dir: recordsDirectory,
	sha256: async (value) => createHash('sha256').update(value).digest('hex'),
});
const recordsApp = new Hono<Env>();
recordsApp.use('*', async (c, next) => {
	await next();
	c.header('access-control-allow-origin', origin);
	c.header('access-control-allow-methods', 'POST, OPTIONS');
	c.header('access-control-allow-headers', 'content-type');
	c.header('cross-origin-resource-policy', 'cross-origin');
});
recordsApp.options('*', (c) => c.body(null, 204));
mountRecordsApp(recordsApp, {
	resolveRecords: () => records.records,
	auth: async (c, next) => {
		c.set('principal', { id: asPrincipalId('browser-smoke') });
		await next();
	},
});
const recordsServer = Bun.serve({
	port: 5199,
	fetch: recordsApp.fetch,
});
const server = Bun.spawn(
	[
		'bun',
		'x',
		'vite',
		'preview',
		'--host',
		'127.0.0.1',
		'--port',
		String(port),
	],
	{
		cwd: import.meta.dir,
		stdout: 'ignore',
		stderr: 'inherit',
	},
);

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

async function waitForServer(): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			const response = await fetch(origin);
			if (response.ok) return;
		} catch {
			// Preview is still starting.
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error('Vite preview did not start');
}

const browserErrors: string[] = [];
let browser: Browser | undefined;
let context: BrowserContext | undefined;

try {
	const assets = readdirSync(join(import.meta.dir, 'dist', 'assets'));
	assert(
		assets.some((name) => name.endsWith('.wasm')),
		'Production build did not emit SQLite WASM',
	);
	assert(
		assets.some((name) => name.includes('sqlite3-opfs-async-proxy')),
		'Production build did not emit the OPFS async proxy',
	);

	await waitForServer();
	browser = await chromium.launch({ headless: true });
	context = await browser.newContext();
	const first = await context.newPage();
	const second = await context.newPage();
	for (const page of [first, second]) {
		page.on('pageerror', (error) => browserErrors.push(error.message));
		await page.goto(origin);
		await page.waitForFunction(() => document.body.dataset.ready === 'true');
	}

	const runId = `${Date.now()}`;
	const firstId = `first-${runId}`;
	await first.evaluate(
		([id]) => window.workspaceSmoke.put({ id, title: 'First page' }),
		[firstId],
	);
	await second.waitForFunction(
		(id) => window.workspaceSmoke.observedIds.includes(id),
		firstId,
	);
	const firstVisibleFromSecond = await second.evaluate(
		(id) => window.workspaceSmoke.get(id),
		firstId,
	);
	assert(
		firstVisibleFromSecond?.title === 'First page',
		`Second connection did not see sequential write: ${JSON.stringify(firstVisibleFromSecond)}`,
	);

	const leftIds = Array.from(
		{ length: 4 },
		(_, index) => `left-${index}-${runId}`,
	);
	const rightIds = Array.from(
		{ length: 4 },
		(_, index) => `right-${index}-${runId}`,
	);
	await Promise.all(
		[
			...leftIds.map((id) => [first, id] as const),
			...rightIds.map((id) => [second, id] as const),
		].map(([page, id]) =>
			page.evaluate(
				([rowId]) => window.workspaceSmoke.put({ id: rowId, title: rowId }),
				[id],
			),
		),
	);
	const leftId = leftIds.at(-1);
	const rightId = rightIds.at(-1);
	assert(leftId && rightId, 'Concurrent smoke ids were not created');
	await Promise.all([
		first.waitForFunction(
			(id) => window.workspaceSmoke.observedIds.includes(id),
			rightId,
		),
		second.waitForFunction(
			(id) => window.workspaceSmoke.observedIds.includes(id),
			leftId,
		),
	]);
	for (const page of [first, second]) {
		const ids = await page.evaluate(() =>
			window.workspaceSmoke.list().then((rows) => rows.map((row) => row.id)),
		);
		assert(
			[...leftIds, ...rightIds].every((id) => ids.includes(id)),
			`Concurrent rows missing: ${JSON.stringify(ids)}`,
		);
	}

	await first.evaluate(() => window.workspaceSmoke.dispose());
	const afterDisposeId = `after-dispose-${runId}`;
	await second.evaluate(
		([id]) => window.workspaceSmoke.put({ id, title: 'Still open' }),
		[afterDisposeId],
	);
	await first.evaluate(() => window.workspaceSmoke.reopen());
	const persisted = await first.evaluate(
		(id) => window.workspaceSmoke.get(id),
		afterDisposeId,
	);
	assert(
		persisted?.title === 'Still open',
		'Row did not persist across worker restart',
	);

	const mismatch = await first.evaluate(() =>
		window.workspaceSmoke.mismatchError(),
	);
	assert(
		mismatch?.includes('schema identity'),
		`Schema mismatch handshake did not fail: ${mismatch}`,
	);
	assert(
		browserErrors.length === 0,
		`Browser errors: ${browserErrors.join('; ')}`,
	);

	await first.evaluate(() => window.workspaceSmoke.dispose());
	await second.evaluate(() => window.workspaceSmoke.dispose());

	const replicaA = await context.newPage();
	const replicaB = await context.newPage();
	for (const [page, name] of [
		[replicaA, 'a'],
		[replicaB, 'b'],
	] as const) {
		page.on('pageerror', (error) => browserErrors.push(error.message));
		await page.goto(`${origin}?replica=${name}`);
		await page.waitForFunction(
			() => document.body.dataset.replicaReady === 'true',
		);
	}
	const replicaId = `replica-${runId}`;
	await replicaA.evaluate(
		([id]) => window.workspaceSmoke.replicaPut({ id, title: 'Replicated' }),
		[replicaId],
	);
	let replicated: { id: string; title: string } | null = null;
	for (let attempt = 0; attempt < 200; attempt++) {
		replicated = await replicaB.evaluate(
			(id) => window.workspaceSmoke.replicaGet(id),
			replicaId,
		);
		if (replicated?.title === 'Replicated') break;
		await Bun.sleep(10);
	}
	assert(
		replicated?.title === 'Replicated',
		'Browser workspace replicas did not converge through HTTP',
	);
	await replicaA.evaluate(() => window.workspaceSmoke.replicaDispose());
	await replicaB.evaluate(() => window.workspaceSmoke.replicaDispose());
	await replicaA.evaluate(() => window.workspaceSmoke.dispose());
	await replicaB.evaluate(() => window.workspaceSmoke.dispose());
	assert(
		browserErrors.length === 0,
		`Browser errors: ${browserErrors.join('; ')}`,
	);
} finally {
	await context?.close();
	await browser?.close();
	recordsServer.stop(true);
	records.close();
	rmSync(recordsDirectory, { recursive: true, force: true });
	server.kill();
	await server.exited;
}
