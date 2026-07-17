import { field } from '@epicenter/field';
import {
	document as collaborativeDocument,
	defineTable,
	defineWorkspace,
} from '@epicenter/workspace/sqlite';
import { createBrowserWorkspaceRuntime } from '@epicenter/workspace/sqlite/browser';
import { Type } from 'typebox';

const authorityKey = new URLSearchParams(location.search).get('authority');
if (!authorityKey) throw new Error('Expected an authority query parameter');

const definition = defineWorkspace({
	id: 'browser-runtime-smoke',
	tables: {
		notes: defineTable({ fields: { title: field.string() } }),
	},
	documents: {
		draft: collaborativeDocument.text({ params: { noteId: field.string() } }),
	},
});

let changes = 0;
const runtime = createBrowserWorkspaceRuntime({
	authorityKey,
	rowSync: {
		baseUrl: location.origin,
		fetch: (input, init) => fetch(input, init),
	},
	onRecordsChanged() {
		changes += 1;
	},
});
const workspace = await runtime.open(definition);
let draft:
	| Awaited<ReturnType<typeof workspace.documents.draft.open>>
	| undefined;
let releasedDraft:
	| Awaited<ReturnType<typeof workspace.documents.draft.open>>['content']
	| undefined;

window.productionBrowserRuntime = {
	create(title: string) {
		return workspace.tables.notes.create({ title });
	},
	get(id: string) {
		return workspace.tables.notes.get(id);
	},
	sql() {
		return workspace.records.sql(
			'SELECT id, title FROM notes ORDER BY id',
			[],
			Type.Object({ id: Type.String(), title: Type.String() }),
		);
	},
	async openDraft(noteId: string) {
		draft ??= await workspace.documents.draft.open({ noteId });
		return draft.content.read();
	},
	writeDraft(value: string) {
		if (!draft) throw new Error('Draft is not open');
		draft.content.write(value);
	},
	closeDraft() {
		if (!draft) return;
		releasedDraft = draft.content;
		draft[Symbol.dispose]();
		draft = undefined;
	},
	readReleasedDraft() {
		return releasedDraft?.read();
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
				data: { id: string; title: string } | null;
				error: unknown;
			}>;
			sql(): Promise<Array<{ id: string; title: string }>>;
			openDraft(noteId: string): Promise<string>;
			writeDraft(value: string): void;
			closeDraft(): void;
			readReleasedDraft(): string | undefined;
			changeCount(): number;
			dispose(): Promise<void>;
		};
	}
}
