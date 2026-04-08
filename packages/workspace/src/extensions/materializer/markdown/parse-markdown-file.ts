import { YAML } from 'bun';

/**
 * Parse a markdown file with YAML frontmatter into its constituent parts.
 *
 * Expects the standard `---` delimited frontmatter format:
 * ```markdown
 * ---
 * key: value
 * ---
 *
 * body content
 * ```
 *
 * The closing `---` must be on its own line (not `---extra` or similar).
 * Tolerates trailing whitespace on delimiter lines and UTF-8 BOM.
 * Handles both LF and CRLF line endings.
 *
 * Returns `null` if the file doesn't contain valid `---` delimited frontmatter.
 */

const FRONTMATTER_PATTERN =
	/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function parseMarkdownFile(content: string): {
	frontmatter: Record<string, unknown>;
	body: string | undefined;
} | null {
	const input = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
	const match = input.match(FRONTMATTER_PATTERN);
	if (!match) return null;

	const frontmatter = YAML.parse(match[1]);
	if (typeof frontmatter !== 'object' || frontmatter === null) return null;

	const rawBody = input
		.slice(match[0].length)
		.replace(/^\r?\n/, '') // strip blank separator line between frontmatter and body
		.replace(/\r?\n$/, ''); // strip trailing newline added by toMarkdown serialization

	return {
		frontmatter: frontmatter as Record<string, unknown>,
		body: rawBody.length > 0 ? rawBody : undefined,
	};
}
