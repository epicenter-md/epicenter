import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import type { Browser, BrowserContext } from 'playwright';

const port = 5198;
const origin = `http://127.0.0.1:${port}`;
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
} finally {
	await context?.close();
	await browser?.close();
	server.kill();
	await server.exited;
}
