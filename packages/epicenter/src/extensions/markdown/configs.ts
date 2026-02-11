/**
 * @fileoverview Markdown Table Config Factory Functions
 *
 * This file provides types and factory functions for configuring how tables
 * sync to markdown files.
 *
 * ## API Overview
 *
 * Each table config has two concerns:
 * - `directory?`: WHERE files go (defaults to table name)
 * - `serializer?`: HOW rows are encoded/decoded (defaults to all-frontmatter)
 *
 * ## Available Serializer Factories
 *
 * - `defaultSerializer()`: All fields in frontmatter, `{id}.md` filename
 * - `bodyFieldSerializer(field)`: One field becomes the markdown body
 * - `titleFilenameSerializer(field)`: Human-readable `{title}-{id}.md` filenames
 *
 * ## Usage
 *
 * ```typescript
 * import { markdownProvider, bodyFieldSerializer, titleFilenameSerializer } from '@epicenter/hq';
 *
 * markdownProvider(c, {
 *   tableConfigs: {
 *     // Both defaults (empty object)
 *     settings: {},
 *
 *     // Custom directory only
 *     config: { directory: './app-config' },
 *
 *     // Custom serializer only
 *     posts: { serializer: bodyFieldSerializer('content') },
 *
 *     // Both custom
 *     drafts: {
 *       directory: './drafts',
 *       serializer: bodyFieldSerializer('content'),
 *     },
 *
 *     // Title-based filenames
 *     tabs: { serializer: titleFilenameSerializer('title') },
 *   }
 * })
 * ```
 */

import path from 'node:path';
import { type } from 'arktype';
import filenamify from 'filenamify';
import { Ok, type Result } from 'wellcrafted/result';
import type { Field, Row } from '../../dynamic/schema';
import { tableToArktype } from '../../dynamic/schema';
import { MarkdownExtensionErr, type MarkdownExtensionError } from './markdown';

// ─────────────────────────────────────────────────────────────────────────────
// Core Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Field array type alias for serializer generics.
 * Using readonly array matches the TableDefinition.fields type.
 */
type Fields = readonly Field[];

/**
 * Row type that guarantees an `id` property exists.
 * Row<TFields> alone doesn't guarantee `.id` when TFields is a generic parameter,
 * so we intersect with `{ id: string }` to make destructuring work.
 */
type RowWithId<TFields extends Fields> = Row<TFields> & { id: string };

/**
 * Base parsed result that all parseFilename functions must return.
 * Must contain at least `id`, but can include additional fields.
 */
export type ParsedFilename = { id: string };

/**
 * A serializer defines how to encode rows to markdown files and decode them back.
 *
 * @typeParam TFields - The fields array being serialized
 * @typeParam TParsed - Additional data extracted from filename beyond `id`
 */
export type MarkdownSerializer<
	TFields extends Fields,
	TParsed extends ParsedFilename = ParsedFilename,
> = {
	/**
	 * Encode: Convert a row to markdown file format.
	 * Returns frontmatter object, body string, and filename.
	 */
	serialize: (params: { row: RowWithId<TFields>; fields: TFields }) => {
		frontmatter: Record<string, unknown>;
		body: string;
		filename: string;
	};

	/**
	 * Decode: Convert markdown file back to a row.
	 * Two-step process: parse filename first, then parse content.
	 */
	deserialize: {
		/**
		 * Step 1: Extract structured data from filename.
		 * Must return at least { id }, can include additional fields.
		 * Return undefined if filename doesn't match expected pattern.
		 */
		parseFilename: (filename: string) => TParsed | undefined;

		/**
		 * Step 2: Reconstruct the row from frontmatter, body, and parsed filename data.
		 * Called only if parseFilename succeeded.
		 */
		fromContent: (params: {
			frontmatter: Record<string, unknown>;
			body: string;
			filename: string;
			parsed: TParsed;
			fields: TFields;
		}) => Result<RowWithId<TFields>, MarkdownExtensionError>;
	};
};

/**
 * Configuration for how a table syncs to markdown files.
 * Both fields are optional with sensible defaults.
 *
 * @example
 * ```typescript
 * markdownProvider(c, {
 *   tableConfigs: {
 *     settings: {},  // All defaults
 *     posts: { serializer: bodyFieldSerializer('content') },
 *     drafts: { directory: './drafts', serializer: bodyFieldSerializer('content') },
 *   }
 * })
 * ```
 */
export type TableMarkdownConfig<TFields extends Fields = Fields> = {
	/**
	 * WHERE files go. Resolved relative to workspace directory.
	 * @default table.name (e.g., "posts" table -> "./posts/")
	 */
	directory?: string;

	/**
	 * HOW files are encoded/decoded.
	 * @default Default serializer (all fields to frontmatter, {id}.md filename)
	 */
	// biome-ignore lint/suspicious/noExplicitAny: TParsed is only needed for internal type flow between parseFilename and fromContent. Consumers do not care about the specific parsed type, so we use any to accept serializers with any TParsed.
	serializer?: MarkdownSerializer<TFields, any>;
};

// ─────────────────────────────────────────────────────────────────────────────
// Builder Pattern for Type-Safe Serializers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Step 2: After parseFilename is defined, add serialize function.
 *
 * Type flow:
 * - `TFilename` from parser input constrains serialize's filename return
 * - `TParsed` is captured for use in deserialize step
 */
type SerializerBuilderWithParser<
	TFields extends Fields,
	TFilename extends string,
	TParsed extends ParsedFilename,
> = {
	/**
	 * Step 2: Define how to serialize a row to markdown format.
	 *
	 * The filename return type is constrained to match the parser's input type.
	 */
	serialize(
		serializeFn: (params: { row: RowWithId<TFields>; fields: TFields }) => {
			frontmatter: Record<string, unknown>;
			body: string;
			filename: TFilename;
		},
	): SerializerBuilderWithSerialize<TFields, TFilename, TParsed>;
};

/**
 * Step 3: After serialize is defined, add deserialize function.
 *
 * Type flow:
 * - `TParsed` from parser output flows to deserialize's parsed parameter
 * - `TFilename` is available for the filename parameter
 */
type SerializerBuilderWithSerialize<
	TFields extends Fields,
	TFilename extends string,
	TParsed extends ParsedFilename,
> = {
	/**
	 * Step 3: Define how to deserialize markdown content back to a row.
	 *
	 * The `parsed` parameter contains the data extracted from parseFilename.
	 */
	deserialize(
		deserializeFn: (params: {
			frontmatter: Record<string, unknown>;
			body: string;
			filename: TFilename;
			parsed: TParsed;
			fields: TFields;
		}) => Result<RowWithId<TFields>, MarkdownExtensionError>,
	): MarkdownSerializer<TFields, TParsed>;
};

/**
 * Creates a MarkdownSerializer using a fluent builder pattern with full type inference.
 *
 * The builder has three steps that flow naturally:
 * 1. `.parseFilename()` - Define how to extract data from filenames
 * 2. `.serialize()` - Define how to convert rows to markdown
 * 3. `.deserialize()` - Define how to reconstruct rows from markdown
 *
 * Type flow ensures safety:
 * - `TFilename`: Inferred from parseFilename's input, enforced on serialize's return
 * - `TParsed`: Inferred from parseFilename's return, provided to deserialize's parsed param
 *
 * @example
 * ```typescript
 * // Basic usage
 * const serializer = defineSerializer<MySchema>()
 *   .parseFilename((filename: `${string}.md`) => {
 *     const id = path.basename(filename, '.md');
 *     return { id };
 *   })
 *   .serialize(({ row }) => ({
 *     frontmatter: { ...row },
 *     body: '',
 *     filename: `${row.id}.md`,
 *   }))
 *   .deserialize(({ parsed, frontmatter }) => {
 *     return Ok({ id: parsed.id, ...frontmatter });
 *   });
 *
 * // Advanced: Extract extra data from filename
 * const titleSerializer = defineSerializer<TabSchema>()
 *   .parseFilename((filename: `${string}-${string}.md`) => {
 *     const basename = path.basename(filename, '.md');
 *     const lastDash = basename.lastIndexOf('-');
 *     return {
 *       id: basename.substring(lastDash + 1),
 *       titleFromFilename: basename.substring(0, lastDash),
 *     };
 *   })
 *   .serialize(({ row }) => ({
 *     frontmatter: {},
 *     body: '',
 *     filename: `${row.title}-${row.id}.md`,
 *   }))
 *   .deserialize(({ parsed }) => {
 *     // parsed.titleFromFilename is typed!
 *     console.log(parsed.titleFromFilename);
 *     return Ok({ id: parsed.id, ... });
 *   });
 * ```
 */
export function defineSerializer<TFields extends Fields>(): {
	/**
	 * Step 1: Define how to parse filenames to extract structured data.
	 *
	 * Must return at least `{ id }`. Can include additional fields that will
	 * be available in the deserialize step via the `parsed` parameter.
	 */
	parseFilename<TFilename extends string, TParsed extends ParsedFilename>(
		parseFilenameFn: (filename: TFilename) => TParsed | undefined,
	): SerializerBuilderWithParser<TFields, TFilename, TParsed>;
} {
	return {
		parseFilename<TFilename extends string, TParsed extends ParsedFilename>(
			parseFilenameFn: (filename: TFilename) => TParsed | undefined,
		): SerializerBuilderWithParser<TFields, TFilename, TParsed> {
			return {
				serialize(serializeFn) {
					return {
						deserialize(deserializeFn) {
							return {
								serialize: serializeFn,
								deserialize: {
									parseFilename: parseFilenameFn as MarkdownSerializer<
										TFields,
										TParsed
									>['deserialize']['parseFilename'],
									fromContent: deserializeFn as MarkdownSerializer<
										TFields,
										TParsed
									>['deserialize']['fromContent'],
								},
							};
						},
					};
				},
			};
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Serializer Factories
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Default serializer: all fields to frontmatter, `{id}.md` filename.
 *
 * Serialization behavior:
 * - Serialize: All fields except id go to frontmatter, empty body, filename "{id}.md"
 * - ParseFilename: Strip .md extension, return { id }
 * - Deserialize: Validate frontmatter against schema with id from parsed
 *
 * @example
 * ```typescript
 * markdownProvider(c, {
 *   tableConfigs: {
 *     settings: {},  // Uses defaultSerializer() implicitly
 *     config: { serializer: defaultSerializer() },  // Explicit
 *   }
 * })
 * ```
 */
export function defaultSerializer(): MarkdownSerializer<Fields> {
	return defineSerializer<Fields>()
		.parseFilename((filename: `${string}.md`) => {
			const id = path.basename(filename, '.md');
			return { id };
		})
		.serialize(({ row: { id, ...rest } }) => ({
			frontmatter: rest,
			body: '',
			filename: `${id}.md`,
		}))
		.deserialize(({ frontmatter, parsed, fields }) => {
			const { id } = parsed;

			// Combine id with frontmatter
			const data = { id, ...frontmatter };

			// Validate using direct arktype pattern
			const validator = tableToArktype(fields);
			const result = validator(data);

			if (result instanceof type.errors) {
				return MarkdownExtensionErr({
					message: `Failed to validate row ${id}`,
					context: { fileName: `${id}.md`, id, reason: result.summary },
				});
			}

			return Ok(result as RowWithId<Fields>);
		});
}

/**
 * Options for the bodyFieldSerializer factory function
 */
export type BodyFieldSerializerOptions = {
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
	filenameField?: string;
};

/**
 * Body field serializer: one field becomes the markdown body.
 *
 * Use when your table has a main content field (like `content`, `body`, or `markdown`)
 * that should be stored as the markdown body rather than in frontmatter.
 *
 * @param bodyField - The field name that should become the markdown body
 * @param options - Optional configuration for null stripping and filename field
 *
 * @example
 * ```typescript
 * markdownProvider(c, {
 *   tableConfigs: {
 *     articles: { serializer: bodyFieldSerializer('content') },
 *     posts: { serializer: bodyFieldSerializer('markdown') },
 *     journal: { serializer: bodyFieldSerializer('content', { stripNulls: false }) },
 *   }
 * })
 * ```
 */
export function bodyFieldSerializer(
	bodyField: string,
	options: BodyFieldSerializerOptions = {},
): MarkdownSerializer<Fields> {
	const { stripNulls = true, filenameField = 'id' } = options;

	return defineSerializer<Fields>()
		.parseFilename((filename: `${string}.md`) => {
			const id = path.basename(filename, '.md');
			return { id };
		})
		.serialize(({ row }) => {
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
		})
		.deserialize(({ frontmatter, body, parsed, fields }) => {
			const { id: rowId } = parsed;

			// Create validator that omits the body field and filename field
			// Nullable fields that were stripped during serialize are restored via .default(null)
			const FrontMatter = tableToArktype(fields)
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				.omit(filenameField as any, bodyField as any);

			const validatedFrontmatter = FrontMatter(frontmatter);

			if (validatedFrontmatter instanceof type.errors) {
				return MarkdownExtensionErr({
					message: `Invalid frontmatter for row ${rowId}`,
					context: {
						fileName: `${rowId}.md`,
						id: rowId,
						reason: validatedFrontmatter.summary,
					},
				});
			}

			// Reconstruct the full row
			const row = {
				[filenameField]: rowId,
				[bodyField]: body,
				...(validatedFrontmatter as Record<string, unknown>),
			} as RowWithId<Fields>;

			return Ok(row);
		});
}

/**
 * Options for the titleFilenameSerializer factory function
 */
export type TitleFilenameSerializerOptions = {
	/**
	 * Strip null values from frontmatter for cleaner YAML output.
	 * Nullable fields are restored via arktype's .default(null) during deserialization.
	 * @default true
	 */
	stripNulls?: boolean;

	/**
	 * Maximum characters for the title portion of the filename.
	 * @default 80
	 */
	maxTitleLength?: number;
};

/**
 * Options for the domainTitleFilenameSerializer factory function
 */
export type DomainTitleFilenameSerializerOptions = {
	/**
	 * Strip null values from frontmatter for cleaner YAML output.
	 * Nullable fields are restored via arktype's .default(null) during deserialization.
	 * @default true
	 */
	stripNulls?: boolean;

	/**
	 * Maximum characters for the title portion of the filename.
	 * @default 60
	 */
	maxTitleLength?: number;

	/**
	 * Maximum characters for the domain portion of the filename.
	 * @default 30
	 */
	maxDomainLength?: number;
};

/**
 * Title filename serializer: `{title}-{id}.md` filename pattern.
 *
 * Creates filenames with the title for readability while maintaining
 * the ID suffix for uniqueness. Provides:
 * - Readability: Title comes first for easy scanning in file browsers
 * - Uniqueness: ID suffix guarantees no filename collisions
 * - Sorting: Files sort alphabetically by title
 *
 * @param titleField - The field to use for the readable part of the filename
 * @param options - Optional configuration for null stripping and max title length
 *
 * @example
 * ```typescript
 * markdownProvider(c, {
 *   tableConfigs: {
 *     tabs: { serializer: titleFilenameSerializer('title') },
 *     notes: { serializer: titleFilenameSerializer('name', { maxTitleLength: 50 }) },
 *   }
 * })
 * ```
 */
export function titleFilenameSerializer(
	titleField: string,
	options: TitleFilenameSerializerOptions = {},
): MarkdownSerializer<Fields, ParsedFilename & { titleFromFilename: string }> {
	const { stripNulls = true, maxTitleLength = 80 } = options;

	return defineSerializer<Fields>()
		.parseFilename((filename: `${string}-${string}.md`) => {
			const basename = path.basename(filename, '.md');
			const lastDashIndex = basename.lastIndexOf('-');
			// If no dash found, treat entire basename as ID (fallback to default behavior)
			const id =
				lastDashIndex === -1 ? basename : basename.substring(lastDashIndex + 1);
			const titleFromFilename =
				lastDashIndex === -1 ? '' : basename.substring(0, lastDashIndex);
			return { id, titleFromFilename };
		})
		.serialize(({ row }) => {
			const { id, ...rest } = row;
			const rawTitle = (row[titleField] as string) || '';

			// Use filenamify for robust cross-platform filename sanitization
			// Handles Unicode normalization, grapheme-aware truncation, emoji preservation
			const sanitizedTitle =
				rawTitle.trim() === ''
					? 'Untitled'
					: filenamify(rawTitle, {
							maxLength: maxTitleLength,
							replacement: '',
						});

			// Optionally strip null values for cleaner YAML
			const frontmatter = stripNulls
				? Object.fromEntries(
						Object.entries(rest).filter(([_, value]) => value !== null),
					)
				: rest;

			return {
				frontmatter,
				body: '',
				filename: `${sanitizedTitle}-${id}.md`,
			};
		})
		.deserialize(({ frontmatter, parsed, fields }) => {
			const { id } = parsed;

			// Combine id with frontmatter
			const data = { id, ...frontmatter };

			// Validate using direct arktype pattern
			const validator = tableToArktype(fields);
			const result = validator(data);

			if (result instanceof type.errors) {
				return MarkdownExtensionErr({
					message: `Failed to validate row ${id}`,
					context: {
						fileName: `${id}.md`,
						id,
						reason: result.summary,
					},
				});
			}

			return Ok(result as RowWithId<Fields>);
		});
}

/**
 * Extracts the domain (hostname) from a URL string.
 * Returns 'unknown' for invalid URLs or non-http(s) protocols.
 */
function extractDomain(url: string): string {
	try {
		const parsed = new URL(url);
		// Handle special protocols
		if (
			parsed.protocol === 'chrome:' ||
			parsed.protocol === 'chrome-extension:'
		) {
			return parsed.protocol.replace(':', '');
		}
		if (parsed.protocol === 'file:') {
			return 'file';
		}
		if (parsed.protocol === 'about:') {
			return 'about';
		}
		// For http/https, return the hostname
		return parsed.hostname || 'unknown';
	} catch {
		return 'unknown';
	}
}

/**
 * Domain-title filename serializer: `{domain} - {title}-{id}.md` filename pattern.
 *
 * Creates filenames with domain and title for maximum readability while maintaining
 * the ID suffix for uniqueness. Provides:
 * - Organization: Domain comes first for grouping related tabs when sorted
 * - Readability: Title provides context for the specific page
 * - Uniqueness: ID suffix guarantees no filename collisions
 * - Sorting: Files sort alphabetically by domain, then title
 *
 * Filename format: `{domain} - {title}-{id}.md`
 * Example: `github.com - Pull Requests-abc123_456.md`
 *
 * Parsing strategy (for deserialization):
 * - Last `-` separates id from the rest
 * - First ` - ` (space-dash-space) separates domain from title
 * - This works because domains can't contain spaces
 *
 * @param urlField - The field containing the URL to extract domain from
 * @param titleField - The field to use for the title part of the filename
 * @param options - Optional configuration for null stripping and max lengths
 *
 * @example
 * ```typescript
 * markdownProvider(c, {
 *   tableConfigs: {
 *     tabs: { serializer: domainTitleFilenameSerializer('url', 'title') },
 *   }
 * })
 * ```
 */
export function domainTitleFilenameSerializer(
	urlField: string,
	titleField: string,
	options: DomainTitleFilenameSerializerOptions = {},
): MarkdownSerializer<
	Fields,
	ParsedFilename & { domainFromFilename: string; titleFromFilename: string }
> {
	const {
		stripNulls = true,
		maxTitleLength = 60,
		maxDomainLength = 30,
	} = options;

	return defineSerializer<Fields>()
		.parseFilename((filename: `${string} - ${string}-${string}.md`) => {
			const basename = path.basename(filename, '.md');

			// Find the last dash to extract ID
			const lastDashIndex = basename.lastIndexOf('-');
			if (lastDashIndex === -1) {
				// Fallback: no dash found, treat entire basename as ID
				return { id: basename, domainFromFilename: '', titleFromFilename: '' };
			}

			const id = basename.substring(lastDashIndex + 1);
			const domainAndTitle = basename.substring(0, lastDashIndex);

			// Find the first " - " to separate domain from title
			const separatorIndex = domainAndTitle.indexOf(' - ');
			if (separatorIndex === -1) {
				// Fallback: no separator found, treat as title only (backwards compat with titleFilenameSerializer)
				return {
					id,
					domainFromFilename: '',
					titleFromFilename: domainAndTitle,
				};
			}

			const domainFromFilename = domainAndTitle.substring(0, separatorIndex);
			const titleFromFilename = domainAndTitle.substring(separatorIndex + 3); // Skip " - "

			return { id, domainFromFilename, titleFromFilename };
		})
		.serialize(({ row }) => {
			const { id, ...rest } = row;
			const rawUrl = (row[urlField] as string) || '';
			const rawTitle = (row[titleField] as string) || '';

			// Extract domain from URL
			const domain = extractDomain(rawUrl);
			const sanitizedDomain = filenamify(domain, {
				maxLength: maxDomainLength,
				replacement: '',
			});

			// Sanitize title
			const sanitizedTitle =
				rawTitle.trim() === ''
					? 'Untitled'
					: filenamify(rawTitle, {
							maxLength: maxTitleLength,
							replacement: '',
						});

			// Optionally strip null values for cleaner YAML
			const frontmatter = stripNulls
				? Object.fromEntries(
						Object.entries(rest).filter(([_, value]) => value !== null),
					)
				: rest;

			return {
				frontmatter,
				body: '',
				filename: `${sanitizedDomain} - ${sanitizedTitle}-${id}.md`,
			};
		})
		.deserialize(({ frontmatter, parsed, fields }) => {
			const { id } = parsed;

			// Combine id with frontmatter
			const data = { id, ...frontmatter };

			// Validate using direct arktype pattern
			const validator = tableToArktype(fields);
			const result = validator(data);

			if (result instanceof type.errors) {
				return MarkdownExtensionErr({
					message: `Failed to validate row ${id}`,
					context: {
						fileName: `${id}.md`,
						id,
						reason: result.summary,
					},
				});
			}

			return Ok(result as RowWithId<Fields>);
		});
}
