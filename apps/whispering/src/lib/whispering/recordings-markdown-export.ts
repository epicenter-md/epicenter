/**
 * Shared "export recordings" action for both Whispering runtime clients.
 *
 * Assembles every recording into a Markdown file (YAML frontmatter + transcript
 * body), zips them, and hands the archive to the platform download seam: a Save
 * dialog on desktop, a browser download on web. It is a click-time snapshot, not
 * a live mirror; continuous on-disk Markdown is the Epicenter mount's job (see
 * `docs/adr/0010-whispering-exports-recordings-as-a-zip-continuous-markdown-is-the-mounts-job.md`).
 *
 * Defined once here because the logic is identical on every platform: the
 * `#platform/download` seam absorbs the only difference. It is not a pure
 * workspace action (it reaches the download capability), so it lives beside the
 * env factories rather than in the iso `defineWhispering`.
 */

import { defineMutation, type Table } from '@epicenter/workspace';
import { strToU8, zipSync } from 'fflate';
import yaml from 'js-yaml';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { Recording } from '$lib/workspace';
import type {
	DownloadError,
	DownloadService,
} from '$lib/services/download/types';

/** Render one recording row as Markdown: YAML frontmatter + transcript body. */
function recordingToMarkdown(recording: Recording): string {
	const { transcript, ...frontmatter } = recording;
	const yamlStr = yaml.dump(frontmatter, { lineWidth: -1 });
	return `---\n${yamlStr}---\n${transcript || ''}\n`;
}

export function defineRecordingsMarkdownExport(
	recordings: Table<Recording>,
	downloads: DownloadService,
) {
	return defineMutation({
		title: 'Export recordings',
		description: 'Download every recording as a zip of Markdown files',
		handler: async (): Promise<Result<{ written: number }, DownloadError>> => {
			const { rows } = recordings.scan();
			if (rows.length === 0) return Ok({ written: 0 });

			const files: Record<string, Uint8Array> = {};
			for (const row of rows) {
				files[`${row.id}.md`] = strToU8(recordingToMarkdown(row));
			}
			const blob = new Blob([zipSync(files) as BlobPart], {
				type: 'application/zip',
			});

			const { error } = await downloads.downloadBlob({
				name: 'recordings.zip',
				blob,
			});
			if (error) return Err(error);
			return Ok({ written: rows.length });
		},
	});
}
