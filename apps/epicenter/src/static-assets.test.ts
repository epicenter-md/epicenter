import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadStaticAssets } from './static-assets.ts';

test('loads only the explicitly compiled application directories', async () => {
	const root = await mkdtemp(join(tmpdir(), 'epicenter-assets-'));
	await mkdir(join(root, 'home'));
	await mkdir(join(root, 'mail'));
	await writeFile(join(root, 'home', 'index.html'), '<title>Home</title>');
	await writeFile(join(root, 'mail', 'index.html'), '<title>Mail</title>');

	const assets = await loadStaticAssets(root, [{ id: 'mail', title: 'Mail' }]);
	expect(assets.applications).toHaveLength(1);
	expect(await assets.applications[0]?.resolve('/apps/mail/')).toMatchObject({
		isDocument: true,
	});
});
