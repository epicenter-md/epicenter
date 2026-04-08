/**
 * @fileoverview Pure functions to parse SKILL.md files into table row data.
 *
 * Splits YAML frontmatter from the markdown body. Frontmatter fields map 1:1
 * to `skillsTable` columns. The body becomes the instructions document content,
 * written separately via a document handle.
 *
 * @module
 */

import { parse as parseYaml } from 'yaml';
import type { Skill } from './tables.js';

/**
 * Split a markdown file with YAML frontmatter into its two parts.
 *
 * Expects the standard `---` delimiters at the start of the file. If no
 * frontmatter is found, returns an empty object and the entire content as body.
 */
function splitFrontmatter(content: string) {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!match) return { frontmatter: {}, body: content };

	const [, yamlStr, body] = match as [string, string, string];
	const parsed: unknown = parseYaml(yamlStr);
	const frontmatter =
		parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};

	return { frontmatter, body: body.trimStart() };
}

/**
 * Parse a SKILL.md file into fields suitable for a skills table row.
 *
 * Splits YAML frontmatter from the markdown body. Frontmatter fields map 1:1
 * to table columns per the agentskills.io spec:
 *
 * - `id` → extracted from `metadata.id` if present (survives round-trips)
 * - `name` → from the directory name (passed as parameter), not frontmatter
 * - `description` → frontmatter `description` field
 * - `license`, `compatibility`, `allowedTools` → optional frontmatter fields
 * - `metadata` → frontmatter `metadata` minus the reserved `id` key, JSON-stringified
 *
 * When `metadata.id` is present, it is extracted as the skill's stable identity
 * and stripped from the `metadata` column to avoid redundancy. This lets IDs
 * survive a full export→import cycle even on a fresh workspace.
 */
export function parseSkillMd(
	name: string,
	content: string,
): {
	skill: Omit<Skill, 'id'> & { id: string | undefined };
	instructions: string;
} {
	const { frontmatter, body } = splitFrontmatter(content);

	// Extract id from metadata.id, then strip it so it doesn't pollute the metadata column
	let parsedId: string | undefined;
	let metadataRecord: Record<string, unknown> | undefined;

	if (
		frontmatter.metadata != null &&
		typeof frontmatter.metadata === 'object' &&
		!Array.isArray(frontmatter.metadata)
	) {
		const { id: rawId, ...rest } = frontmatter.metadata as Record<
			string,
			unknown
		>;
		if (
			typeof rawId === 'string' &&
			rawId.length > 0 &&
			rawId.trim() === rawId &&
			!rawId.includes(':')
		) {
			parsedId = rawId;
		}
		// Only keep metadata if there are remaining keys after stripping id
		if (Object.keys(rest).length > 0) metadataRecord = rest;
	}

	return {
		skill: {
			id: parsedId,
			name,
			description: String(frontmatter.description ?? ''),
			license:
				typeof frontmatter.license === 'string'
					? frontmatter.license
					: undefined,
			compatibility:
				typeof frontmatter.compatibility === 'string'
					? frontmatter.compatibility
					: undefined,
			metadata:
				metadataRecord !== undefined
					? JSON.stringify(metadataRecord)
					: undefined,
			allowedTools:
				typeof frontmatter['allowed-tools'] === 'string'
					? frontmatter['allowed-tools']
					: undefined,
			updatedAt: Date.now(),
			_v: 1 as const,
		},
		instructions: body,
	};
}
