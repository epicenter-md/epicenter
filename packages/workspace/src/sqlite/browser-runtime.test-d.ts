import { field } from '@epicenter/field';
import type {
	createAccountBrowserWorkspaceRuntime,
	createDeviceBrowserWorkspaceRuntime,
} from './browser-runtime.js';
import { defineTable } from './lens-definition.js';
import { defineWorkspace } from './workspace-lens.js';

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
const copy = await runtime.capture(definition.id);
await accountRuntime.add(definition.id, copy);
const deviceExport = await runtime.export(definition.id);
deviceExport.settlement satisfies null | { outcome: string };
await accountRuntime.export(definition.id);
await runtime.delete(definition.id);

// @ts-expect-error lifecycle operations take the Workspace ID, not a lens
await runtime.capture(definition);
// @ts-expect-error account addition takes the Workspace ID, not a lens
await accountRuntime.add(definition, copy);

// @ts-expect-error a ready handle carries no pre-ready readiness surface
workspace.opened;

// @ts-expect-error Device runtimes never upload logical data
await runtime.add(definition.id, copy);
// @ts-expect-error Account runtimes never expose Device deletion
await accountRuntime.delete(definition.id);
// @ts-expect-error the verifyAdded deletion gate was removed with the
// automatic delete-after-copy promise; copy is optional and the source stays
await accountRuntime.verifyAdded(definition, copy);
// @ts-expect-error Account runtimes never expose Device capture
await accountRuntime.capture(definition.id);

// @ts-expect-error create never accepts a caller-supplied id
await workspace.tables.notes.create({ id: 'manual', title: 'typed' });
// @ts-expect-error undeclared fields are rejected
await workspace.tables.notes.update(row.id, { future: true });
