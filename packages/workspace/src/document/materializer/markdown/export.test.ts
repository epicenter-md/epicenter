/**
 * Markdown Export Tests
 *
 * Covers the read-only, free-serialization seam `attachMarkdownExport`: custom
 * filename, custom toMarkdown, per-table subdirectory. There is no `apply` here;
 * the only mutation is the destructive `markdown_rebuild`. Uses real temp
 * directories and Yjs workspaces.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createWorkspace, defineTable } from '../../../index.js';
import { field } from '@epicenter/field';
import { attachMarkdownExport } from './export.js';

const postsTable = defineTable({
	id: field.string(),
	title: field.string(),
	published: field.boolean(),
});

const tableDefinitions = { posts: postsTable };

const TEST_DIR = join(import.meta.dir, '__test-export__');

beforeEach(async () => {
	await mkdir(TEST_DIR, { recursive: true });
});

afterEach(async () => {
	await rm(TEST_DIR, { recursive: true, force: true });
});

async function listDir(relativePath: string) {
	return readdir(join(TEST_DIR, relativePath));
}

async function readDir(relativePath: string) {
	return readFile(join(TEST_DIR, relativePath), 'utf-8');
}

describe('attachMarkdownExport', () => {
	test('custom filename produces the named file', async () => {
		const workspace = createWorkspace({
			id: 'export-filename',
			tables: tableDefinitions,
			kv: {},
		});
		const exporter = attachMarkdownExport(workspace, {
			dir: TEST_DIR,
			tables: {
				posts: { filename: (row) => `${row.title}-${row.id}.md` },
			},
		});
		await exporter.whenFlushed;

		workspace.tables.posts.set({ id: 'a', title: 'alpha', published: true });
		await exporter.actions.markdown_rebuild({});

		const files = await listDir('posts');
		expect(files).toContain('alpha-a.md');

		workspace[Symbol.dispose]();
	});

	test('custom toMarkdown puts body in the body section and chosen keys in frontmatter', async () => {
		const workspace = createWorkspace({
			id: 'export-tomarkdown',
			tables: tableDefinitions,
			kv: {},
		});
		const exporter = attachMarkdownExport(workspace, {
			dir: TEST_DIR,
			tables: {
				posts: {
					toMarkdown: (row) => ({
						frontmatter: { id: row.id, title: row.title },
						body: `# ${row.title}\n\nPublished: ${row.published}`,
					}),
				},
			},
		});
		await exporter.whenFlushed;

		workspace.tables.posts.set({ id: 'a', title: 'Alpha', published: true });
		await exporter.actions.markdown_rebuild({});

		const content = await readDir('posts/a.md');
		// Chosen frontmatter keys present; the unselected `published` key is not.
		expect(content).toContain('title: Alpha');
		expect(content).not.toMatch(/^published:/m);
		// Body lands after the frontmatter block.
		expect(content).toContain('# Alpha');
		expect(content).toContain('Published: true');

		workspace[Symbol.dispose]();
	});

	test('custom per-table dir writes under that subdir', async () => {
		const workspace = createWorkspace({
			id: 'export-dir',
			tables: tableDefinitions,
			kv: {},
		});
		const exporter = attachMarkdownExport(workspace, {
			dir: TEST_DIR,
			tables: { posts: { dir: 'published' } },
		});
		await exporter.whenFlushed;

		workspace.tables.posts.set({ id: 'a', title: 'Alpha', published: true });
		await exporter.actions.markdown_rebuild({});

		const files = await listDir('published');
		expect(files).toContain('a.md');
		// The default `posts/` subdir was NOT used.
		await expect(listDir('posts')).rejects.toThrow();

		workspace[Symbol.dispose]();
	});

	test('markdown_rebuild removes an orphan and rewrites rows', async () => {
		const workspace = createWorkspace({
			id: 'export-rebuild',
			tables: tableDefinitions,
			kv: {},
		});
		const exporter = attachMarkdownExport(workspace, {
			dir: TEST_DIR,
			tables: { posts: {} },
		});
		await exporter.whenFlushed;

		workspace.tables.posts.set({ id: 'p1', title: 'Live', published: true });
		await exporter.actions.markdown_rebuild({});

		// Drop an orphan file that no row backs.
		await mkdir(join(TEST_DIR, 'posts'), { recursive: true });
		await writeFile(
			join(TEST_DIR, 'posts', 'orphan.md'),
			'---\nid: orphan\ntitle: Orphan\npublished: false\n---\n',
			'utf-8',
		);

		const before = await listDir('posts');
		expect(before).toContain('p1.md');
		expect(before).toContain('orphan.md');

		const result = await exporter.actions.markdown_rebuild({});

		expect(result.deleted).toBe(2); // p1.md + orphan.md both unlinked
		expect(result.written).toBe(1); // only p1 re-written

		const after = await listDir('posts');
		expect(after).toContain('p1.md');
		expect(after).not.toContain('orphan.md');

		workspace[Symbol.dispose]();
	});
});
