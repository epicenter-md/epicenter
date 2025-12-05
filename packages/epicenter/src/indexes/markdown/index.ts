/**
 * Markdown index - Bidirectional sync between YJS and markdown files
 *
 * Main entry point for the markdown index. Exports the markdownIndex function
 * and utilities for custom serializers and error handling.
 */

// Table config factories and types
export type { TableMarkdownConfig, WithBodyFieldOptions } from './configs';
export { withBodyField } from './configs';

// Markdown file operations
export type { MarkdownOperationError } from './io';
export {
	deleteMarkdownFile,
	listMarkdownFiles,
	readMarkdownFile,
	writeMarkdownFile,
} from './io';

// Main index implementation and core exports
export type { MarkdownIndexConfig } from './markdown-index';
export {
	DEFAULT_TABLE_CONFIG,
	MarkdownIndexErr,
	MarkdownIndexError,
	markdownIndex,
} from './markdown-index';
