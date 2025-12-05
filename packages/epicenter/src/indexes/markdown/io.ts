import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { type } from 'arktype';
import { createTaggedError, extractErrorMessage } from 'wellcrafted/error';
import { Ok, type Result, tryAsync } from 'wellcrafted/result';
import type { AbsolutePath } from '../../core/types';

export const { MarkdownOperationError, MarkdownOperationErr } =
	createTaggedError('MarkdownOperationError');
export type MarkdownOperationError = ReturnType<typeof MarkdownOperationError>;

/**
 * Read a markdown file with optional frontmatter.
 * If file has no frontmatter (doesn't start with ---), treats entire file as body.
 * Does not validate against schema - that's handled by tableConfig.deserialize.
 *
 * @param filePath - Path to the markdown file
 * @returns Result with data (frontmatter as Record<string, unknown>) and body, or error
 */
export async function readMarkdownFile(filePath: string): Promise<
	Result<
		{
			data: Record<string, unknown>;
			body: string;
		},
		MarkdownOperationError
	>
> {
	return tryAsync({
		try: async () => {
			const file = Bun.file(filePath);

			// Check if file exists
			const exists = await file.exists();
			if (!exists) {
				throw new Error(`File not found: ${filePath}`);
			}

			// Read file content
			const content = await file.text();

			// Check if file has frontmatter
			if (!content.startsWith('---\n')) {
				// No frontmatter: treat entire file as body
				return {
					data: {},
					body: content.trim(),
				};
			}

			// Find the end of frontmatter
			const endIndex = content.indexOf('\n---\n', 4);
			if (endIndex === -1) {
				throw new Error(`Invalid frontmatter format in file: ${filePath}`);
			}

			// Extract frontmatter and body
			const frontmatterYaml = content.slice(4, endIndex);
			const bodyContent = content.slice(endIndex + 5).trim();

			// Parse YAML frontmatter using Bun's built-in YAML parser
			// Bun.YAML.parse can return:
			// - Object: normal case with frontmatter fields (e.g., { title: "...", tags: [...] })
			// - null: empty YAML, whitespace-only, or no content between --- delimiters
			// - Primitives: number, string, boolean (if YAML is just a scalar value)
			// - Array: if YAML is just an array
			const parsedData = Bun.YAML.parse(frontmatterYaml);

			// Validate that data is a plain object using type guard
			// If it's not a plain object, use empty object instead
			const data = type('Record<string, unknown>').allows(parsedData)
				? parsedData
				: {};

			return {
				data,
				body: bodyContent,
			};
		},
		catch: (error) =>
			MarkdownOperationErr({
				message: `Failed to read markdown file ${filePath}: ${extractErrorMessage(error)}`,
				context: { filePath },
			}),
	});
}

export async function writeMarkdownFile({
	filePath,
	frontmatter,
	body,
}: {
	filePath: string;
	frontmatter: Record<string, unknown>;
	body: string;
}): Promise<Result<void, MarkdownOperationError>> {
	return tryAsync({
		try: async () => {
			// Check if frontmatter is empty
			const hasFrontmatter = Object.keys(frontmatter).length > 0;

			// Skip frontmatter delimiters for empty objects to avoid "---\n{}\n---" in files
			const markdown = hasFrontmatter
				? `---\n${Bun.YAML.stringify(frontmatter, null, 2)}\n---\n${body}`
				: body;

			// Write file (Bun.write creates parent directories by default)
			await Bun.write(filePath, markdown);
		},
		catch: (error) =>
			MarkdownOperationErr({
				message: `Failed to write markdown file ${filePath}: ${extractErrorMessage(error)}`,
				context: { filePath },
			}),
	});
}

export async function deleteMarkdownFile({
	filePath,
}: {
	filePath: string;
}): Promise<Result<void, MarkdownOperationError>> {
	return tryAsync({
		try: async () => {
			const file = Bun.file(filePath);
			const exists = await file.exists();
			if (!exists) return; // File already deleted, operation succeeded
			await file.delete();
		},
		catch: (error) =>
			MarkdownOperationErr({
				message: `Failed to delete markdown file ${filePath}: ${extractErrorMessage(error)}`,
				context: { filePath },
			}),
	});
}

/**
 * List all markdown files in a directory recursively
 *
 * @param sourcePath - Path to the directory (can be relative or absolute)
 * @returns Array of absolute paths to all .md files found (empty array if directory doesn't exist)
 */
export async function listMarkdownFiles(
	sourcePath: string,
): Promise<AbsolutePath[]> {
	// Convert to absolute path first (handles both relative and absolute input)
	const absoluteSourcePath = resolve(sourcePath) as AbsolutePath;

	// Try to read directory, return empty array if it doesn't exist
	const { data: files } = await tryAsync({
		try: async () => {
			const files = await readdir(absoluteSourcePath, { recursive: true });
			return files
				.filter((file) => file.endsWith('.md'))
				.map((file) => join(absoluteSourcePath, file) as AbsolutePath);
		},
		catch: (_) => {
			// Directory doesn't exist or isn't readable - return empty array
			// This is expected behavior during initial setup
			return Ok([]);
		},
	});

	return files;
}
