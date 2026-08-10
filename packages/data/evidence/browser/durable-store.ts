/**
 * Does a browser store actually survive a reload?
 *
 * Run: `bun run evidence/browser/durable-store.ts`
 *
 * `src/store/browser.ts` is a claim about a runtime: that a page can hold the
 * synchronous store over an in-memory SQLite while IndexedDB holds the three
 * relations that have to survive, and that reopening seeds the one from the
 * other. Typecheck cannot judge any of that. This runs it in a real Chromium,
 * in a real page, across a real reload.
 *
 * METHOD, and the controls are the point:
 *
 *   - **The reload is real.** `page.reload()`, so the page's memory, its
 *     `Y.Doc` and its in-memory SQLite are all gone. Anything that comes back
 *     came out of IndexedDB.
 *   - **CONTROL: a different name must see nothing.** If a second store opened
 *     under another name found the first one's notes, this would be measuring a
 *     page that never reloaded, or a read of the wrong record.
 *   - **CONTROL: prose, not just rows.** Prose lives inside the row's document
 *     and never reaches the projection, so a run that restored rows and lost
 *     documents would otherwise read as a pass.
 *   - **CONTROL: `db.query` agrees with `list`.** They read different relations,
 *     the projection and the CRDT. The projection is NOT durable and is rebuilt
 *     at bind out of the replayed document, so agreement is what proves the
 *     replay happened rather than rows coming back from a stale cache.
 */
import { chromium } from 'playwright';
import { build } from 'vite';

const root = new URL('./durable-store/', import.meta.url).pathname;
const outDir = new URL('./durable-store-dist/', import.meta.url).pathname;

console.log('\nbuilding the probe page\n');
await build({
	root,
	logLevel: 'warn',
	optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
	build: { target: 'esnext', outDir, emptyOutDir: true },
});

const server = Bun.serve({
	port: 0,
	async fetch(request) {
		const { pathname } = new URL(request.url);
		const file = Bun.file(
			`${outDir}${pathname === '/' ? 'index.html' : pathname.slice(1)}`,
		);
		if (!(await file.exists())) return new Response('not found', { status: 404 });
		// No cross-origin isolation headers. Nothing needs them now that the
		// durable copy is IndexedDB rather than an OPFS file, and serving them
		// would make this page more capable than a real deployment's.
		return new Response(file);
	},
});
const origin = `http://localhost:${server.port}`;

type Reading = {
	notes: { title: string; prose: string }[];
	projected: number;
	durability: { healthy: boolean };
	pressure?: { items: number; liveRows: number; itemsPerLiveRow: number };
};

const browser = await chromium.launch();
let failures = 0;
function check(label: string, held: boolean, detail: unknown = ''): void {
	if (!held) failures += 1;
	console.log(`  ${held ? 'held  ' : 'FAILED'}  ${label.padEnd(52)} ${detail}`);
}

try {
	const page = await browser.newPage();
	page.on('pageerror', (error) => console.log(`  page error: ${error.message}`));
	await page.goto(origin);
	await page.waitForFunction('typeof globalThis.open === "function"');

	console.log('1. write two notes with prose, then reload the page');
	const opened = await page.evaluate('globalThis.open("vault")');
	check('the store opened', (opened as { ok?: boolean }).ok === true, JSON.stringify(opened));

	await page.evaluate('globalThis.write("Groceries", "milk and eggs")');
	await page.evaluate('globalThis.write("Ideas", "a note about notes")');
	const before = (await page.evaluate('globalThis.read()')) as Reading;
	check('two notes before the reload', before.notes.length === 2);

	await page.reload();
	await page.waitForFunction('typeof globalThis.open === "function"');
	await page.evaluate('globalThis.open("vault")');
	const after = (await page.evaluate('globalThis.read()')) as Reading;

	check(
		'both notes survived the reload',
		after.notes.length === 2,
		after.notes.map((note) => note.title).join(', '),
	);
	check(
		'their prose survived too',
		after.notes.every((note) => note.prose.includes('milk and eggs') || note.prose.includes('a note about notes')),
	);
	check(
		'CONTROL db.query agrees with list, so the projection came back',
		after.projected === after.notes.length,
		`${after.projected} projected, ${after.notes.length} listed`,
	);
	check('the durable log reports healthy', after.durability.healthy === true);
	check(
		'pressure is readable',
		(after.pressure?.liveRows ?? -1) === 2,
		`${after.pressure?.items} items / ${after.pressure?.liveRows} rows`,
	);

	console.log('\n2. CONTROL: a different namespace is a different file');
	await page.reload();
	await page.waitForFunction('typeof globalThis.open === "function"');
	await page.evaluate('globalThis.open("somewhere-else")');
	const elsewhere = (await page.evaluate('globalThis.read()')) as Reading;
	check(
		'a store under another namespace sees nothing',
		elsewhere.notes.length === 0,
		`${elsewhere.notes.length} notes`,
	);

	console.log('\n3. and the original is still there afterwards');
	await page.reload();
	await page.waitForFunction('typeof globalThis.open === "function"');
	await page.evaluate('globalThis.open("vault")');
	const again = (await page.evaluate('globalThis.read()')) as Reading;
	check('the vault still holds both notes', again.notes.length === 2);
} finally {
	await browser.close();
	await server.stop(true);
}

console.log(
	failures === 0
		? '\nA browser page holds the synchronous store, and its durable state survives a reload.\n'
		: `\n${failures} check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
