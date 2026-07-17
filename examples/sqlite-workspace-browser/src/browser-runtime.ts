import { field } from '@epicenter/field';
import { asPrincipalId } from '@epicenter/identity';
import {
	defineTable,
	defineWorkspace,
	type RowDocument,
} from '@epicenter/workspace/sqlite';
import { createAccountBrowserWorkspaceRuntime } from '@epicenter/workspace/sqlite/browser';
import { Type } from 'typebox';

const principalId = new URLSearchParams(location.search).get('principal');
if (!principalId) throw new Error('Expected a principal query parameter');

const definition = defineWorkspace({
	id: 'browser-runtime-smoke',
	tables: {
		notes: defineTable({ fields: { title: field.string() } }),
	},
	kv: {},
});

let changes = 0;
const runtime = createAccountBrowserWorkspaceRuntime({
	account: {
		deploymentId: location.origin,
		principalId: asPrincipalId(principalId),
		transport: {
			baseUrl: location.origin,
			fetch: (input, init) => fetch(input, init),
		},
	},
	onRecordsChanged() {
		changes += 1;
	},
});
const workspace = await runtime.open(definition);
let draft: RowDocument | undefined;

window.productionBrowserRuntime = {
	create(title: string) {
		return workspace.tables.notes.create({ title });
	},
	get(id: string) {
		return workspace.tables.notes.get(id);
	},
	sql() {
		return workspace.sql(
			'SELECT id, title FROM notes ORDER BY id',
			[],
			Type.Object({ id: Type.String(), title: Type.String() }),
		);
	},
	async openDraft(noteId: string) {
		draft ??= await workspace.tables.notes.document.open(noteId);
		return draft.get('draft').toString();
	},
	async writeDraft(value: string) {
		if (!draft) throw new Error('Draft is not open');
		const root = draft.get('draft');
		root.delete(0, root.length);
		root.insert(0, value);
		await draft.whenDurable();
	},
	closeDraft() {
		if (!draft) return;
		draft[Symbol.dispose]();
		draft = undefined;
	},
	changeCount() {
		return changes;
	},
	async dispose() {
		draft?.[Symbol.dispose]();
		draft = undefined;
		await runtime[Symbol.asyncDispose]();
	},
};

document.body.dataset.ready = 'true';
const status = document.querySelector('#status');
if (status) status.textContent = 'Production Browser workspace runtime ready';

declare global {
	interface Window {
		productionBrowserRuntime: {
			create(title: string): Promise<{ id: string; title: string }>;
			get(id: string): Promise<{
				data: { id: string; title: string } | undefined | null;
				error: unknown;
			}>;
			sql(): Promise<Array<{ id: string; title: string }>>;
			openDraft(noteId: string): Promise<string>;
			writeDraft(value: string): Promise<void>;
			closeDraft(): void;
			changeCount(): number;
			dispose(): Promise<void>;
		};
	}
}
