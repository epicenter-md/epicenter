/**
 * Benchmark orchestrator: drives the three engine pages in one Chromium
 * build via Playwright, so every engine sees the same JS engine, allocator,
 * and storage stack.
 *
 * Usage: bun bench/runner.ts [--rows 1000,10000,50000] [--engines ykv,percell,sqlite]
 * Requires the vite dev server on :5199 (`bun run dev`).
 */

import { chromium, type Page } from 'playwright';

const BASE = 'http://localhost:5199/bench';

type PhaseResult = Record<string, number | string>;
type EngineRun = {
	engine: string;
	rows: number;
	phases: Record<string, PhaseResult>;
};

const args = process.argv.slice(2);
function argValue(flag: string, fallback: string): string {
	const i = args.indexOf(flag);
	return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const ROW_SCALES = argValue('--rows', '1000,10000,50000')
	.split(',')
	.map(Number);
const ENGINES = argValue('--engines', 'ykv,percell,sqlite').split(',');

const CHURN_FRACTION = 0.4; // ops = 40% of row count
const REMOTE_EDITS = 500;

async function bench<T>(page: Page, script: string): Promise<T> {
	return page.evaluate(script) as Promise<T>;
}

async function waitReady(page: Page) {
	await page.waitForFunction('window.bench !== undefined');
	await page.evaluate('window.benchReady');
}

async function runEngine(
	page: Page,
	engine: string,
	rows: number,
): Promise<EngineRun> {
	const [page_, query] = engine.split('?');
	const url = `${BASE}/${page_}.html${query ? `?${query}` : ''}`;
	const phases: Record<string, PhaseResult> = {};

	// Phase 0: fresh storage, seed.
	await page.goto(url);
	await waitReady(page);
	await bench(page, 'window.bench.reset()');
	// Reload after reset so engines start from a clean attach.
	await page.goto(url);
	await waitReady(page);
	phases.seed = await bench(page, `window.bench.seed(${rows})`);
	phases.memoryAfterSeed = await bench(page, 'window.bench.memory()');

	// Phase 1: cold open.
	await page.goto(url);
	await waitReady(page);
	phases.coldOpen = await bench(page, 'window.bench.hydrate()');
	phases.settledMemory = await bench(page, 'window.bench.memory()');
	phases.query100 = await bench(page, 'window.bench.query100()');
	phases.search = await bench(page, `window.bench.search('needle')`);
	phases.editOne = await bench(page, 'window.bench.editOne(42)');
	phases.remoteApply = await bench(
		page,
		`window.bench.remoteApply(${REMOTE_EDITS})`,
	);
	const churnOps = Math.floor(rows * CHURN_FRACTION);
	phases.churn = await bench(page, `window.bench.churn(${churnOps})`);
	(phases.churn as PhaseResult).ops = churnOps;
	phases.memoryAfterChurn = await bench(page, 'window.bench.memory()');
	// Give persistence a moment to flush churn before restart.
	await page.waitForTimeout(1500);

	// Phase 2: restart after churn.
	await page.goto(url);
	await waitReady(page);
	phases.restart = await bench(page, 'window.bench.hydrate()');
	phases.restartMemory = await bench(page, 'window.bench.memory()');
	phases.persistSize = await bench(page, 'window.bench.persistSize()');

	// Cleanup so scales don't bleed into each other.
	await bench(page, 'window.bench.reset()');

	return { engine, rows, phases };
}

function fmtMs(v: unknown): string {
	return typeof v === 'number' ? `${v.toFixed(1)}ms` : String(v);
}
function fmtBytes(v: unknown): string {
	if (typeof v !== 'number' || v < 0) return 'n/a';
	if (v > 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)}MB`;
	return `${(v / 1024).toFixed(0)}KB`;
}

const results: EngineRun[] = [];
const browser = await chromium.launch({
	args: [
		'--js-flags=--expose-gc',
		'--enable-features=SharedArrayBuffer',
	],
});

try {
	for (const rows of ROW_SCALES) {
		for (const engine of ENGINES) {
			const context = await browser.newContext();
			const page = await context.newPage();
			page.on('console', (msg) => {
				if (msg.type() === 'error') console.error(`[${engine}]`, msg.text());
			});
			console.error(`\n=== ${engine} @ ${rows} rows ===`);
			const t0 = Date.now();
			try {
				const run = await runEngine(page, engine, rows);
				results.push(run);
				console.error(
					`    done in ${((Date.now() - t0) / 1000).toFixed(1)}s: cold-open ${fmtMs((run.phases.coldOpen as PhaseResult).hydrateMs)}, settled ${fmtBytes((run.phases.settledMemory as PhaseResult).bytes)}`,
				);
			} catch (error) {
				console.error(`    FAILED: ${error}`);
				results.push({
					engine,
					rows,
					phases: { error: { message: String(error) } },
				});
			}
			await context.close();
		}
	}
} finally {
	await browser.close();
}

// Emit raw JSON on stdout; human table on stderr.
console.log(JSON.stringify(results, null, 2));

for (const rows of ROW_SCALES) {
	console.error(`\n## ${rows.toLocaleString()} rows`);
	const header = [
		'engine',
		'seed',
		'cold open',
		'settled mem',
		'query100',
		'search',
		'edit1',
		'remote500',
		'churn',
		'restart',
		'restart mem',
		'disk',
	];
	console.error(`| ${header.join(' | ')} |`);
	console.error(`|${header.map(() => '---').join('|')}|`);
	for (const run of results.filter((r) => r.rows === rows)) {
		const p = run.phases;
		if (p.error) {
			console.error(`| ${run.engine} | ERROR: ${p.error.message} |`);
			continue;
		}
		const cells = [
			run.engine,
			fmtMs((p.seed as PhaseResult).insertMs),
			fmtMs((p.coldOpen as PhaseResult).hydrateMs),
			fmtBytes((p.settledMemory as PhaseResult).bytes),
			fmtMs((p.query100 as PhaseResult).ms),
			fmtMs((p.search as PhaseResult).ms),
			fmtMs((p.editOne as PhaseResult).ms),
			fmtMs((p.remoteApply as PhaseResult).ms),
			fmtMs((p.churn as PhaseResult).ms),
			fmtMs((p.restart as PhaseResult).hydrateMs),
			fmtBytes((p.restartMemory as PhaseResult).bytes),
			fmtBytes((p.persistSize as PhaseResult).bytes),
		];
		console.error(`| ${cells.join(' | ')} |`);
	}
}
