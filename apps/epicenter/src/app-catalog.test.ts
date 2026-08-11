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
import { COMPOSED_APP_IDS } from '@epicenter/constants/app-data';
import { DATA_ADDRESS_CEILINGS, isNamespace } from '@epicenter/lens';
import {
	loadActiveAppCatalog,
	promoteAppCatalogCandidate,
} from './app-catalog.ts';
import type { AppCatalog } from './static-assets.ts';

function tempDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * One candidate app output: `<root>/<dir>/index.html` and its `lens.json`.
 *
 * The directory name means nothing (ADR-0210), so these fixtures name it after
 * the namespace the Lens declares. That keeps a test readable while leaving the
 * id where it really comes from, which is the declaration.
 */
function writeApp(
	root: string,
	id: string,
	{
		page = `<!doctype html><title>${id}</title>`,
		files = {},
		title,
		lens = {
			namespace: id,
			...(title === undefined ? {} : { title }),
			tables: {},
		} as unknown,
		directory = id,
	}: {
		page?: string;
		files?: Record<string, string>;
		title?: string;
		lens?: unknown;
		directory?: string;
	} = {},
): void {
	mkdirSync(join(root, directory), { recursive: true });
	writeFileSync(join(root, directory, 'index.html'), page);
	if (lens !== null) {
		writeFileSync(
			join(root, directory, 'lens.json'),
			typeof lens === 'string' ? lens : JSON.stringify(lens),
		);
	}
	id = directory;
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
	return loadActiveAppCatalog(catalogRoot);
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
			candidateWith('so.test.notes'),
		);
		rmSync(join(root, 'generations', generation), { recursive: true });
		expect((await load(root)).apps).toEqual([]);
	});

	test('a malformed pointer selects nothing', async () => {
		const root = tempDir('epicenter-catalog-root-');
		await promoteAppCatalogCandidate(root, candidateWith('so.test.notes'));
		writeFileSync(join(root, 'current'), '../../escape');
		expect((await load(root)).apps).toEqual([]);
	});
});

describe('promoteAppCatalogCandidate', () => {
	test('a promoted candidate is the next load, listed and served', async () => {
		const root = tempDir('epicenter-catalog-root-');
		const candidate = candidateWith('so.test.notes', {
			title: 'Notes',
			files: { 'assets/entry.js': 'console.log(1);' },
		});

		const promoted = await promoteAppCatalogCandidate(root, candidate);
		expect(promoted.apps).toEqual([{ id: 'so.test.notes', title: 'Notes' }]);

		const catalog = await load(root);
		expect(catalog.apps.map((app) => [app.id, app.title])).toEqual([
			['so.test.notes', 'Notes'],
		]);
		expect(await pageText(catalog, 'so.test.notes')).toContain('so.test.notes');
		expect(
			await pageText(
				catalog,
				'so.test.notes',
				'/apps/so.test.notes/assets/entry.js',
			),
		).toContain('console.log');
	});

	test('a loaded catalog keeps serving its generation after a promotion; a new load gets the promoted one', async () => {
		const root = tempDir('epicenter-catalog-root-');
		await promoteAppCatalogCandidate(
			root,
			candidateWith('so.test.notes', {
				title: 'Notes A',
				page: '<!doctype html>Notes A',
			}),
		);
		const running = await load(root);
		expect(await pageText(running, 'so.test.notes')).toContain('Notes A');

		await promoteAppCatalogCandidate(
			root,
			candidateWith('so.test.notes', {
				title: 'Notes B',
				page: '<!doctype html>Notes B',
			}),
		);

		// The already-selected generation is untouched by the promotion.
		expect(await pageText(running, 'so.test.notes')).toContain('Notes A');
		expect(running.apps.map((app) => app.title)).toEqual(['Notes A']);

		const restarted = await load(root);
		expect(await pageText(restarted, 'so.test.notes')).toContain('Notes B');
	});

	test('an invalid candidate fails whole and leaves the previous selection active', async () => {
		const root = tempDir('epicenter-catalog-root-');
		await promoteAppCatalogCandidate(
			root,
			candidateWith('so.test.notes', {
				title: 'Notes A',
				page: '<!doctype html>Notes A',
			}),
		);

		const noIndex = tempDir('epicenter-candidate-');
		writeApp(noIndex, 'so.test.valid');
		mkdirSync(join(noIndex, 'no-index'));

		// A declaration that is not a Lens, and one whose namespace is a bare
		// label. Both are the same refusal now: an id is a namespace (ADR-0210).
		const notALens = tempDir('epicenter-candidate-');
		writeApp(notALens, 'so.test.broken', { lens: '{ not json' });

		const bareNamespace = tempDir('epicenter-candidate-');
		writeApp(bareNamespace, 'whispering', {
			lens: { namespace: 'whispering', tables: {} },
		});

		const noDeclaration = tempDir('epicenter-candidate-');
		writeApp(noDeclaration, 'so.test.silent', { lens: null });

		const strayFile = tempDir('epicenter-candidate-');
		writeApp(strayFile, 'so.test.valid');
		writeFileSync(join(strayFile, 'README.md'), 'not an app');

		for (const [candidate, refused] of [
			[noIndex, 'no-index'],
			[notALens, 'so.test.broken'],
			[bareNamespace, 'whispering'],
			[noDeclaration, 'so.test.silent'],
			[strayFile, 'README.md'],
		] as const) {
			await expect(promoteAppCatalogCandidate(root, candidate)).rejects.toThrow(
				refused,
			);
		}
		await expect(
			promoteAppCatalogCandidate(
				root,
				join(tempDir('epicenter-candidate-'), 'missing'),
			),
		).rejects.toThrow('not a directory');

		const catalog = await load(root);
		expect(await pageText(catalog, 'so.test.notes')).toContain('Notes A');
		// Failed promotions leave no selectable generation or staging debris.
		const generations = readdirSync(join(root, 'generations')).filter(
			(name) => !name.startsWith('.'),
		);
		expect(generations).toHaveLength(1);
	});

	test('an id the host already spent cannot be claimed, because it is not a namespace', async () => {
		// An app id names a place under the one data root, and every trusted app
		// has one (ADR-0201). A second claimant on the directory holding Local
		// Mail's credentials and its undelivered intent used to be refused by a
		// reserved-id list. There is none now: an installed app's id is the
		// namespace it declares (ADR-0210), so it always has a dot, and every id
		// this host already spent is a bare label. The sets are disjoint by
		// grammar, which is what this test pins.
		const root = tempDir('epicenter-catalog-root-');
		for (const id of [
			...COMPOSED_APP_IDS,
			'home',
			'whispering',
			'honeycrisp',
		]) {
			expect(isNamespace(id, DATA_ADDRESS_CEILINGS)).toBe(false);
			await expect(
				promoteAppCatalogCandidate(
					root,
					candidateWith(id, { lens: { namespace: id, tables: {} } }),
				),
			).rejects.toThrow(id);
		}
		expect((await load(root)).apps).toEqual([]);
	});

	test('two folders declaring one namespace admit neither', async () => {
		// The filesystem used to make this check for us by refusing two
		// directories with one name. Folder names mean nothing now.
		const root = tempDir('epicenter-catalog-root-');
		const candidate = tempDir('epicenter-candidate-');
		writeApp(candidate, 'so.test.twin', { directory: 'first' });
		writeApp(candidate, 'so.test.twin', { directory: 'second' });
		await expect(promoteAppCatalogCandidate(root, candidate)).rejects.toThrow(
			'second',
		);
		expect((await load(root)).apps).toEqual([]);
	});

	test('a failed copy cleans staging and path overlap is refused before copying', async () => {
		const root = tempDir('epicenter-catalog-root-');
		const broken = candidateWith('so.test.notes');
		symlinkSync(
			join(broken, 'missing.js'),
			join(broken, 'so.test.notes', 'broken.js'),
		);
		await expect(promoteAppCatalogCandidate(root, broken)).rejects.toThrow();
		expect(readdirSync(join(root, 'generations'))).toEqual([]);

		const outerCandidate = candidateWith('so.test.notes');
		await expect(
			promoteAppCatalogCandidate(
				join(outerCandidate, 'catalog'),
				outerCandidate,
			),
		).rejects.toThrow('must not overlap');

		const outerCatalog = tempDir('epicenter-catalog-root-');
		const innerCandidate = join(outerCatalog, 'candidate');
		writeApp(innerCandidate, 'so.test.notes');
		await expect(
			promoteAppCatalogCandidate(outerCatalog, innerCandidate),
		).rejects.toThrow('must not overlap');
	});

	test('an empty candidate promotes an empty catalog (uninstall leaves data, not apps)', async () => {
		const root = tempDir('epicenter-catalog-root-');
		await promoteAppCatalogCandidate(root, candidateWith('so.test.notes'));
		await promoteAppCatalogCandidate(root, tempDir('epicenter-candidate-'));
		expect((await load(root)).apps).toEqual([]);
	});

	test('generations are self-contained copies: symlinks materialize and source edits never reach served bytes', async () => {
		const root = tempDir('epicenter-catalog-root-');
		const source = tempDir('epicenter-source-');
		writeFileSync(join(source, 'shared.js'), 'original');
		const candidate = candidateWith('so.test.notes');
		symlinkSync(
			join(source, 'shared.js'),
			join(candidate, 'so.test.notes', 'shared.js'),
		);

		await promoteAppCatalogCandidate(root, candidate);
		const catalog = await load(root);
		expect(
			await pageText(catalog, 'so.test.notes', '/apps/so.test.notes/shared.js'),
		).toBe('original');

		writeFileSync(join(source, 'shared.js'), 'edited after publish');
		writeFileSync(
			join(candidate, 'so.test.notes', 'index.html'),
			'edited candidate',
		);
		expect(
			await pageText(catalog, 'so.test.notes', '/apps/so.test.notes/shared.js'),
		).toBe('original');
		expect(await pageText(catalog, 'so.test.notes')).toContain('so.test.notes');
	});

	test('containment and SPA fallback hold through the active generation', async () => {
		const root = tempDir('epicenter-catalog-root-');
		await promoteAppCatalogCandidate(
			root,
			candidateWith('so.test.spa', {
				title: 'SPA',
				files: { 'assets/entry.js': 'console.log(1);' },
			}),
		);
		const catalog = await load(root);

		expect(
			await pageText(
				catalog,
				'so.test.spa',
				'/apps/so.test.spa/settings/audio',
			),
		).toContain('so.test.spa');
		for (const denied of [
			'/apps/so.test.spa/../other/index.html',
			'/apps/so.test.spa/%2e%2e/%2e%2e/current',
			'/apps/so.test.spa/assets/missing.js',
		]) {
			expect(await pageText(catalog, 'so.test.spa', denied)).toBeUndefined();
		}
	});
});
