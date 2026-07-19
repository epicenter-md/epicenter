/** Freeze the root-Yjs compatibility export to its named migration owners. */

import { expect, test } from 'bun:test';
import { resolve } from 'node:path';

const ALLOWED_IMPORTERS = [
	'apps/tab-manager/src/lib/workspace/definition.ts',
	'apps/vocab/vocab.ts',
	'packages/app-shell/src/agent-chat/agent-chat.svelte.ts',
];

test('only the bounded legacy apps import legacy-root-yjs', async () => {
	const root = resolve(import.meta.dir, '../../..');
	const importers: string[] = [];
	for (const sourceRoot of ['apps', 'packages']) {
		const glob = new Bun.Glob('**/*.{ts,svelte}');
		for await (const path of glob.scan({ cwd: resolve(root, sourceRoot) })) {
			const relativePath = `${sourceRoot}/${path}`;
			if (relativePath === 'packages/chat/src/legacy-root-yjs.test.ts')
				continue;
			const source = await Bun.file(resolve(root, relativePath)).text();
			if (source.includes('@epicenter/chat/legacy-root-yjs')) {
				importers.push(relativePath);
			}
		}
	}
	expect(importers.sort()).toEqual(ALLOWED_IMPORTERS);
});
