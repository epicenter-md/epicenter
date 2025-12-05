/**
 * Migrate journal entries to database
 *
 * This script:
 * 1. Reads all markdown files from source directory
 * 2. Validates frontmatter using journal schema
 * 3. Inserts entries into database
 * 4. Deletes source files after successful migration
 */

import { unlink } from 'node:fs/promises';
import { basename } from 'node:path';
import { createEpicenterClient, type SerializedRow } from '@epicenter/hq';
import {
	listMarkdownFiles,
	readMarkdownFile,
} from '@epicenter/hq/indexes/markdown';
import { type } from 'arktype';
import { extractErrorMessage } from 'wellcrafted/error';
import { Err, tryAsync } from 'wellcrafted/result';
import epicenterConfig from '../epicenter.config';

const sourcePath = process.env.MARKDOWN_SOURCE_PATH;
if (!sourcePath) {
	console.error('❌ Error: MARKDOWN_SOURCE_PATH not set in .env file');
	console.error('Copy .env.example to .env and configure your path');
	process.exit(1);
}

const dryRun = process.argv.includes('--dry-run');

console.log('🔗 Starting migration');
console.log(`📂 Migrating from: ${sourcePath}`);
if (dryRun) {
	console.log('🔍 DRY RUN MODE: No database changes or file deletions\n');
}

// Create epicenter client
await using client = await createEpicenterClient(epicenterConfig);

// Frontmatter validator (omits id and content which are handled separately)
// Nullable fields automatically default to null, required fields must be present
const FrontMatter = client.journal.db.journal.validators
	.toArktype()
	.omit('id', 'content');

// Find all markdown files recursively
const markdownFiles = await listMarkdownFiles(sourcePath);

console.log(`📄 Found ${markdownFiles.length} markdown files\n`);

type ProcessResult =
	| { status: 'success'; file: string; id: string }
	| { status: 'error'; file: string; error: string };

// Process each file
const results: ProcessResult[] = await Promise.all(
	markdownFiles.map(async (filePath): Promise<ProcessResult> => {
		// Read markdown file
		const parseResult = await readMarkdownFile(filePath);

		if (parseResult.error) {
			return {
				status: 'error',
				file: filePath,
				error: extractErrorMessage(parseResult.error),
			};
		}

		const { data: frontmatter, body } = parseResult.data;

		// Extract ID from filename (not frontmatter)
		const id = basename(filePath, '.md');

		// Validate frontmatter
		// Nullable fields automatically default to null, required fields must be present
		const parsed = FrontMatter(frontmatter);
		if (parsed instanceof type.errors) {
			return {
				status: 'error',
				file: filePath,
				error: parsed.summary,
			};
		}

		// Build entry by spreading validated frontmatter
		// Missing nullable fields are already null, required fields were validated
		const entry = {
			id,
			content: body,
			...parsed,
		} satisfies SerializedRow<typeof client.journal.schema.journal>;

		// Create entry via client (skip in dry-run mode)
		if (!dryRun) {
			const result = client.journal.createJournalEntry(entry);

			if (result.error) {
				const errorMessage = extractErrorMessage(result.error);
				return {
					status: 'error',
					file: filePath,
					error: `YJS insert failed: ${errorMessage}`,
				};
			}

			// Verify SQLite insert succeeded before deleting source file
			const sqliteRow = client.journal.db.journal.get(entry.id);
			if (!sqliteRow) {
				return {
					status: 'error',
					file: filePath,
					error:
						'SQLite insert failed - check logs at .epicenter/sqlite/journal.log',
				};
			}

			// NOW safe to delete source file
			const deleteResult = await tryAsync({
				try: () => unlink(filePath),
				catch: (error) =>
					Err({
						message: 'Failed to delete source file',
						context: { filePath, error: extractErrorMessage(error) },
					}),
			});

			if (deleteResult.error) {
				return {
					status: 'error',
					file: filePath,
					error: 'Migrated but failed to delete source file',
				};
			}
		}

		return {
			status: 'success',
			file: filePath,
			id: entry.id,
		};
	}),
);

// Aggregate results and log details
const successes = results.filter((r) => r.status === 'success');
const errors = results.filter((r) => r.status === 'error');

// Log detailed results for each file
console.log('\n📝 Processing Results:\n');
for (const result of results) {
	const fileName = result.file.split('/').pop();

	if (result.status === 'success') {
		console.log(`✅ ${fileName}`);
		console.log(`   ID: ${result.id}`);
		if (!dryRun) {
			console.log('   Migrated and deleted source file');
		} else {
			console.log('   Would be migrated (dry-run)');
		}
	} else {
		console.log(`❌ ${fileName}`);
		console.log(`   Error: ${result.error}`);
	}
	console.log('');
}

// Report summary
console.log('📊 Migration Summary:');
console.log(`  Total files scanned: ${markdownFiles.length}`);
console.log(`  Files migrated: ${successes.length}`);
console.log(`  Errors: ${errors.length}\n`);

if (dryRun) {
	console.log(
		'\n💡 This was a dry run. Run without --dry-run to apply changes.',
	);
} else {
	console.log('\n✅ Migration complete. Source files have been processed.');
}

// Exit with error code if there were any errors
process.exit(errors.length > 0 ? 1 : 0);
