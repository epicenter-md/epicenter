import {
	type LocalWorkspace,
	openLocalWorkspace,
} from '@epicenter/workspace/sqlite/browser';
import MismatchWorker from './mismatch.worker?worker';
import { workspaceDefinition } from './workspace.js';
import WorkspaceWorker from './workspace.worker?worker';

type Note = { id: string; title: string };

let workspace: LocalWorkspace<
	typeof workspaceDefinition.tables,
	typeof workspaceDefinition.kv
>;
let stopObserving: (() => void) | undefined;
const observedIds: string[] = [];

async function open() {
	workspace = await openLocalWorkspace(workspaceDefinition, {
		storage: { kind: 'opfs', worker: () => new WorkspaceWorker() },
		onObserverError(error) {
			throw error;
		},
	});
	stopObserving = workspace.tables.notes.observe((delta) => {
		for (const row of delta.upserted) observedIds.push(row.id);
		observedIds.push(...delta.removed);
	});
}

async function dispose() {
	stopObserving?.();
	stopObserving = undefined;
	await workspace[Symbol.asyncDispose]();
}

await open();

window.workspaceSmoke = {
	put(note: Note) {
		return workspace.tables.notes.put(note);
	},
	get(id: string) {
		return workspace.tables.notes.get(id);
	},
	list() {
		return workspace.tables.notes.list({ orderBy: 'id' });
	},
	observedIds,
	dispose,
	async reopen() {
		await open();
	},
	async mismatchError() {
		try {
			const mismatched = await openLocalWorkspace(workspaceDefinition, {
				storage: { kind: 'opfs', worker: () => new MismatchWorker() },
				onObserverError() {},
			});
			await mismatched[Symbol.asyncDispose]();
			return null;
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
	},
};

document.body.dataset.ready = 'true';
const status = document.querySelector('#status');
if (status) status.textContent = 'OPFS workspace ready';

declare global {
	interface Window {
		workspaceSmoke: {
			put(note: Note): Promise<void>;
			get(id: string): Promise<Note | null>;
			list(): Promise<Note[]>;
			observedIds: string[];
			dispose(): Promise<void>;
			reopen(): Promise<void>;
			mismatchError(): Promise<string | null>;
		};
	}
}
