/**
 * The wiki vertical slice, end to end. One test walks the eight milestone
 * steps: define a type at runtime, create a page in it, materialize it to
 * `<id>.md`, edit the file, reconcile it back into Yjs, project a per-type
 * SQLite side table, answer a typed query, and prove a rename is metadata-only
 * while an add re-projects. Two focused tests cover the schema-on-read lens and
 * the rename-vs-add DDL distinction.
 *
 * If this loop holds, the architecture is real.
 */

import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nullable } from '@epicenter/workspace';
import { field } from '@epicenter/field';
import {
	assembleMarkdown,
	parseMarkdownFile,
} from '@epicenter/workspace/markdown';
import { createWiki } from './index';
import { viewThroughType } from './lens';
import { attachWikiVault } from './markdown';
import { projectWiki } from './projection';
import type { ColumnSpec, Page } from './schema';

const youtubeColumns: ColumnSpec[] = [
	{ id: 'url', name: 'URL', schema: field.url() },
	{
		id: 'duration',
		name: 'Duration',
		schema: nullable(field.number()),
	},
];

test('round-trips a typed page Yjs <-> markdown <-> Yjs and answers a typed SQLite query', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'wiki-vault-'));
	const wiki = createWiki();
	try {
		// 1 + 3. Define the youtube_video type at runtime (real column.* calls).
		const defined = wiki.actions.types_define({
			id: 'youtube_video',
			name: 'YouTube Video',
			columns: youtubeColumns,
		});
		expect(defined.error).toBeNull();

		// 4. Create a page carrying that type, with a body and epicenter:// source.
		const created = wiki.actions.pages_create({
			title: 'Great talk',
			source: ['epicenter://whispering/recordings/rec_123'],
			types: { youtube_video: { url: 'https://youtu.be/abc', duration: 1240 } },
			body: 'Notes about the talk.',
		});
		const pageId = created.id;

		// Materialize through the vault.
		const vault = attachWikiVault(wiki, { dir });
		await vault.whenFlushed;

		const pagePath = join(dir, 'pages', `${pageId}.md`);
		const pageMd = await readFile(pagePath, 'utf-8');
		expect(pageMd).toContain('https://youtu.be/abc');
		expect(pageMd).toContain('duration: 1240');
		expect(pageMd).toContain('Notes about the talk.');
		expect(pageMd).toContain('epicenter://whispering/recordings/rec_123');

		// types/<id>.md carries the column schema as JSON.
		const typeMd = await readFile(
			join(dir, 'types', 'youtube_video.md'),
			'utf-8',
		);
		expect(typeMd).toContain('format: uri'); // field.url()

		// 5. Edit the .md as a text editor would, then reconcile (markdown apply).
		const parsed = parseMarkdownFile(pageMd)!;
		(parsed.frontmatter.types as Page['types']).youtube_video!.duration = 999;
		await writeFile(
			pagePath,
			assembleMarkdown(parsed.frontmatter, 'Edited notes.'),
		);

		const push = await vault.actions.markdown_push();
		expect(push.errored).toBe(0);

		const after = wiki.actions.pages_get({ id: pageId }).data!;
		expect(after.types.youtube_video!.duration).toBe(999);
		expect(after.types.youtube_video!.url).toBe('https://youtu.be/abc');
		expect(after.body).toBe('Edited notes.');

		// 6 + 7. Project per-type SQLite and answer a typed query.
		const db = new Database(':memory:');
		try {
			projectWiki(db, {
				types: wiki.actions.types_get_all(),
				pages: wiki.actions.pages_get_all(),
			});
			const rows = db
				.query<{ title: string; d: number }, [number]>(
					'SELECT p.title, yv.c_duration AS d ' +
						'FROM wiki_pages p ' +
						'JOIN wiki_type_youtube_video yv ON yv.page_id = p.id ' +
						'WHERE yv.c_duration > ?',
				)
				.all(500);
			expect(rows).toHaveLength(1);
			expect(rows[0]!.title).toBe('Great talk');
			expect(rows[0]!.d).toBe(999);
		} finally {
			db.close();
		}
	} finally {
		wiki[Symbol.dispose]();
		await rm(dir, { recursive: true, force: true });
	}
});

test('schema-on-read lens buckets match / excess / missing', () => {
	// Current schema declares url, duration, rating; the stored data has url,
	// a malformed duration, and an unknown `channel`.
	const columns: ColumnSpec[] = [
		...youtubeColumns,
		{ id: 'rating', name: 'Rating', schema: field.number() },
	];
	const data = {
		url: 'https://youtu.be/abc',
		duration: 'not-a-number',
		channel: 'Veritasium',
	};

	const lens = viewThroughType({ typeId: 'youtube_video', columns, data });

	const matchById = Object.fromEntries(lens.match.map((m) => [m.id, m]));
	expect(lens.match.map((m) => m.id).sort()).toEqual(['duration', 'url']);
	expect(matchById.url!.valid).toBe(true);
	// Stored but invalid under the current schema: surfaced, never dropped.
	expect(matchById.duration!.valid).toBe(false);
	expect(lens.missing.map((m) => m.id)).toEqual(['rating']);
	expect(lens.excess.map((e) => e.id)).toEqual(['channel']);
	expect(lens.excess[0]!.value).toBe('Veritasium');
});

test('types_define rejects a non-slug type id at definition time', () => {
	const wiki = createWiki();
	try {
		const result = wiki.actions.types_define({
			id: 'Not A Slug',
			name: 'Bad',
			columns: [{ id: 'x', name: 'X', schema: field.string() }],
		});
		expect(result.error?.name).toBe('InvalidTypeId');
		expect(wiki.actions.types_get_all()).toHaveLength(0);
	} finally {
		wiki[Symbol.dispose]();
	}
});

test('column rename is metadata-only; adding a column re-projects', () => {
	const wiki = createWiki();
	const db = new Database(':memory:');
	try {
		wiki.actions.types_define({
			id: 'youtube_video',
			name: 'YouTube Video',
			columns: youtubeColumns,
		});
		wiki.actions.pages_create({
			title: 'clip',
			types: { youtube_video: { url: 'https://youtu.be/abc', duration: 10 } },
		});

		const project = () =>
			projectWiki(db, {
				types: wiki.actions.types_get_all(),
				pages: wiki.actions.pages_get_all(),
			}).typeTableDdl.youtube_video;

		const ddlBefore = project();

		// Rename display names only; the stable column ids never change.
		wiki.actions.types_define({
			id: 'youtube_video',
			name: 'YouTube Video',
			columns: [
				{ id: 'url', name: 'Link', schema: field.url() },
				{
					id: 'duration',
					name: 'Length',
					schema: nullable(field.number()),
				},
			],
		});
		expect(project()).toBe(ddlBefore); // no DDL: a rename is metadata-only

		// Add a column: the physical shape changes, so projection emits new DDL.
		wiki.actions.types_define({
			id: 'youtube_video',
			name: 'YouTube Video',
			columns: [
				{ id: 'url', name: 'Link', schema: field.url() },
				{
					id: 'duration',
					name: 'Length',
					schema: nullable(field.number()),
				},
				{ id: 'rating', name: 'Rating', schema: field.number() },
			],
		});
		const ddlAfterAdd = project();
		expect(ddlAfterAdd).not.toBe(ddlBefore);
		expect(ddlAfterAdd).toContain('"c_rating"');
	} finally {
		db.close();
		wiki[Symbol.dispose]();
	}
});
