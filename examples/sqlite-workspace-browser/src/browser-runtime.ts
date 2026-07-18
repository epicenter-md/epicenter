import { field } from '@epicenter/field';
import { asPrincipalId } from '@epicenter/identity';
import {
	defineTable,
	defineWorkspace,
	isWorkspaceStorageMovedError,
	type RowDocument,
	rowDocumentConnection,
	type WorkspaceHandle,
} from '@epicenter/workspace/sqlite';
import { createAccountBrowserWorkspaceRuntime } from '@epicenter/workspace/sqlite/browser';
import { Type } from 'typebox';

const params = new URLSearchParams(location.search);
const apiOrigin = params.get('api');
const token = params.get('token');
if (!apiOrigin || !token) {
	throw new Error('Expected api and token query parameters');
}

const definition = defineWorkspace({
	id: 'browser-runtime-smoke',
	tables: {
		notes: defineTable({ fields: { title: field.string() } }),
	},
	kv: {},
});

let changes = 0;
let movedNotice: string | undefined;
const runtime = createAccountBrowserWorkspaceRuntime({
	account: {
		deploymentId: apiOrigin,
		principalId: asPrincipalId('instance'),
		transport: {
			baseUrl: apiOrigin,
			fetch: (input, init) => fetch(input, init),
			headers: { authorization: `Bearer ${token}` },
			credentials: 'omit',
			// The smoke drives cross-context deletion within test timeouts.
			pollIntervalMs: 250,
			openWebSocket: async (url, protocols) =>
				new WebSocket(url, [...(protocols ?? []), `bearer.${token}`]),
		},
	},
	onRecordsChanged() {
		changes += 1;
	},
	// The steal notification apps turn into their blocking moved screen.
	onBackgroundError(cause) {
		if (isWorkspaceStorageMovedError(cause)) movedNotice = cause.message;
	},
});
// The same infallible-module boot contract the production apps use: open()
// returns the stable handle synchronously, handle.opened reports readiness,
// success flags dataset.ready, and a rejection (for example held storage)
// flags dataset.bootError with the error's contract name instead of
// blanking the page.
const workspace: WorkspaceHandle<typeof definition> = runtime.open(definition);
let draft: RowDocument | undefined;
workspace.opened.then(
	() => {
		document.body.dataset.ready = 'true';
		const status = document.querySelector('#status');
		if (status) {
			status.textContent = 'Production Browser workspace runtime ready';
		}
	},
	(cause: unknown) => {
		document.body.dataset.bootError =
			cause instanceof Error ? cause.name : 'Error';
		document.body.dataset.bootMessage =
			cause instanceof Error ? cause.message : String(cause);
	},
);

window.productionBrowserRuntime = {
	movedNotice() {
		return movedNotice;
	},
	create(title: string) {
		return workspace.tables.notes.create({ title });
	},
	get(id: string) {
		return workspace.tables.notes.get(id);
	},
	delete(id: string) {
		return workspace.tables.notes.delete(id);
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
	readDraft() {
		if (!draft) throw new Error('Draft is not open');
		try {
			return { text: draft.get('draft').toString() };
		} catch (cause) {
			return {
				revoked: cause instanceof Error ? cause.message : String(cause),
			};
		}
	},
	draftConnectionPhase() {
		if (!draft) return undefined;
		return rowDocumentConnection(draft)?.status.phase;
	},
	closeDraft() {
		if (!draft) return;
		draft[Symbol.dispose]();
		draft = undefined;
	},
	changeCount() {
		return changes;
	},
	async settle() {
		const sync = workspace.sync;
		if (!sync) throw new Error('Workspace has no synchronization');
		return sync.settle();
	},
	async dispose() {
		draft?.[Symbol.dispose]();
		draft = undefined;
		await runtime[Symbol.asyncDispose]();
	},
};

declare global {
	interface Window {
		productionBrowserRuntime: {
			create(title: string): Promise<{ id: string; title: string }>;
			get(id: string): Promise<{
				data: { id: string; title: string } | undefined | null;
				error: unknown;
			}>;
			delete(id: string): Promise<void>;
			sql(): Promise<Array<{ id: string; title: string }>>;
			openDraft(noteId: string): Promise<string>;
			writeDraft(value: string): Promise<void>;
			readDraft(): { text?: string; revoked?: string };
			draftConnectionPhase(): string | undefined;
			closeDraft(): void;
			changeCount(): number;
			movedNotice(): string | undefined;
			settle(): Promise<{ outcome: string }>;
			dispose(): Promise<void>;
		};
	}
}
