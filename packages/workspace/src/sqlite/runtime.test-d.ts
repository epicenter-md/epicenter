/**
 * Workspace Runtime Type Tests
 *
 * Verifies release-lens inputs and the nullable, readonly synchronization
 * capability exposed by an opened workspace.
 */
import { field } from '@epicenter/field';
import type {
	WorkspaceRuntime,
	WorkspaceSync,
	WorkspaceSyncSettlement,
	WorkspaceSyncStatus,
} from './index.js';
import { defineTable } from './lens-definition.js';
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
await workspace.opened;
const row = await workspace.tables.notes.create({ title: 'typed' });
await workspace.tables.notes.update(row.id, { archived: undefined });
await workspace.tables.notes.document.open(row.id);
await workspace.kv.set('theme', 'dark');

// @ts-expect-error opening readiness is runtime-owned
workspace.opened = Promise.resolve();

const nullableSync: WorkspaceSync | null = workspace.sync;
if (nullableSync) {
	const status: WorkspaceSyncStatus = nullableSync.status;
	const settlement: WorkspaceSyncSettlement = await nullableSync.settle();
	const recovery = await nullableSync.captureRecovery();
	status satisfies WorkspaceSyncStatus;
	settlement satisfies WorkspaceSyncSettlement;
	recovery satisfies
		| import('./canonical-addition.js').LogicalWorkspaceCopy
		| null;
	// @ts-expect-error synchronization status is runtime-owned
	nullableSync.status = { phase: 'syncing' };
}

// @ts-expect-error local-only workspaces make synchronization nullable
await workspace.sync.settle();

// @ts-expect-error identity is allocated by create
await workspace.tables.notes.create({ id: 'manual', title: 'typed' });
// @ts-expect-error required fields cannot be unset
await workspace.tables.notes.update(row.id, { title: undefined });
// @ts-expect-error undeclared fields cannot be updated
await workspace.tables.notes.update(row.id, { future: true });
// @ts-expect-error KV values are lens-typed
await workspace.kv.set('theme', 'future');
