import { field } from '@epicenter/field';
import { defineTable } from './lens-definition.js';
import type { WorkspaceRuntime } from './runtime.js';
import { defineWorkspace } from './runtime-definition.js';

const definition = defineWorkspace({
	id: 'types',
	tables: {
		notes: defineTable({
			fields: { title: field.string(), archived: field.boolean() },
			optional: ['archived'],
		}),
	},
	kv: { theme: field.select(['light', 'dark']) },
});

declare const runtime: WorkspaceRuntime;
const workspace = await runtime.open(definition);
const row = await workspace.tables.notes.create({ title: 'typed' });
await workspace.tables.notes.update(row.id, { archived: undefined });
await workspace.tables.notes.document.open(row.id);
await workspace.kv.set('theme', 'dark');

// @ts-expect-error identity is allocated by create
await workspace.tables.notes.create({ id: 'manual', title: 'typed' });
// @ts-expect-error required fields cannot be unset
await workspace.tables.notes.update(row.id, { title: undefined });
// @ts-expect-error undeclared fields cannot be updated
await workspace.tables.notes.update(row.id, { future: true });
// @ts-expect-error KV values are lens-typed
await workspace.kv.set('theme', 'future');
