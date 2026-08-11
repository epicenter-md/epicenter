/** Pure serialization for the agentskills.io SKILL.md representation. */

import { stringify as stringifyYaml } from 'yaml';
import type { Skill } from './lens.js';

/**
 * Serialize one conforming skill and its collaborative instruction body.
 *
 * An absent optional field reads as `null` rather than as a missing key, so the
 * omissions below test for it: a Lens has no optional fields, and `null` is how
 * "this skill declares no license" is spelled (ADR-0213).
 */
export function serializeSkillMd(skill: Skill, instructions: string): string {
	const frontmatter = {
		name: skill.name,
		description: skill.description,
		...(skill.license !== null && { license: skill.license }),
		...(skill.compatibility !== null && {
			compatibility: skill.compatibility,
		}),
		metadata: { ...skill.metadata, id: skill.sourceId },
		...(skill.allowedTools !== null && {
			'allowed-tools': skill.allowedTools,
		}),
	};

	return `---\n${stringifyYaml(frontmatter, { lineWidth: 0 })}---\n\n${instructions}`;
}
