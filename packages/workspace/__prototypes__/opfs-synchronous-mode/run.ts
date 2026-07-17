/**
 * PROTOTYPE: compare SQLite FULL and EXTRA against the real browser OPFS VFS.
 *
 * This harness deliberately resolves Playwright from the existing Matter app so
 * the throwaway experiment does not add dependencies or modify the lockfile.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const prototypeRoot = import.meta.dir;
const repositoryRoot = resolve(prototypeRoot, '../../../..');
const sqliteDist = join(
	repositoryRoot,
	'packages/workspace/node_modules/@sqlite.org/sqlite-wasm/dist',
);
const playwrightEntry = Bun.resolveSync(
	'@playwright/test',
	join(repositoryRoot, 'apps/matter'),
);
const { chromium } = await import(pathToFileURL(playwrightEntry).href);
const iterations = Number(
	Bun.argv
		.find((argument) => argument.startsWith('--iterations='))
		?.split('=')[1] ?? 30,
);
const extraFirst = Bun.argv.includes('--extra-first');

const contentTypes: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.wasm': 'application/wasm',
};

const server = Bun.serve({
	port: 0,
	async fetch(request) {
		const pathname = new URL(request.url).pathname;
		const path =
			pathname === '/'
				? join(prototypeRoot, 'index.html')
				: pathname.startsWith('/vendor/')
					? join(sqliteDist, pathname.slice('/vendor/'.length))
					: join(prototypeRoot, pathname.slice(1));
		const file = Bun.file(path);
		if (!(await file.exists()))
			return new Response('Not found', { status: 404 });
		return new Response(file, {
			headers: {
				'Content-Type':
					contentTypes[extname(path)] ?? 'application/octet-stream',
				'Cross-Origin-Embedder-Policy': 'require-corp',
				'Cross-Origin-Opener-Policy': 'same-origin',
			},
		});
	},
});

const browser = await chromium.launch({ headless: true });
try {
	const page = await browser.newPage();
	page.on('console', (message: { text(): string }) =>
		console.log(`[browser] ${message.text()}`),
	);
	await page.goto(`http://127.0.0.1:${server.port}`);
	const result = await page.evaluate(
		async (options: ExperimentOptions) => globalThis.runExperiment(options),
		{ iterations, payloadBytes: 8192, extraFirst },
	);
	console.table([
		{
			mode: 'FULL',
			pragma: result.full.synchronous,
			journal: result.full.journalMode,
			meanMs: result.full.meanMs.toFixed(3),
			p50Ms: result.full.p50Ms.toFixed(3),
			p95Ms: result.full.p95Ms.toFixed(3),
			p99Ms: result.full.p99Ms.toFixed(3),
			recovered: `${result.full.recovered}/${result.full.iterations}`,
		},
		{
			mode: 'EXTRA',
			pragma: result.extra.synchronous,
			journal: result.extra.journalMode,
			meanMs: result.extra.meanMs.toFixed(3),
			p50Ms: result.extra.p50Ms.toFixed(3),
			p95Ms: result.extra.p95Ms.toFixed(3),
			p99Ms: result.extra.p99Ms.toFixed(3),
			recovered: `${result.extra.recovered}/${result.extra.iterations}`,
		},
	]);
	if (
		result.full.synchronous !== 2 ||
		result.extra.synchronous !== 3 ||
		result.full.journalMode !== 'delete' ||
		result.extra.journalMode !== 'delete' ||
		result.full.recovered !== result.full.iterations ||
		result.extra.recovered !== result.extra.iterations
	) {
		throw new Error(
			'The OPFS experiment failed its configuration or recovery checks',
		);
	}
	await browser.close();
	const processCrash = await runProcessCrashExperiment();
	console.table(processCrash);
	if (processCrash.some((result) => result.recovered !== result.iterations)) {
		throw new Error(
			'The browser-process crash experiment lost an acknowledged commit',
		);
	}
} finally {
	if (browser.isConnected()) await browser.close();
	server.stop(true);
}

async function runProcessCrashExperiment() {
	const profile = await mkdtemp(join(tmpdir(), 'epicenter-opfs-crash-'));
	const results = [];
	try {
		for (const mode of ['FULL', 'EXTRA']) {
			const databaseName = `prototype-opfs-process-crash-${mode.toLowerCase()}.sqlite3`;
			let launched = await launchPersistentChromium(profile);
			let recovered = 0;
			try {
				await launched.page.goto(`http://127.0.0.1:${server.port}`);
				await launched.page.evaluate(
					(options: DatabaseOptions) =>
						globalThis.preparePrototypeDatabase(options),
					{ databaseName, mode },
				);
				for (let marker = 0; marker < 10; marker += 1) {
					await launched.page.evaluate(
						(
							options: DatabaseOptions & {
								marker: number;
								payloadBytes: number;
							},
						) => globalThis.commitPrototypeMarker(options),
						{ databaseName, mode, marker, payloadBytes: 8192 },
					);
					await killChromium(launched);
					launched = await launchPersistentChromium(profile);
					await launched.page.goto(`http://127.0.0.1:${server.port}`);
					const verification = await launched.page.evaluate(
						(options: DatabaseOptions & { marker: number }) =>
							globalThis.verifyPrototypeMarker(options),
						{ databaseName, mode, marker },
					);
					if (verification.present && verification.integrity === 'ok')
						recovered += 1;
				}
				await launched.page.evaluate(
					(name: string) => globalThis.removePrototypeDatabase(name),
					databaseName,
				);
				results.push({ mode, iterations: 10, recovered });
			} finally {
				await closeChromium(launched);
			}
		}
		return results;
	} finally {
		await rm(profile, { recursive: true, force: true });
	}
}

async function launchPersistentChromium(profile: string) {
	const context = await chromium.launchPersistentContext(profile, {
		headless: true,
	});
	const processList = Bun.spawnSync(['ps', '-ax', '-o', 'pid=,command='])
		.stdout.toString()
		.split('\n');
	const mainProcess = processList.find(
		(line) =>
			line.includes(`--user-data-dir=${profile}`) && !line.includes('--type='),
	);
	const pid = Number(mainProcess?.trim().split(/\s+/, 1)[0]);
	if (!pid) {
		await context.close();
		throw new Error('Could not identify the prototype Chromium process');
	}
	const page = context.pages()[0] ?? (await context.newPage());
	return { context, page, pid };
}

async function killChromium(launched: LaunchedChromium) {
	process.kill(launched.pid, 'SIGKILL');
	for (let attempt = 0; attempt < 100; attempt += 1) {
		try {
			process.kill(launched.pid, 0);
			await Bun.sleep(50);
		} catch {
			return;
		}
	}
	throw new Error(
		`Chromium process ${launched.pid} did not exit after SIGKILL`,
	);
}

async function closeChromium(launched: LaunchedChromium) {
	await launched.context.close().catch(() => undefined);
}

declare global {
	// Browser-only function installed by experiment.js.
	var runExperiment: (options: {
		iterations: number;
		payloadBytes: number;
		extraFirst: boolean;
	}) => Promise<{
		full: ExperimentResult;
		extra: ExperimentResult;
	}>;
	var preparePrototypeDatabase: (options: DatabaseOptions) => Promise<unknown>;
	var commitPrototypeMarker: (
		options: DatabaseOptions & { marker: number; payloadBytes: number },
	) => Promise<unknown>;
	var verifyPrototypeMarker: (
		options: DatabaseOptions & { marker: number },
	) => Promise<{ present: boolean; integrity: string }>;
	var removePrototypeDatabase: (databaseName: string) => Promise<void>;
}

type DatabaseOptions = { databaseName: string; mode: string };

type ExperimentOptions = {
	iterations: number;
	payloadBytes: number;
	extraFirst: boolean;
};

type LaunchedChromium = Awaited<ReturnType<typeof launchPersistentChromium>>;

type ExperimentResult = {
	synchronous: number;
	journalMode: string;
	meanMs: number;
	p50Ms: number;
	p95Ms: number;
	p99Ms: number;
	recovered: number;
	iterations: number;
};
