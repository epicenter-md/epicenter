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
let replicaContextA: BrowserContext | undefined;
let replicaContextB: BrowserContext | undefined;

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
	assert(
		(await first.locator('body').getAttribute('data-workspace-id')) ===
			'records-generation-fixture-g1',
		'Generation one did not use its derived workspace id',
	);
	assert(
		(await first.locator('body').getAttribute('data-kv-document-guid')) ===
			'records-generation-fixture-g1.kv',
		'Generation one did not mount its locked KV document identity',
	);

	const generationOneInspection = await first.evaluate(() =>
		window.workspaceSmoke.inspectGenerationOne(),
	);
	assert(
		generationOneInspection.status === 'initialized',
		`User-empty generation one was not initialized: ${JSON.stringify(generationOneInspection)}`,
	);
	const readOpfsEntries = () =>
		first.evaluate(async () => {
			const root = await navigator.storage.getDirectory();
			const names: string[] = [];
			for await (const [name] of root as FileSystemDirectoryHandle &
				AsyncIterable<[string, FileSystemHandle]>) {
				names.push(name);
			}
			return names.toSorted();
		});
	const entriesBeforeAbsentProbe = await readOpfsEntries();
	const absentGenerationTwo = await first.evaluate(() =>
		window.workspaceSmoke.inspectGenerationTwo(),
	);
	const entriesAfterAbsentProbe = await readOpfsEntries();
	assert(
		absentGenerationTwo.status === 'absent',
		`Missing generation two was not absent: ${JSON.stringify(absentGenerationTwo)}`,
	);
	assert(
		JSON.stringify(entriesAfterAbsentProbe) ===
			JSON.stringify(entriesBeforeAbsentProbe),
		`Absent generation probe changed OPFS entries: ${JSON.stringify({ entriesBeforeAbsentProbe, entriesAfterAbsentProbe })}`,
	);
	await first.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
		await root.getFileHandle('records-generation-fixture-g2.sqlite3', {
			create: true,
		});
	});
	const emptyGenerationTwo = await first.evaluate(() =>
		window.workspaceSmoke.inspectGenerationTwo(),
	);
	assert(
		emptyGenerationTwo.status === 'invalid',
		`Existing empty generation two was not invalid: ${JSON.stringify(emptyGenerationTwo)}`,
	);
	await first.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
		await root.removeEntry('records-generation-fixture-g2.sqlite3');
	});

	const firstRow = await first.evaluate(() =>
		window.workspaceSmoke.create({ title: 'First page' }),
	);
	const firstId = firstRow.id;
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

	// The preference plane is synchronous and main-thread local: an absent key
	// reads as the declared default, and a write reads back immediately.
	const themeRoundTrip = await first.evaluate(() => {
		const before = window.workspaceSmoke.theme();
		window.workspaceSmoke.setTheme('dark');
		return { before, after: window.workspaceSmoke.theme() };
	});
	assert(
		themeRoundTrip.before === 'light' && themeRoundTrip.after === 'dark',
		`KV preference plane did not round-trip: ${JSON.stringify(themeRoundTrip)}`,
	);

	const leftRows = await Promise.all(
		Array.from({ length: 4 }, (_, index) =>
			first.evaluate(
				(title) => window.workspaceSmoke.create({ title }),
				`left-${index}`,
			),
		),
	);
	const rightRows = await Promise.all(
		Array.from({ length: 4 }, (_, index) =>
			second.evaluate(
				(title) => window.workspaceSmoke.create({ title }),
				`right-${index}`,
			),
		),
	);
	const leftIds = leftRows.map(({ id }) => id);
	const rightIds = rightRows.map(({ id }) => id);
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
	const afterDispose = await second.evaluate(() =>
		window.workspaceSmoke.create({ title: 'Still open' }),
	);
	await first.evaluate(() => window.workspaceSmoke.reopen());
	const persisted = await first.evaluate(
		(id) => window.workspaceSmoke.get(id),
		afterDispose.id,
	);
	assert(
		persisted?.title === 'Still open',
		'Row did not persist across worker restart',
	);

	const mismatch = await first.evaluate(() =>
		window.workspaceSmoke.mismatchError(),
	);
	assert(
		mismatch?.includes('definition does not match'),
		`Schema mismatch handshake did not fail: ${mismatch}`,
	);
	assert(
		browserErrors.length === 0,
		`Browser errors: ${browserErrors.join('; ')}`,
	);

	await first.evaluate(() => window.workspaceSmoke.dispose());
	await second.evaluate(() => window.workspaceSmoke.dispose());

	// Each browser context represents one device-local OPFS partition. Both
	// replicas use the same generation-derived workspace id without accepting a
	// second caller-authored storage name.
	replicaContextA = await browser.newContext();
	replicaContextB = await browser.newContext();
	const replicaA = await replicaContextA.newPage();
	const replicaB = await replicaContextB.newPage();
	for (const page of [replicaA, replicaB]) {
		page.on('pageerror', (error) => browserErrors.push(error.message));
		await page.goto(`${origin}?replica`);
		await page.waitForFunction(
			() => document.body.dataset.replicaReady === 'true',
		);
	}
	const replicaRow = await replicaA.evaluate(() =>
		window.workspaceSmoke.replicaCreate({ title: 'Replicated' }),
	);
	const replicaId = replicaRow.id;
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
	await replicaContextA?.close();
	await replicaContextB?.close();
	await context?.close();
	await browser?.close();
	recordsServer.stop(true);
	records.close();
	rmSync(recordsDirectory, { recursive: true, force: true });
	server.kill();
	await server.exited;
}
