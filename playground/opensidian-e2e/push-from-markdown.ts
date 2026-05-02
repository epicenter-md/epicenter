/**
 * Import `.md` files back into the opensidian workspace.
 *
 * Reads every `.md` file in the target directory, parses YAML frontmatter
 * into table row fields, and writes the markdown body into the per-file
 * Y.Doc content. Wikilinks (`[[Page Name]]`) in the body are resolved
 * to `epicenter://` epicenter links using the current files table.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { FileRow } from '@epicenter/filesystem';
import {
	convertWikilinksToEpicenterLinks,
	makeEpicenterLink,
} from '@epicenter/workspace';
import { parseMarkdownFile } from '@epicenter/workspace/document/materializer/markdown';
import type { opensidian } from './epicenter.config';

const MARKDOWN_DIR = join(import.meta.dir, 'data');

export async function pushFromMarkdown(ctx: {
	tables: (typeof opensidian)['tables'];
	writeContent(fileId: FileRow['id'], text: string): Promise<void>;
	filesDir?: string;
}): Promise<{ imported: number; skipped: number; errors: string[] }> {
	const dir = ctx.filesDir ?? join(MARKDOWN_DIR, 'files');
	let imported = 0;
	let skipped = 0;
	const errors: string[] = [];

	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch {
		return { imported, skipped, errors };
	}

	for (const filename of entries) {
		if (!filename.endsWith('.md')) continue;

		let content: string;
		try {
			content = await Bun.file(join(dir, filename)).text();
		} catch (error) {
			errors.push(`Failed to read ${filename}: ${error}`);
			continue;
		}

		const parsed = parseMarkdownFile(content);
		if (!parsed) {
			skipped++;
			continue;
		}

		const { frontmatter, body } = parsed;
		if (typeof frontmatter.id !== 'string') {
			skipped++;
			continue;
		}

		try {
			ctx.tables.files.set({
				id: frontmatter.id as FileRow['id'],
				name: String(frontmatter.name ?? ''),
				parentId: (frontmatter.parentId as FileRow['parentId']) ?? null,
				type: 'file',
				size: Number(frontmatter.size ?? 0),
				createdAt: Number(frontmatter.createdAt ?? Date.now()),
				updatedAt: Number(frontmatter.updatedAt ?? Date.now()),
				trashedAt:
					frontmatter.trashedAt != null ? Number(frontmatter.trashedAt) : null,
				_v: 1,
			});
		} catch (error) {
			errors.push(
				`Failed to set row ${frontmatter.id} from ${filename}: ${error}`,
			);
			continue;
		}

		if (body) {
			try {
				const resolvedBody = convertWikilinksToEpicenterLinks(body, (name) => {
					const match = ctx.tables.files.find((row) => row.name === name);
					return match
						? makeEpicenterLink('opensidian', 'files', match.id)
						: null;
				});
				await ctx.writeContent(frontmatter.id as FileRow['id'], resolvedBody);
			} catch (error) {
				errors.push(`Failed to write content for ${frontmatter.id}: ${error}`);
			}
		}

		imported++;
	}

	return { imported, skipped, errors };
}
