/**
 * Async Workspace View Tests
 *
 * The transport-facing lens composer must refuse a missing-row update or
 * delete even when the row disappears between its renderer-side read and the
 * schema-blind admit. The owner stamps WorkspaceRowAbsentError on that race;
 * the view surfaces it as MissingRow for update and rejects delete, without a
 * silent success or an afterDelete side effect.
 */
import { field } from '@epicenter/field';
import type { WireRowIntent } from '@epicenter/row-sync';
import { expect, test } from 'bun:test';
import type { JsonObject } from './lens-definition.js';
import { defineTable } from './lens-definition.js';
import { WORKSPACE_ROW_ABSENT_ERROR_NAME } from './canonical-store.js';
import { createAsyncWorkspaceView } from './async-workspace-view.js';
import { defineWorkspace } from './workspace-lens.js';

const lens = defineWorkspace({
	id: 'async-view-test',
	tables: {
		notes: defineTable({ fields: { title: field.string() } }),
	},
});

function rowAbsent(): Error {
	const error = new Error('row gone');
	error.name = WORKSPACE_ROW_ABSENT_ERROR_NAME;
	return error;
}

type FakeClientOptions = {
	read(table: string, rowId: string): JsonObject | undefined;
	admit(intent: WireRowIntent): void;
};

function createView(options: FakeClientOptions) {
	const deletions: { table: string; rowId: string }[] = [];
	const admitted: WireRowIntent[] = [];
	const view = createAsyncWorkspaceView(lens, {
		async read(table, rowId) {
			return options.read(table, rowId);
		},
		async list() {
			return [];
		},
		async readKvMap() {
			return {};
		},
		async admit(intent) {
			admitted.push(intent);
			options.admit(intent);
		},
		async sql(): Promise<unknown[]> {
			return [];
		},
		async openDocument() {
			return undefined;
		},
		sync: null,
		afterDelete(address) {
			deletions.push(address);
		},
	});
	return { view, deletions, admitted };
}

test('update of a never-present row refuses without admitting an intent', async () => {
	const { view, admitted } = createView({
		read: () => undefined,
		admit: () => undefined,
	});
	const result = await view.tables.notes.update('missing', { title: 'x' });
	expect(result.error?.name).toBe('MissingRow');
	// No speculative intent crossed the schema-blind boundary.
	expect(admitted).toEqual([]);
});

test('update loses its race with deletion and surfaces MissingRow', async () => {
	// The read sees a live row, but the owner refuses the admit because the row
	// died in between. The view maps that owner refusal to the same result.
	const { view } = createView({
		read: () => ({ title: 'A' }),
		admit: () => {
			throw rowAbsent();
		},
	});
	const result = await view.tables.notes.update('racing', { title: 'B' });
	expect(result.error?.name).toBe('MissingRow');
});

test('delete loses its race with deletion, rejects, and skips afterDelete', async () => {
	const { view, deletions } = createView({
		read: () => ({ title: 'A' }),
		admit: () => {
			throw rowAbsent();
		},
	});
	await expect(view.tables.notes.delete('racing')).rejects.toThrow('row gone');
	expect(deletions).toEqual([]);
});
