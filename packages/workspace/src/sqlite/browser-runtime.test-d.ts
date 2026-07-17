import { field } from '@epicenter/field';
import type { createDeviceBrowserWorkspaceRuntime } from './browser-runtime.js';
import { defineTable } from './lens-definition.js';
import { defineWorkspace } from './runtime-definition.js';

const definition = defineWorkspace({
	id: 'browser-types',
	tables: {
		notes: defineTable({ fields: { title: field.string() } }),
	},
	kv: { theme: field.select(['light', 'dark']) },
});

declare const runtime: ReturnType<typeof createDeviceBrowserWorkspaceRuntime>;
const workspace = await runtime.open(definition);
const row = await workspace.tables.notes.create({ title: 'typed' });
await workspace.tables.notes.update(row.id, { title: 'updated' });
await workspace.tables.notes.document.open(row.id);
await workspace.kv.set('theme', 'dark');

// @ts-expect-error create never accepts a caller-supplied id
await workspace.tables.notes.create({ id: 'manual', title: 'typed' });
// @ts-expect-error undeclared fields are rejected
await workspace.tables.notes.update(row.id, { future: true });
