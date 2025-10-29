import { redditAdapter } from '@repo/vault-core/adapters/reddit';
import { ZIP } from '@repo/vault-core/utils/archive/zip';
import { form, query } from '$app/server';
import {
	ImportBundleInputSchema,
	IngestFileInputSchema,
} from '$lib/schemas/vault';
import { getTableCounts, getVault, jsonFormat } from '$lib/server/vaultService';

/**
 * Query: get per-table row counts grouped by adapter id.
 */
export const getCounts = query(async () => {
	return await getTableCounts();
});

/**
 * Form: import a bundle of files (multi-adapter). Pairs uploaded files with
 * the client-provided paths derived from directory selection.
 */
export const importBundle = form(ImportBundleInputSchema, async (input) => {
	const filesInput = input.files;
	const files = new Map(
		// Here `file.name` should be the relative path within the selected directory
		// E.g. `vault-export/vault/entity_index/entity_index_entities/subreddit_todayilearned.json`
		Object.values(filesInput).map((file) => [file.name, file]),
	);
	await getVault().importData({ files, codec: jsonFormat });

	return { message: `Imported ${files.size} files` };
});

/**
 * Form: ingest a single uploaded file for a specified adapter.
 * Validate adapter via simple runtime check; assert File at runtime.
 */
export const ingest = form(IngestFileInputSchema, async (input) => {
	const fdFile = input.file;

	await getVault().ingestData({ adapter: redditAdapter(), file: fdFile });

	return { message: `Ingested file: ${fdFile.name}` };
});
