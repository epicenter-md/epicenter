/**
 * @fileoverview Pure functions to serialize skill data back to SKILL.md format.
 *
 * Reconstructs YAML frontmatter from table columns and appends the instructions
 * markdown body. Only includes non-undefined optional fields in frontmatter to
 * keep exported files clean.
 *
 * @module
 */

import { stringify as stringifyYaml } from 'yaml';
import type { Skill } from './tables.js';

/**
 * Serialize a skill row and its instructions back to SKILL.md format.
 *
 * Reconstructs the agentskills.io SKILL.md file from workspace table data.
 * Required fields (`name`, `description`) are always included. Optional fields
 * (`license`, `compatibility`, `metadata`, `allowedTools`) are only included
 * when they have a defined value—this keeps exported files minimal and clean.
 *
 * The skill's `id` is always injected into the `metadata` map so it survives
 * a full export→import cycle. On parse, `id` is extracted back out and stripped
 * from the metadata column to avoid redundancy.
 *
 * The `metadata` column (JSON-stringified `Record<string, string>`) is parsed
 * back into a nested YAML object. The `allowedTools` column is written as
 * `allowed-tools` in frontmatter to match the agentskills.io spec.
 */
export function serializeSkillMd(skill: Skill, instructions: string): string {
	// Merge skill.id into metadata so it survives round-trips through disk
	const existingMetadata = (
		skill.metadata !== undefined ? JSON.parse(skill.metadata) : {}
	) as Record<string, string>;
	const metadataWithId = { id: skill.id, ...existingMetadata };

	const fm = {
		name: skill.name,
		description: skill.description,
		...(skill.license !== undefined && { license: skill.license }),
		...(skill.compatibility !== undefined && {
			compatibility: skill.compatibility,
		}),
		metadata: metadataWithId,
		...(skill.allowedTools !== undefined && {
			'allowed-tools': skill.allowedTools,
		}),
	};

	const yamlStr = stringifyYaml(fm, { lineWidth: 0 });
	return `---\n${yamlStr}---\n\n${instructions}`;
}
