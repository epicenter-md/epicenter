/**
 * Workspace Runtime Type Tests
 *
 * Locks the imported definition, direct async table handle, and read-only SQL
 * boundary without compatibility surfaces for KV, migrations, or string-id
 * opening.
 */

import { field } from '@epicenter/field';
import { Type } from 'typebox';
import { document } from './document-definition.js';
import { defineTable } from './lens-definition.js';
import type { WorkspaceRuntime } from './runtime.js';
import { defineWorkspace } from './runtime-definition.js';

const skillsDefinition = defineWorkspace({
	id: 'skills',
	tables: {
		skills: defineTable({
			fields: {
				title: field.string(),
				archived: field.boolean(),
			},
			optional: ['archived'],
		}),
	},
	documents: {
		instructions: document.text({ params: { skillId: field.string() } }),
	},
});

declare const runtime: WorkspaceRuntime;
const skills = await runtime.open(skillsDefinition);
const created = await skills.tables.skills.create({ title: 'Typed' });
await skills.tables.skills.patch(created.id, { archived: undefined });
await skills.records.sql(
	'SELECT id, title FROM skills',
	[],
	Type.Object({ id: Type.String(), title: Type.String() }),
);
await using instructions = await skills.documents.instructions.open({
	skillId: created.id,
});
instructions.content.write('Typed document');

// @ts-expect-error: opening is linked by an imported definition, not a string id
await runtime.open('skills');
// @ts-expect-error: structural ids are allocated by the runtime
await skills.tables.skills.create({ id: 'caller-id', title: 'Forbidden' });
// @ts-expect-error: required fields cannot be unset
await skills.tables.skills.patch(created.id, { title: undefined });
// @ts-expect-error: undeclared keys are not part of this release's lens
await skills.tables.skills.patch(created.id, { future: true });
// @ts-expect-error: there is no privileged KV plane
void skills.kv;
// @ts-expect-error: user-data migrations are refused
void skills.migrate;
// @ts-expect-error: raw SQL writes are not exposed
void skills.records.write;
// @ts-expect-error: private room identifiers never enter the public handle
void instructions.roomId;
// @ts-expect-error: declared document params are mandatory
await skills.documents.instructions.open();
