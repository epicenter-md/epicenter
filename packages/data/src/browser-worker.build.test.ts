/**
 * Build-shape contract for the browser storage worker.
 *
 * The dedicated worker must reach the browser as its own same-origin asset. It
 * is loaded under the desktop host's enforcing Content-Security-Policy, whose
 * `worker-src` is `'self' blob:` (ADR-0183 makes that policy the boundary, not
 * a hint), so a worker inlined as a `data:` module is refused at runtime with
 * nothing useful in the error.
 *
 * Nothing about that failure is visible at build time: the bundle is produced,
 * typechecking passes, and only a real desktop surface reports it. Bundlers
 * recognize workers by matching the literal `new Worker(new URL('...',
 * import.meta.url))` syntax, so any refactor that routes construction through
 * an alias silently reintroduces the inlined form. This test is the thing that
 * notices.
 */
import { expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'vite';

test('the browser entry emits its worker as a same-origin asset', async () => {
	const outDir = mkdtempSync(join(tmpdir(), 'epicenter-worker-build-'));
	try {
		await build({
			logLevel: 'silent',
			// Mirrors how the Epicenter surfaces consume this package: source, ES
			// module workers, no transpile down from the desktop webview's target.
			worker: { format: 'es' },
			build: {
				target: 'esnext',
				outDir,
				emptyOutDir: true,
				rollupOptions: {
					input: join(import.meta.dirname, 'browser.ts'),
				},
			},
		});

		const files = readdirSync(outDir, { recursive: true, withFileTypes: true })
			.filter((entry) => entry.isFile())
			.map((entry) => join(entry.parentPath, entry.name));

		const workerAssets = files.filter((file) =>
			file.includes('browser-dedicated-worker'),
		);
		expect(workerAssets).not.toBeEmpty();

		// A real compiled worker, not the raw source copied through. `assetsInlineLimit: 0`
		// produces a same-origin `.ts` file that only looks like a fix.
		for (const asset of workerAssets) {
			expect(asset.endsWith('.ts')).toBeFalse();
		}

		// Nothing reconstructs the worker from an inline module beside the asset.
		// The token has to be the one Vite actually writes: its inline-worker
		// branch emits `data:text/javascript;charset=utf-8,` (and a Blob of the
		// same type), never `application/javascript`, so a check spelled the
		// other way reads as coverage while being unable to fire.
		for (const file of files.filter((file) => file.endsWith('.js'))) {
			expect(readFileSync(file, 'utf8')).not.toInclude('data:text/javascript');
		}
	} finally {
		rmSync(outDir, { recursive: true, force: true });
	}
}, 120_000);
