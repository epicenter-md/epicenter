/**
 * Drive the running Honeycrisp and check it actually works.
 *
 *   bun dev:honeycrisp:ui                              # a terminal of its own
 *   bun run apps/honeycrisp/evidence/runs-on-the-new-store.ts
 *
 * Typecheck says the types line up, and the unit tests say the pieces behave.
 * Neither can say a person can make a note, type into it, reload, and find both
 * still there, which is the only claim worth making about a local-first notes
 * app. This drives the real application in a real browser and says that.
 *
 * The reload is the point. It is what separates "the store works" from "the
 * store is durable", and those are genuinely different questions: the live Yjs
 * document dies with the page, so anything still there afterwards came back out
 * of IndexedDB (ADR-0280). There is no worker and no OPFS file.
 */
import { chromium } from 'playwright';

const origin = process.argv[2] ?? 'http://localhost:5175';
const browser = await chromium.launch();
let failures = 0;
function check(label: string, held: boolean, detail: unknown = '') {
	if (!held) failures += 1;
	console.log(`  ${held ? 'held  ' : 'FAILED'}  ${label.padEnd(46)} ${detail}`);
}

try {
	const page = await browser.newPage();
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	page.on('console', (message) => {
		if (message.type() === 'error') errors.push(message.text());
	});

	await page.goto(origin, { waitUntil: 'networkidle' });
	await page.waitForTimeout(2500);
	console.log('1. it boots');
	check(
		'no page errors on boot',
		errors.length === 0,
		errors.slice(0, 2).join(' | '),
	);
	check(
		'the sidebar rendered',
		await page.getByText('Honeycrisp', { exact: true }).first().isVisible(),
	);

	console.log('\n2. make a note and type into it');
	const before = await page.locator('body').innerText();
	await page.keyboard.press('Meta+n');
	await page.waitForTimeout(800);
	const editor = page.locator('.ProseMirror').first();
	check('an editor appeared', await editor.isVisible().catch(() => false));
	await editor.click();
	await page.keyboard.type('Groceries');
	await page.keyboard.press('Enter');
	await page.keyboard.type('milk and eggs');
	await page.waitForTimeout(1200);

	const after = await page.locator('body').innerText();
	check('the note list shows the title', after.includes('Groceries'), '');
	check('the list changed', after !== before);
	check(
		'still no page errors',
		errors.length === 0,
		errors.slice(0, 2).join(' | '),
	);

	console.log('\n3. reload, and it is still there');
	await page.reload({ waitUntil: 'networkidle' });
	await page.waitForTimeout(2500);
	const reloaded = await page.locator('body').innerText();
	check('the note survived the reload', reloaded.includes('Groceries'));
	const prose = await page
		.locator('.ProseMirror')
		.first()
		.innerText()
		.catch(() => '');
	check(
		'its prose survived too',
		reloaded.includes('milk and eggs') || prose.includes('milk and eggs'),
		prose.slice(0, 60),
	);
	check(
		'no page errors after reload',
		errors.length === 0,
		errors.slice(0, 3).join(' | '),
	);
} finally {
	await browser.close();
}
console.log(
	failures === 0
		? '\nHoneycrisp runs on the new store.\n'
		: `\n${failures} FAILED\n`,
);
process.exit(failures === 0 ? 0 : 1);
