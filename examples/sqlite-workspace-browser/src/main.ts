import {
	openStandaloneWorkspace,
	openWorkspaceReplica,
	type StandaloneWorkspace,
	type WorkspaceReplica,
} from '@epicenter/workspace/sqlite/browser';
import * as Y from 'yjs';
import MismatchWorker from './mismatch.worker?worker';
import ReplicaWorker from './replica.worker?worker';
import { workspaceDefinition } from './workspace.js';
import WorkspaceWorker from './workspace.worker?worker';

type Note = { id: string; title: string };
type CreateNote = Omit<Note, 'id'>;
type Theme = 'light' | 'dark';

// The preference plane lives on the eager root Yjs document, composed on the
// main thread next to the SQLite worker client. The generation lock owns its
// guid; persistence is environment-injected and out of scope here.
const preferencesDoc = new Y.Doc({ guid: workspaceDefinition.kvDocumentGuid });

let workspace:
	| StandaloneWorkspace<
			typeof workspaceDefinition.tables,
			typeof workspaceDefinition.kv
	  >
	| undefined;
let stopObserving: (() => void) | undefined;
let replica: WorkspaceReplica<typeof workspaceDefinition.tables> | null = null;
const observedIds: string[] = [];

async function open() {
	workspace = await openStandaloneWorkspace(workspaceDefinition, {
		worker: () => new WorkspaceWorker(),
		kv: { doc: preferencesDoc },
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
	await workspace?.[Symbol.asyncDispose]();
	workspace = undefined;
}

function getWorkspace() {
	if (!workspace) throw new Error('Standalone workspace is not open');
	return workspace;
}

const isReplica = new URLSearchParams(location.search).has('replica');
if (isReplica) {
	replica = await openWorkspaceReplica(workspaceDefinition, {
		worker: () => new ReplicaWorker(),
		onObserverError(error) {
			throw error;
		},
	});
} else {
	await open();
}

window.workspaceSmoke = {
	create(note: CreateNote) {
		return getWorkspace().tables.notes.create(note);
	},
	get(id: string) {
		return getWorkspace().tables.notes.get(id);
	},
	list() {
		return getWorkspace().tables.notes.list({ orderBy: 'id' });
	},
	// The kv handle is synchronous: no worker round trip, no promises.
	theme() {
		return getWorkspace().kv.get('theme');
	},
	setTheme(value: Theme) {
		getWorkspace().kv.set('theme', value);
	},
	observedIds,
	dispose,
	async reopen() {
		await open();
	},
	async mismatchError() {
		try {
			const mismatched = await openStandaloneWorkspace(workspaceDefinition, {
				worker: () => new MismatchWorker(),
				onObserverError() {},
			});
			await mismatched[Symbol.asyncDispose]();
			return null;
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
	},
	replicaCreate(note: CreateNote) {
		if (!replica) throw new Error('Replica is not open');
		return replica.tables.notes.create(note);
	},
	replicaGet(id: string) {
		if (!replica) throw new Error('Replica is not open');
		return replica.tables.notes.get(id);
	},
	async replicaDispose() {
		await replica?.[Symbol.asyncDispose]();
		replica = null;
	},
};

document.body.dataset.ready = 'true';
document.body.dataset.replicaReady = String(replica !== null);
document.body.dataset.workspaceId = workspaceDefinition.workspaceId;
document.body.dataset.kvDocumentGuid = preferencesDoc.guid;
const status = document.querySelector('#status');
if (status) status.textContent = 'OPFS workspace ready';

declare global {
	interface Window {
		workspaceSmoke: {
			create(note: CreateNote): Promise<Note>;
			get(id: string): Promise<Note | null>;
			list(): Promise<Note[]>;
			theme(): Theme;
			setTheme(value: Theme): void;
			observedIds: string[];
			dispose(): Promise<void>;
			reopen(): Promise<void>;
			mismatchError(): Promise<string | null>;
			replicaCreate(note: CreateNote): Promise<Note>;
			replicaGet(id: string): Promise<Note | null>;
			replicaDispose(): Promise<void>;
		};
	}
}
