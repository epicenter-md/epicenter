/**
 * @fileoverview Markdown Table Config Factory Functions
 *
 * This file provides convenience factory functions for creating `TableMarkdownConfig` objects,
 * which define how rows are serialized to markdown files and deserialized back.
 *
 * ## Contract
 *
 * All factory functions return a `TableMarkdownConfig<TTableSchema>` with:
 * - `serialize`: Converts a row to { frontmatter, body, filename }
 * - `deserialize`: Converts { frontmatter, body, filename } back to a row (with validation)
 *
 * ## Available Factories
 *
 * - `withBodyField(field)`: Common pattern where one field becomes the markdown body.
 *
 * The true default config (`DEFAULT_TABLE_CONFIG`) is defined in `markdown-index.ts`.
 *
 * ## Usage
 *
 * ```typescript
 * import { markdownIndex, withBodyField, DEFAULT_TABLE_CONFIG } from '@epicenter/hq';
 *
 * markdownIndex(c, {
 *   tableConfigs: {
 *     // Use the default (all in frontmatter) - imported from markdown-index
 *     settings: DEFAULT_TABLE_CONFIG,
 *
 *     // Use a convenience helper (content → body)
 *     articles: withBodyField('content'),
 *     posts: withBodyField('markdown'),
 *
 *     // With options
 *     journal: withBodyField('content', { stripNulls: false }),
 *   }
 * })
 * ```
 */

import path from 'node:path';
import { type } from 'arktype';
import { Ok, type Result } from 'wellcrafted/result';
import type { TableHelper } from '../../core/db/table-helper';
import type { SerializedRow, TableSchema } from '../../core/schema';
import { MarkdownIndexErr, type MarkdownIndexError } from './markdown-index';

/**
 * Custom serialization/deserialization behavior for a table
 *
 * Defines how rows are converted to markdown files and vice versa.
 * When not provided, uses default behavior.
 */
export type TableMarkdownConfig<TTableSchema extends TableSchema> = {
	/**
	 * Directory for this table's markdown files.
	 *
	 * **Optional**: Defaults to the table name
	 *
	 * **Two ways to specify the path**:
	 *
	 * **Option 1: Relative paths** (recommended): Resolved relative to workspace directory
	 * ```typescript
	 * directory: './my-notes'      // → <workspace-dir>/my-notes
	 * directory: '../shared'       // → <workspace-dir>/../shared
	 * ```
	 *
	 * **Option 2: Absolute paths**: Used as-is, ignores workspace directory
	 * ```typescript
	 * directory: '/absolute/path/to/notes'
	 * ```
	 *
	 * @default table name (e.g., "posts" → workspace-dir/posts)
	 */
	directory?: string;

	/**
	 * Serialize a row to markdown frontmatter, body, and filename.
	 *
	 * **Optional**: When not provided, uses default behavior:
	 * - All fields except id go to frontmatter
	 * - Empty body
	 * - Filename: `{id}.md`
	 *
	 * IMPORTANT: The filename MUST be a simple filename without path separators.
	 * The table's directory setting determines where the file is written.
	 *
	 * @param params.row - Row to serialize (already validated against schema)
	 * @param params.table - TableHelper with metadata (name, schema, validators) and type inference helpers
	 * @returns Frontmatter object, markdown body string, and simple filename (without directory path)
	 */
	serialize?(params: {
		row: SerializedRow<TTableSchema>;
		table: TableHelper<TTableSchema>;
	}): {
		frontmatter: Record<string, unknown>;
		body: string;
		filename: string;
	};

	/**
	 * Deserialize markdown frontmatter and body back to a full row.
	 * Returns a complete row (including id) that can be directly inserted/updated in YJS.
	 * Returns error if the file should be skipped (e.g., invalid data, doesn't match schema).
	 *
	 * **Optional**: When not provided, uses default behavior:
	 * - Extracts id from filename (strips .md extension)
	 * - Merges id with frontmatter fields
	 * - Validates against schema using validateUnknown
	 *
	 * The deserialize function is responsible for extracting the row ID from whatever source
	 * makes sense (frontmatter, filename, body content, etc.).
	 *
	 * @param params.frontmatter - Parsed YAML frontmatter as a plain object
	 * @param params.body - Markdown body content (text after frontmatter delimiters)
	 * @param params.filename - Simple filename only (validated to not contain path separators)
	 * @param params.table - TableHelper with metadata (name, schema, validators) and type inference helpers
	 * @returns Result with complete row (with id field), or error to skip this file
	 */
	deserialize?(params: {
		frontmatter: Record<string, unknown>;
		body: string;
		filename: string;
		table: TableHelper<TTableSchema>;
	}): Result<SerializedRow<TTableSchema>, MarkdownIndexError>;
};

/**
 * Options for the withBodyField factory function
 */
export type WithBodyFieldOptions<
	TTableSchema extends TableSchema = TableSchema,
> = {
	/**
	 * Strip null values from frontmatter for cleaner YAML output.
	 * Nullable fields are restored via arktype's .default(null) during deserialization.
	 * @default true
	 */
	stripNulls?: boolean;

	/**
	 * Field to use for the filename (without .md extension).
	 * @default 'id'
	 */
	filenameField?: keyof TTableSchema & string;
};

/**
 * Factory function to create a table config where a specific field becomes the markdown body.
 *
 * This is a common pattern for tables with a main content field (like `content`, `body`, or `markdown`)
 * that should be stored as the markdown body rather than in frontmatter.
 *
 * @param bodyField - The field name that should become the markdown body
 * @param options - Optional configuration for null stripping and filename field
 * @returns A TableMarkdownConfig with serialize/deserialize functions
 *
 * @example
 * ```typescript
 * markdownIndex(c, {
 *   tableConfigs: {
 *     articles: withBodyField('content'),
 *     posts: withBodyField('markdown'),
 *     journal: withBodyField('content', { stripNulls: false }),
 *   }
 * })
 * ```
 */
export function withBodyField<TTableSchema extends TableSchema>(
	bodyField: keyof TTableSchema & string,
	options: WithBodyFieldOptions<TTableSchema> = {},
): TableMarkdownConfig<TTableSchema> {
	const {
		stripNulls = true,
		filenameField = 'id' as keyof TTableSchema & string,
	} = options;

	return {
		serialize: ({ row }) => {
			// Extract body field, filename field, and the rest
			const { [bodyField]: body, [filenameField]: filename, ...rest } = row;

			// Optionally strip null values for cleaner YAML
			const frontmatter = stripNulls
				? Object.fromEntries(
						Object.entries(rest).filter(([_, value]) => value !== null),
					)
				: rest;

			return {
				frontmatter,
				body: (body as string) ?? '',
				filename: `${filename}.md`,
			};
		},

		deserialize: ({ frontmatter, body, filename, table }) => {
			// Extract ID from filename (strip .md extension)
			const rowId = path.basename(filename, '.md');

			// Create validator that omits the body field and filename field
			// Nullable fields that were stripped during serialize are restored via .default(null)
			const FrontMatter = table.validators
				.toArktype()
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				.omit(filenameField as any, bodyField as any);

			const parsed = FrontMatter(frontmatter);

			if (parsed instanceof type.errors) {
				return MarkdownIndexErr({
					message: `Invalid frontmatter for row ${rowId}`,
					context: {
						fileName: filename,
						id: rowId,
						reason: parsed.summary,
					},
				});
			}

			// Reconstruct the full row
			const row = {
				[filenameField]: rowId,
				[bodyField]: body,
				...parsed,
			} as SerializedRow<TTableSchema>;

			return Ok(row);
		},
	};
}
