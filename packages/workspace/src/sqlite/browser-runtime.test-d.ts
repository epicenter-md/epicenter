import { field } from '@epicenter/field';
import type {
	createAccountBrowserWorkspaceRuntime,
	createDeviceBrowserWorkspaceRuntime,
} from './browser-runtime.js';
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
declare const accountRuntime: ReturnType<
	typeof createAccountBrowserWorkspaceRuntime
>;
const workspace = await runtime.open(definition);
const row = await workspace.tables.notes.create({ title: 'typed' });
await workspace.tables.notes.update(row.id, { title: 'updated' });
await workspace.tables.notes.document.open(row.id);
await workspace.kv.set('theme', 'dark');
const copy = await runtime.capture(definition);
await accountRuntime.add(definition, copy);
const deviceExport = await runtime.export(definition);
deviceExport.settlement satisfies null | { outcome: string };
await accountRuntime.export(definition);
await runtime.delete(definition);

// @ts-expect-error Device runtimes never upload logical data
await runtime.add(definition, copy);
// @ts-expect-error Account runtimes never expose Device deletion
await accountRuntime.delete(definition);
// @ts-expect-error the verifyAdded deletion gate was removed with the
// automatic delete-after-copy promise; copy is optional and the source stays
await accountRuntime.verifyAdded(definition, copy);
// @ts-expect-error Account runtimes never expose Device capture
await accountRuntime.capture(definition);

// @ts-expect-error create never accepts a caller-supplied id
await workspace.tables.notes.create({ id: 'manual', title: 'typed' });
// @ts-expect-error undeclared fields are rejected
await workspace.tables.notes.update(row.id, { future: true });
