/**
 * The sanitizer boundary: everything email HTML must lose before it may reach
 * an `{@html}` sink. DOMPurify needs a DOM; jsdom is its documented Node
 * companion (happy-dom drops attributed elements under DOMPurify). The jsdom
 * `window` is installed as the global before `sanitize-email` is imported,
 * because DOMPurify binds to `window` at module load and the module's `addHook`
 * runs then too; the module is pulled in dynamically for that ordering.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';

let sanitizeEmailHtml: (html: string) => string;
const originalWindow = globalThis.window;
const originalDocument = globalThis.document;

beforeAll(async () => {
	const { window } = new JSDOM('');
	// DOMPurify's default instance reads the global `window`/`document`.
	(globalThis as { window?: unknown }).window = window;
	(globalThis as { document?: unknown }).document = window.document;
	({ sanitizeEmailHtml } = await import('./sanitize-email'));
});

afterAll(() => {
	if (originalWindow === undefined)
		delete (globalThis as { window?: unknown }).window;
	else (globalThis as { window?: unknown }).window = originalWindow;
	if (originalDocument === undefined) {
		delete (globalThis as { document?: unknown }).document;
	} else {
		(globalThis as { document?: unknown }).document = originalDocument;
	}
});

describe('sanitizeEmailHtml', () => {
	test('strips <script> and inline event handlers', () => {
		const out = sanitizeEmailHtml(
			'<p onclick="steal()">hi</p><script>evil()</script>',
		);
		expect(out).not.toContain('<script');
		expect(out).not.toContain('evil()');
		expect(out).not.toContain('onclick');
		expect(out).toContain('hi');
	});

	test('drops the onerror image-load vector', () => {
		const out = sanitizeEmailHtml('<img src="x" onerror="steal()">');
		expect(out.toLowerCase()).not.toContain('onerror');
		expect(out).not.toContain('steal()');
	});

	test('blocks remote image loads (src and srcset)', () => {
		const out = sanitizeEmailHtml(
			'<img src="https://tracker.test/pixel.gif" srcset="https://tracker.test/2x.gif 2x">',
		);
		// The <img> may remain, but nothing that fetches the remote asset does.
		expect(out).not.toContain('tracker.test');
		expect(out.toLowerCase()).not.toContain('src=');
		expect(out.toLowerCase()).not.toContain('srcset');
	});

	test('strips inline styles that pull a remote asset, keeps benign styles', () => {
		const remote = sanitizeEmailHtml(
			'<div style="background-image: url(https://tracker.test/bg.png)">x</div>',
		);
		expect(remote).not.toContain('tracker.test');
		expect(remote.toLowerCase()).not.toContain('url(');

		const benign = sanitizeEmailHtml('<div style="color: red">x</div>');
		expect(benign.toLowerCase()).toContain('color');
	});

	test('rewrites links to open in a new tab without leaking the opener', () => {
		const out = sanitizeEmailHtml('<a href="https://acme.test/pay">pay</a>');
		expect(out).toContain('target="_blank"');
		expect(out).toContain('rel="noopener noreferrer"');
		expect(out).toContain('href="https://acme.test/pay"');
	});

	test('drops javascript: link schemes', () => {
		const out = sanitizeEmailHtml('<a href="javascript:alert(1)">x</a>');
		expect(out.toLowerCase()).not.toContain('javascript:');
	});

	test('removes <style> and <link> blocks (remote CSS)', () => {
		const out = sanitizeEmailHtml(
			'<style>@import url(https://tracker.test/x.css)</style>' +
				'<link rel="stylesheet" href="https://tracker.test/y.css"><p>body</p>',
		);
		expect(out).not.toContain('tracker.test');
		expect(out).not.toContain('<style');
		expect(out).not.toContain('<link');
		expect(out).toContain('body');
	});
});
