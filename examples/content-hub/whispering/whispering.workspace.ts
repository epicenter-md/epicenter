import {
	DateWithTimezone,
	date,
	defineMutation,
	defineWorkspace,
	generateId,
	id,
	markdownIndex,
	sqliteIndex,
	text,
} from '@epicenter/hq';
import { setupPersistence } from '@epicenter/hq/providers';
import { type } from 'arktype';
import { extractErrorMessage } from 'wellcrafted/error';
import { Err, Ok, tryAsync } from 'wellcrafted/result';

/**
 * Whispering workspace
 * Manages quick voice transcriptions with minimal schema
 */
export const whispering = defineWorkspace({
	id: 'whispering',

	schema: {
		entries: {
			id: id(),
			content: text(),
			date: date(),
		},
	},

	indexes: {
		sqlite: (c) => sqliteIndex(c),
		markdown: (c) => markdownIndex(c),
	},

	providers: [setupPersistence],

	exports: ({ db, indexes }) => {
		/**
		 * Determine timezone based on date
		 * - >= 2025-05-25: America/Los_Angeles
		 * - Between May 2024 and August 2024: America/Los_Angeles
		 * - Otherwise: America/New_York
		 */
		function determineTimezone(date: Date): string {
			const year = date.getFullYear();
			const month = date.getMonth();

			if (year > 2025 || (year === 2025 && month >= 4)) {
				if (year === 2025 && month === 4 && date.getDate() >= 25) {
					return 'America/Los_Angeles';
				}
				if (year === 2025 && month > 4) {
					return 'America/Los_Angeles';
				}
				if (year > 2025) {
					return 'America/Los_Angeles';
				}
			}

			if (year === 2024 && month >= 4 && month <= 7) {
				return 'America/Los_Angeles';
			}

			return 'America/New_York';
		}

		return {
			...db.entries,
			pullToMarkdown: indexes.markdown.pullToMarkdown,
			pushFromMarkdown: indexes.markdown.pushFromMarkdown,
			pullToSqlite: indexes.sqlite.pullToSqlite,
			pushFromSqlite: indexes.sqlite.pushFromSqlite,

			/**
			 * Migrate entries from quick-add.md format
			 *
			 * Parses lines in format: "2024-09-13T04:48:58.956Z Content text here"
			 * Each line starts with an ISO 8601 timestamp followed by content.
			 */
			migrateFromQuickAdd: defineMutation({
				input: type({
					sourcePath: 'string',
					'dryRun?': 'boolean',
				}),
				handler: async ({ sourcePath, dryRun = false }) => {
					const { data: fileContent, error: readError } = await tryAsync({
						try: () => Bun.file(sourcePath).text(),
						catch: (error) =>
							Err({
								message: 'Failed to read source file',
								context: {
									sourcePath,
									error: extractErrorMessage(error),
								},
							}),
					});

					if (readError) return Err(readError);

					const lines = fileContent.split('\n');
					const stats = {
						total: 0,
						success: 0,
						skipped: 0,
						errors: [] as Array<{ line: number; error: string }>,
					};

					const linesToKeep: string[] = [];
					const timestampPattern =
						/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\s+(.*)$/;

					for (let i = 0; i < lines.length; i++) {
						const line = lines[i];
						const lineNumber = i + 1;

						if (!line.trim()) {
							stats.skipped++;
							linesToKeep.push(line);
							continue;
						}

						stats.total++;

						const match = line.match(timestampPattern);
						if (!match) {
							stats.errors.push({
								line: lineNumber,
								error: 'Line does not match timestamp pattern',
							});
							linesToKeep.push(line);
							continue;
						}

						const [, timestampStr, content] = match;
						const date = new Date(timestampStr);

						if (Number.isNaN(date.getTime())) {
							stats.errors.push({
								line: lineNumber,
								error: 'Invalid timestamp',
							});
							linesToKeep.push(line);
							continue;
						}

						const timezone = determineTimezone(date);
						const entry = {
							id: generateId(),
							content: content.trim(),
							date: DateWithTimezone({ date, timezone }).toJSON(),
						};

						if (!dryRun) {
							db.entries.insert(entry);
						}

						stats.success++;
					}

					if (!dryRun && stats.success > 0) {
						const { error: writeError } = await tryAsync({
							try: async () => {
								await Bun.write(sourcePath, linesToKeep.join('\n'));
							},
							catch: (error) =>
								Err({
									message: 'Failed to write back to source file',
									context: {
										sourcePath,
										error: extractErrorMessage(error),
									},
								}),
						});

						if (writeError) {
							console.log(
								'\n⚠️  Warning: Migration succeeded but failed to clean up source file',
							);
							console.log(`   ${extractErrorMessage(writeError)}`);
						} else {
							console.log(
								`\n🗑️  Removed ${stats.success} successfully migrated lines from source file`,
							);
						}
					}

					console.log('\n📊 Migration Statistics:');
					console.log(`  ✅ Success: ${stats.success}`);
					console.log(`  ⏭️  Skipped (empty lines): ${stats.skipped}`);
					console.log(`  ❌ Errors: ${stats.errors.length}`);

					if (stats.errors.length > 0) {
						console.log('\n❌ Errors:');
						for (const { line, error } of stats.errors.slice(0, 10)) {
							console.log(`  Line ${line}: ${error}`);
						}
						if (stats.errors.length > 10) {
							console.log(`  ... and ${stats.errors.length - 10} more`);
						}
					}

					return Ok({
						total: stats.total,
						success: stats.success,
						skipped: stats.skipped,
						errorCount: stats.errors.length,
						errors: stats.errors,
					});
				},
			}),
		};
	},
});
