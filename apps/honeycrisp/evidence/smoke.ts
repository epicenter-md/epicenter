/**
 * Honeycrisp, driven in a real browser across a reload.
 *
 * Run: `bun run smoke` (builds first)
 *
 * The one thing typecheck and the unit suites cannot judge: that a person can
 * open the app, make a note, type prose into it, reload, and find both still
 * there. Prose is the half that matters here, because it lives in the row's
 * nested `content` node on the database document (ADR-0295).
 */
import { chromium } from 'playwright';

const port = 4318;
const root = new URL('../build/', import.meta.url).pathname;

const server = Bun.serve({
	port,
	async fetch(request) {
		const path = new URL(request.url).pathname;
		const file = Bun.file(root + (path === '/' ? 'index.html' : path.slice(1)));
		if (await file.exists()) return new Response(file);
		// SPA fallback, as every host serves it.
		return new Response(Bun.file(`${root}index.html`), {
			headers: { 'content-type': 'text/html' },
		});
	},
});

const held: string[] = [];
const failed: string[] = [];
const check = (label: string, ok: boolean, detail = '') =>
	(ok ? held : failed).push(
		`  ${ok ? 'held  ' : 'FAILED'}  ${label.padEnd(48)} ${detail}`,
	);

const browser = await chromium.launch();
try {
	const page = await browser.newPage();
	const crashes: string[] = [];
	page.on('pageerror', (error) => crashes.push(String(error)));

	await page.goto(`http://localhost:${port}/device`);
	await page.waitForSelector('text=On this device', { timeout: 15_000 });
	check('the device store opened', true);
	// `/device` resolves a generation and redirects to it: the number is in
	// the URL, and the opener below it took an exact address (ADR-0285).
	await page.waitForURL(/\/device\/\d+$/, { timeout: 10_000 }).catch(() => {});
	check(
		'the URL carries the generation it resolved',
		/\/device\/1$/.test(page.url()),
		page.url(),
	);

	// New note, then type into the editor.
	await page
		.getByRole('button', { name: /new note/i })
		.first()
		.click();
	const editor = page.locator('.ProseMirror').first();
	await editor.waitFor({ timeout: 10_000 });
	await editor.click();
	await page.keyboard.type('Groceries');
	await page.keyboard.press('Enter');
	await page.keyboard.type('buy milk');

	// The derived title is the app's own write off the body's change signal
	// (ADR-0297), so seeing it in the list proves the whole loop.
	await page.waitForFunction(
		() => document.body.innerText.includes('Groceries'),
		undefined,
		{ timeout: 10_000 },
	);
	check('typing derived the note title into the list', true);

	await page.waitForTimeout(500);
	await page.reload();
	await page.waitForSelector('text=On this device', { timeout: 15_000 });

	const after = await page.evaluate(() => document.body.innerText);
	check(
		'the note survived the reload',
		after.includes('Groceries'),
		'Groceries',
	);

	await page.getByText('Groceries').first().click();
	const prose = await page.locator('.ProseMirror').first().innerText();
	check(
		'its prose survived too',
		prose.includes('buy milk'),
		JSON.stringify(prose.slice(0, 40)),
	);
	check('nothing threw in the page', crashes.length === 0, crashes[0] ?? '');
} finally {
	await browser.close();
	server.stop(true);
}

console.log('\nHoneycrisp, in a real browser\n');
for (const line of [...held, ...failed]) console.log(line);
console.log(
	failed.length === 0
		? '\nA note is made, typed into, and still there after a reload.\n'
		: `\n${failed.length} check(s) failed.\n`,
);
process.exit(failed.length === 0 ? 0 : 1);
