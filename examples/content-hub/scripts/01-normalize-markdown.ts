/**
 * Normalize markdown files by re-serializing frontmatter
 *
 * This script:
 * 1. Reads all markdown files
 * 2. Parses frontmatter using Bun.YAML.parse
 * 3. Re-serializes frontmatter using Bun.YAML.stringify
 * 4. Writes files back with consistent formatting
 *
 * Purpose: Standardize YAML formatting before doing transformations
 */

import {
	listMarkdownFiles,
	readMarkdownFile,
	writeMarkdownFile,
} from '@epicenter/hq/indexes/markdown';
import { Err, Ok, type Result } from 'wellcrafted/result';

const sourcePath = process.env.MARKDOWN_SOURCE_PATH;
if (!sourcePath) {
	console.error('❌ Error: MARKDOWN_SOURCE_PATH not set in .env file');
	console.error('Copy .env.example to .env and configure your path');
	process.exit(1);
}

const dryRun = process.argv.includes('--dry-run');

console.log(`🔍 Scanning: ${sourcePath}`);
if (dryRun) {
	console.log('🔍 DRY RUN MODE: No files will be modified\n');
}

// Find all markdown files recursively
const markdownFiles = await listMarkdownFiles(sourcePath);

console.log(`📄 Found ${markdownFiles.length} markdown files\n`);

// Process each file
const results = await Promise.all(
	markdownFiles.map(
		async (
			filePath,
		): Promise<Result<{ file: string }, { file: string; message: string }>> => {
			// Read the file
			const { data, error } = await readMarkdownFile(filePath);
			if (error) {
				return Err({ file: filePath, message: error.message });
			}

			const { data: frontmatter, body } = data;

			// Write back (writeMarkdownFile handles YAML serialization)
			if (!dryRun) {
				const { error: writeError } = await writeMarkdownFile({
					filePath,
					frontmatter,
					body,
				});

				if (writeError) {
					return Err({ file: filePath, message: writeError.message });
				}
			}

			return Ok({ file: filePath });
		},
	),
);

// Aggregate results
const successes = results.filter((r) => r.data);
const errors = results.filter((r) => r.error);

// Report results
console.log('📊 Normalization Summary:');
console.log(`  Total files scanned: ${markdownFiles.length}`);
console.log(`  Files normalized: ${successes.length}`);
console.log(`  Errors: ${errors.length}\n`);

if (errors.length > 0) {
	console.log('❌ Errors:');
	for (const result of errors) {
		const err = result.error!;
		console.log(`  ${err.file.split('/').pop()}: ${err.message}`);
	}
}

if (dryRun) {
	console.log(
		'\n💡 This was a dry run. Run without --dry-run to apply changes.',
	);
} else {
	console.log('\n✅ All files normalized. YAML formatting is now consistent.');
}

// Exit with error code if there were any errors
process.exit(errors.length > 0 ? 1 : 0);
