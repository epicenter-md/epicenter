/**
 * Append timezone to date fields using pipe operator
 *
 * This script:
 * 1. Reads all markdown files
 * 2. Parses frontmatter
 * 3. If timezone exists, appends it to date, created_at, and updated_at with |
 * 4. Removes the timezone field
 * 5. Writes files back
 */

import { isDateWithTimezoneString, isIsoDateTimeString } from '@epicenter/hq';
import {
	listMarkdownFiles,
	readMarkdownFile,
	writeMarkdownFile,
} from '@epicenter/hq/indexes/markdown';

/**
 * Frontmatter field that contains timezone information.
 * This field will be read to extract the timezone value and then removed.
 */
const TIMEZONE_FIELD = 'timezone';

/**
 * Date fields that should have timezone appended.
 * Format: date|timezone (e.g., "2024-01-01|America/New_York")
 */
const DATE_FIELDS = ['date', 'created_at', 'updated_at'] as const;

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

type ProcessResult =
	| { status: 'modified'; file: string }
	| { status: 'skipped'; file: string; reason: string }
	| { status: 'invalid'; file: string; field: string; value: unknown }
	| { status: 'error'; file: string; error: string };

// Process each file
const results: ProcessResult[] = await Promise.all(
	markdownFiles.map(async (filePath): Promise<ProcessResult> => {
		// Read the file
		const { data, error } = await readMarkdownFile(filePath);
		if (error) {
			return { status: 'error', file: filePath, error: error.message };
		}

		const { data: frontmatter, body } = data;

		// Check if timezone exists
		const timezone = frontmatter[TIMEZONE_FIELD];
		if (!timezone) {
			return { status: 'skipped', file: filePath, reason: 'no timezone field' };
		}

		if (typeof timezone !== 'string') {
			return {
				status: 'invalid',
				file: filePath,
				field: TIMEZONE_FIELD,
				value: timezone,
			};
		}

		// Collect fields that need transformation
		const fieldsToTransform: Array<(typeof DATE_FIELDS)[number]> = [];

		for (const field of DATE_FIELDS) {
			const value = frontmatter[field];

			// Skip if field doesn't exist
			if (!value) continue;

			// Skip if already transformed
			if (isDateWithTimezoneString(value)) continue;

			// Validate ISO datetime format
			if (!isIsoDateTimeString(value)) {
				return {
					status: 'invalid',
					file: filePath,
					field,
					value,
				};
			}

			fieldsToTransform.push(field);
		}

		// Skip if nothing to transform
		if (fieldsToTransform.length === 0) {
			return {
				status: 'skipped',
				file: filePath,
				reason: 'all dates already transformed',
			};
		}

		// Apply transformations
		for (const field of fieldsToTransform) {
			frontmatter[field] = `${frontmatter[field]}|${timezone}`;
		}

		// Remove timezone field
		delete frontmatter[TIMEZONE_FIELD];

		// Write back (writeMarkdownFile handles YAML serialization)
		if (!dryRun) {
			const { error: writeError } = await writeMarkdownFile({
				filePath,
				frontmatter,
				body,
			});

			if (writeError) {
				return { status: 'error', file: filePath, error: writeError.message };
			}
		}

		return { status: 'modified', file: filePath };
	}),
);

// Aggregate results
const modified = results.filter((r) => r.status === 'modified');
const skipped = results.filter((r) => r.status === 'skipped');
const invalid = results.filter((r) => r.status === 'invalid');
const errors = results.filter((r) => r.status === 'error');

// Report results
console.log('📊 Timezone Append Summary:');
console.log(`  Total files scanned: ${markdownFiles.length}`);
console.log(`  Files modified: ${modified.length}`);
console.log(`  Files skipped: ${skipped.length}`);
console.log(`  Invalid dates: ${invalid.length}`);
console.log(`  Errors: ${errors.length}\n`);

if (invalid.length > 0) {
	console.log('⚠️  Invalid Dates:');
	for (const result of invalid) {
		const fileName = result.file.split('/').pop();
		console.log(
			`  ${fileName}: field "${result.field}" has invalid value: ${JSON.stringify(result.value)}`,
		);
	}
	console.log('');
}

if (errors.length > 0) {
	console.log('❌ Errors:');
	for (const result of errors) {
		const fileName = result.file.split('/').pop();
		console.log(`  ${fileName}: ${result.error}`);
	}
	console.log('');
}

if (dryRun) {
	console.log('💡 This was a dry run. Run without --dry-run to apply changes.');
} else if (modified.length > 0) {
	console.log('✅ Date transformation completed successfully.');
}

// Exit with error code if there were any errors
process.exit(errors.length > 0 ? 1 : 0);
