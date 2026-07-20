/**
 * Immutable Catalog Generation Tests
 *
 * Verifies the ADR-0153 activation contract: a catalog loaded at startup
 * keeps serving its generation even after a newer candidate is promoted,
 * promotion is atomic, and a failed or invalid candidate can never change
 * the selection.
 *
 * Key behaviors:
 * - A missing root, missing pointer, or dangling pointer is an empty catalog
 * - Promotion validates every candidate entry; one refused entry fails the
 *   whole promotion and leaves the previous selection active
 * - An already-loaded catalog stays on its generation across promotions;
 *   only a new load sees the promoted one
 * - Promoted generations are self-contained copies: candidate symlinks are
 *   materialized and later source edits do not change served bytes
 * - Containment and SPA fallback hold through the active generation
 *
 * See also:
 * - `static-assets.test.ts` for the member derivation and resolver contract
 */

import { describe, expect, test } from 'bun:test';
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	loadActiveAppCatalog,
	promoteAppCatalogCandidate,
} from './app-catalog.ts';
import { SURFACE_ROUTES } from './routes.ts';
import type { AppCatalog } from './static-assets.ts';

const RESERVED = { reservedIds: Object.keys(SURFACE_ROUTES) };

function tempDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

/** One candidate app output: `<root>/<id>/index.html` plus optional files. */
function writeApp(
	root: string,
	id: string,
	{
		page = `<!doctype html><title>${id}</title>`,
		files = {},
	}: { page?: string; files?: Record<string, string> } = {},
): void {
	mkdirSync(join(root, id), { recursive: true });
	writeFileSync(join(root, id, 'index.html'), page);
	for (const [name, content] of Object.entries(files)) {
		const path = join(root, id, ...name.split('/'));
		mkdirSync(join(path, '..'), { recursive: true });
		writeFileSync(path, content);
	}
}

function candidateWith(
	id: string,
	options?: Parameters<typeof writeApp>[2],
): string {
	const candidate = tempDir('epicenter-candidate-');
	writeApp(candidate, id, options);
	return candidate;
}

async function load(catalogRoot: string): Promise<AppCatalog> {
	return loadActiveAppCatalog(catalogRoot, RESERVED);
}

async function pageText(
	catalog: AppCatalog,
	id: string,
	pathname = `/apps/${id}/`,
): Promise<string | undefined> {
	const member = catalog.apps.find((app) => app.id === id);
	const asset = await member?.resolve(pathname);
	return asset === undefined ? undefined : await asset.file.text();
}

describe('loadActiveAppCatalog', () => {
	test('missing root, missing pointer, and dangling pointer are empty catalogs', async () => {
		const root = tempDir('epicenter-catalog-root-');
		expect((await load(join(root, 'never-created'))).apps).toEqual([]);
		expect((await load(root)).apps).toEqual([]);

		const { generation } = await promoteAppCatalogCandidate(
			root,
			candidateWith('notes'),
			RESERVED,
		);
		rmSync(join(root, 'generations', generation), { recursive: true });
		expect((await load(root)).apps).toEqual([]);
	});

	test('a malformed pointer selects nothing', async () => {
		const root = tempDir('epicenter-catalog-root-');
		await promoteAppCatalogCandidate(root, candidateWith('notes'), RESERVED);
		writeFileSync(join(root, 'current'), '../../escape');
		expect((await load(root)).apps).toEqual([]);
	});
});

describe('promoteAppCatalogCandidate', () => {
	test('a promoted candidate is the next load, listed and served', async () => {
		const root = tempDir('epicenter-catalog-root-');
		const candidate = candidateWith('notes', {
			page: '<!doctype html><title>Notes</title>',
			files: { 'assets/entry.js': 'console.log(1);' },
		});

		const promoted = await promoteAppCatalogCandidate(
			root,
			candidate,
			RESERVED,
		);
		expect(promoted.apps).toEqual([{ id: 'notes', title: 'Notes' }]);

		const catalog = await load(root);
		expect(catalog.apps.map((app) => [app.id, app.title])).toEqual([
			['notes', 'Notes'],
		]);
		expect(await pageText(catalog, 'notes')).toContain('Notes');
		expect(
			await pageText(catalog, 'notes', '/apps/notes/assets/entry.js'),
		).toContain('console.log');
	});

	test('a loaded catalog keeps serving its generation after a promotion; a new load gets the promoted one', async () => {
		const root = tempDir('epicenter-catalog-root-');
		await promoteAppCatalogCandidate(
			root,
			candidateWith('notes', { page: '<!doctype html><title>Notes A</title>' }),
			RESERVED,
		);
		const running = await load(root);
		expect(await pageText(running, 'notes')).toContain('Notes A');

		await promoteAppCatalogCandidate(
			root,
			candidateWith('notes', { page: '<!doctype html><title>Notes B</title>' }),
			RESERVED,
		);

		// The already-selected generation is untouched by the promotion.
		expect(await pageText(running, 'notes')).toContain('Notes A');
		expect(running.apps.map((app) => app.title)).toEqual(['Notes A']);

		const restarted = await load(root);
		expect(await pageText(restarted, 'notes')).toContain('Notes B');
	});

	test('an invalid candidate fails whole and leaves the previous selection active', async () => {
		const root = tempDir('epicenter-catalog-root-');
		await promoteAppCatalogCandidate(
			root,
			candidateWith('notes', { page: '<!doctype html><title>Notes A</title>' }),
			RESERVED,
		);

		const noIndex = tempDir('epicenter-candidate-');
		writeApp(noIndex, 'valid-app');
		mkdirSync(join(noIndex, 'no-index'));

		const badId = tempDir('epicenter-candidate-');
		writeApp(badId, 'Bad_Case');

		const reserved = tempDir('epicenter-candidate-');
		writeApp(reserved, 'whispering');

		const strayFile = tempDir('epicenter-candidate-');
		writeApp(strayFile, 'valid-app');
		writeFileSync(join(strayFile, 'README.md'), 'not an app');

		for (const [candidate, refused] of [
			[noIndex, 'no-index'],
			[badId, 'Bad_Case'],
			[reserved, 'whispering'],
			[strayFile, 'README.md'],
		] as const) {
			await expect(
				promoteAppCatalogCandidate(root, candidate, RESERVED),
			).rejects.toThrow(refused);
		}
		await expect(
			promoteAppCatalogCandidate(
				root,
				join(tempDir('epicenter-candidate-'), 'missing'),
				RESERVED,
			),
		).rejects.toThrow('not a directory');

		const catalog = await load(root);
		expect(await pageText(catalog, 'notes')).toContain('Notes A');
		// Failed promotions leave no selectable generation or staging debris.
		const generations = readdirSync(join(root, 'generations')).filter(
			(name) => !name.startsWith('.'),
		);
		expect(generations).toHaveLength(1);
	});

	test('an empty candidate promotes an empty catalog (uninstall leaves data, not apps)', async () => {
		const root = tempDir('epicenter-catalog-root-');
		await promoteAppCatalogCandidate(root, candidateWith('notes'), RESERVED);
		await promoteAppCatalogCandidate(
			root,
			tempDir('epicenter-candidate-'),
			RESERVED,
		);
		expect((await load(root)).apps).toEqual([]);
	});

	test('generations are self-contained copies: symlinks materialize and source edits never reach served bytes', async () => {
		const root = tempDir('epicenter-catalog-root-');
		const source = tempDir('epicenter-source-');
		writeFileSync(join(source, 'shared.js'), 'original');
		const candidate = candidateWith('notes');
		symlinkSync(
			join(source, 'shared.js'),
			join(candidate, 'notes', 'shared.js'),
		);

		await promoteAppCatalogCandidate(root, candidate, RESERVED);
		const catalog = await load(root);
		expect(await pageText(catalog, 'notes', '/apps/notes/shared.js')).toBe(
			'original',
		);

		writeFileSync(join(source, 'shared.js'), 'edited after publish');
		writeFileSync(join(candidate, 'notes', 'index.html'), 'edited candidate');
		expect(await pageText(catalog, 'notes', '/apps/notes/shared.js')).toBe(
			'original',
		);
		expect(await pageText(catalog, 'notes')).toContain('notes');
	});

	test('containment and SPA fallback hold through the active generation', async () => {
		const root = tempDir('epicenter-catalog-root-');
		await promoteAppCatalogCandidate(
			root,
			candidateWith('spa', {
				page: '<!doctype html><title>SPA</title>',
				files: { 'assets/entry.js': 'console.log(1);' },
			}),
			RESERVED,
		);
		const catalog = await load(root);

		expect(
			await pageText(catalog, 'spa', '/apps/spa/settings/audio'),
		).toContain('SPA');
		for (const denied of [
			'/apps/spa/../other/index.html',
			'/apps/spa/%2e%2e/%2e%2e/current',
			'/apps/spa/assets/missing.js',
		]) {
			expect(await pageText(catalog, 'spa', denied)).toBeUndefined();
		}
	});
});
