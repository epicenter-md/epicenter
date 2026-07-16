/**
 * Release-local record lenses for the shared Skills workspace.
 *
 * Structural row ids are allocated by the workspace runtime. `sourceId` is the
 * portable agentskills.io identity stored in SKILL.md frontmatter and may be
 * used to match later imports without becoming canonical record identity.
 */

import { field, jsonValue } from '@epicenter/field';
import { defineTable, type RowFor } from '@epicenter/workspace/sqlite';
import { Type } from 'typebox';

export const skillsTable = defineTable({
	fields: {
		sourceId: field.string(),
		name: field.string(),
		description: field.string(),
		license: field.string(),
		compatibility: field.string(),
		metadata: field.json(Type.Record(Type.String(), jsonValue)),
		allowedTools: field.string(),
		updatedAt: field.instant(),
	},
	optional: ['license', 'compatibility', 'metadata', 'allowedTools'],
});

export const referencesTable = defineTable({
	fields: {
		skillId: field.string(),
		path: field.string(),
		updatedAt: field.instant(),
	},
});

export type Skill = RowFor<typeof skillsTable>;
export type Reference = RowFor<typeof referencesTable>;
