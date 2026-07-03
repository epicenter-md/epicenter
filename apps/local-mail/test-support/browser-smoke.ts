/**
 * Browser smoke for the Local Mail triage SPA. Drives the ALREADY-INSTALLED
 * system Chrome via puppeteer-core (no bundled browser download) against the
 * safe harness (throwaway mirror copy + mock Gmail + `local-mail up`), and
 * verifies the four write-UX affordances a headless API driver can't see:
 *
 *   1. `?` opens the keyboard-shortcuts overlay
 *   2. clicking Archive shows an "Archived / Undo" toast, and Undo fires the
 *      inverse write (add INBOX) at the mock
 *   3. a `folded:false` write flips the StatusBar mirror chip to "catching up"
 *   4. the `e` key dispatches an archive through the SAME path, hitting the mock
 *
 * It boots the mock in `folded:false` mode so every write exercises the
 * catching-up chip, asserts against the mock modify log and the live DOM, then
 * proves the REAL mirror is byte-identical before and after.
 *
 *   bun run apps/local-mail/test-support/browser-smoke.ts
 *
 * LOCAL tooling, not CI: it needs a real connected mirror to copy from and a
 * local Chrome. Set CHROME_PATH to override the browser binary.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer, { type ConsoleMessage, type Page } from 'puppeteer-core';
import {
	bootHarness,
	fingerprintReal,
	type ModifyLogEntry,
	readModifyLog,
} from './boot.ts';

const APP_DIR = join(import.meta.dir, '..');
const UI_DIST = join(APP_DIR, 'ui', 'dist');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function resolveChrome(): string {
	const candidates = [
		process.env.CHROME_PATH,
		process.env.PUPPETEER_EXECUTABLE_PATH,
		'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
		'/usr/bin/google-chrome',
		'/usr/bin/chromium',
	].filter((p): p is string => Boolean(p));
	const found = candidates.find((p) => existsSync(p));
	if (!found) {
		throw new Error(`no Chrome found; set CHROME_PATH. Tried:\n${candidates.join('\n')}`);
	}
	return found;
}

/** Ensure the SPA is built, since `up` serves it from disk. */
async function ensureBuilt(): Promise<void> {
	if (existsSync(join(UI_DIST, 'index.html'))) return;
	console.log('[browser-smoke] SPA not built; running the UI build (once)...');
	const build = Bun.spawn(['bun', 'run', '--cwd', join(APP_DIR, 'ui'), 'build'], {
		stdout: 'inherit',
		stderr: 'inherit',
	});
	if ((await build.exited) !== 0) throw new Error('UI build failed');
}

/** Poll the mock modify log until `pred` holds, or time out. */
async function waitForLog(
	mockLog: string,
	pred: (log: ModifyLogEntry[]) => boolean,
	what: string,
	timeoutMs = 5_000,
): Promise<ModifyLogEntry[]> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const log = readModifyLog(mockLog);
		if (pred(log)) return log;
		await sleep(100);
	}
	throw new Error(`timed out waiting for ${what}`);
}

/** Click the detail-toolbar button whose visible text matches exactly. */
async function clickButtonByText(page: Page, text: string): Promise<void> {
	const clicked = await page.evaluate((text: string) => {
		const btn = [...document.querySelectorAll('section button')].find(
			(b) => b.textContent?.trim() === text,
		);
		if (!(btn instanceof HTMLElement)) return false;
		btn.click();
		return true;
	}, text);
	if (!clicked) throw new Error(`button not found: ${text}`);
}

function assert(cond: unknown, msg: string): asserts cond {
	if (!cond) throw new Error(msg);
}

async function main(): Promise<void> {
	const chrome = resolveChrome();
	await ensureBuilt();
	const before = await fingerprintReal();

	// folded:false so every write flips the catching-up chip.
	const harness = await bootHarness({ fold: false });
	const browser = await puppeteer.launch({
		executablePath: chrome,
		headless: true,
		args: ['--no-sandbox', '--window-size=1280,860'],
		defaultViewport: { width: 1280, height: 860 },
	});
	const consoleErrors: string[] = [];
	try {
		const page = await browser.newPage();
		page.on('console', (m: ConsoleMessage) => {
			if (m.type() === 'error') consoleErrors.push(m.text());
		});
		page.on('pageerror', (e: unknown) =>
			consoleErrors.push(`pageerror: ${e instanceof Error ? e.message : String(e)}`),
		);

		// The SPA reads #token, exchanges it for a bearer, and loads the mirror.
		await page.goto(`${harness.appOrigin}/#token=${harness.bootstrapToken}`, {
			waitUntil: 'networkidle2',
			timeout: 30_000,
		});
		// Detail pane loaded => the auto-selected first inbox message is ready.
		await page.waitForFunction(
			() =>
				[...document.querySelectorAll('section button')].some(
					(b) => b.textContent?.trim() === 'Archive',
				),
			{ timeout: 15_000 },
		);

		// --- 1. `?` opens the shortcuts overlay ------------------------------
		await page.keyboard.press('?');
		await page.waitForFunction(
			() =>
				/Keyboard shortcuts/.test(
					document.querySelector('[role="dialog"]')?.textContent ?? '',
				),
			{ timeout: 5_000 },
		);
		await page.keyboard.press('Escape');
		await page.waitForFunction(() => !document.querySelector('[role="dialog"]'), {
			timeout: 5_000,
		});

		// --- 2. Archive -> toast -> Undo (+ 3. catching-up chip) --------------
		await clickButtonByText(page, 'Archive');
		// Toast with an Undo affordance.
		await page.waitForFunction(
			() => {
				const t = document.querySelector('[data-sonner-toast]');
				return (
					!!t &&
					/Archived/.test(t.textContent ?? '') &&
					[...t.querySelectorAll('button')].some((b) => /undo/i.test(b.textContent ?? ''))
				);
			},
			{ timeout: 5_000 },
		);
		// 3. the folded:false write flipped the mirror chip.
		await page.waitForFunction(
			() =>
				document.querySelector('header span.capitalize')?.textContent?.trim() ===
				'catching up',
			{ timeout: 5_000 },
		);
		// The archive reached the mock as a remove-INBOX.
		const afterArchive = await waitForLog(
			harness.mockLog,
			(l) => l.length > 0,
			'archive at the mock',
		);
		const archived = afterArchive[afterArchive.length - 1]!;
		assert(archived.remove.includes('INBOX'), `archive should remove INBOX, got ${JSON.stringify(archived)}`);
		assert(archived.folded === false, 'archive should be folded:false in this run');

		// Click Undo; it fires the inverse (add INBOX) at the mock.
		const undoClicked = await page.evaluate(() => {
			const undo = [...document.querySelectorAll('[data-sonner-toast] button')].find(
				(b) => /undo/i.test(b.textContent ?? ''),
			);
			if (!(undo instanceof HTMLElement)) return false;
			undo.click();
			return true;
		});
		assert(undoClicked, 'Undo button not found in the toast');
		await waitForLog(
			harness.mockLog,
			(l) => l.some((e) => e.id === archived.id && e.add.includes('INBOX')),
			`undo add-INBOX for ${archived.id}`,
		);

		// --- 4. `e` key dispatches an archive through the same path -----------
		const beforeKey = readModifyLog(harness.mockLog).length;
		await page.keyboard.press('e');
		const afterKey = await waitForLog(
			harness.mockLog,
			(l) => l.length > beforeKey,
			'the `e` key at the mock',
		);
		const keyed = afterKey[afterKey.length - 1]!;
		assert(keyed.remove.includes('INBOX'), `e-archive should remove INBOX, got ${JSON.stringify(keyed)}`);

		// Prove the real mirror is untouched.
		const after = await fingerprintReal();
		assert(after === before, `REAL mirror changed!\nbefore:\n${before}\nafter:\n${after}`);

		console.log('BROWSER SMOKE PASS');
		console.log('  1. ? overlay opened');
		console.log(`  2. archive toast + undo fired inverse add:[INBOX] on ${archived.id}`);
		console.log('  3. mirror chip flipped to "catching up" on the folded:false write');
		console.log(`  4. e key dispatched archive remove:[INBOX] on ${keyed.id}`);
		console.log(`  real mirror fingerprint unchanged (${before.split('\n').length} files)`);
		if (consoleErrors.length) {
			console.log(`  note: ${consoleErrors.length} console error(s): ${JSON.stringify(consoleErrors)}`);
		}
	} finally {
		await browser.close();
		harness.teardown();
	}
}

try {
	await main();
	process.exit(0);
} catch (err) {
	console.error(`BROWSER SMOKE FAIL: ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
}
