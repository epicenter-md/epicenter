import {
	openStandaloneWorkspace,
	openWorkspaceReplica,
	type StandaloneWorkspace,
	type WorkspaceReplica,
} from '@epicenter/workspace/sqlite/browser';
import MismatchWorker from './mismatch.worker?worker';
import ReplicaAWorker from './replica-a.worker?worker';
import ReplicaBWorker from './replica-b.worker?worker';
import { workspaceDefinition } from './workspace.js';
import WorkspaceWorker from './workspace.worker?worker';

type Note = { id: string; title: string };

let workspace: StandaloneWorkspace<
	typeof workspaceDefinition.tables,
	typeof workspaceDefinition.kv
>;
let stopObserving: (() => void) | undefined;
let replica: WorkspaceReplica<
	typeof workspaceDefinition.tables,
	typeof workspaceDefinition.kv
> | null = null;
const observedIds: string[] = [];

async function open() {
	workspace = await openStandaloneWorkspace(workspaceDefinition, {
		worker: () => new WorkspaceWorker(),
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

const replicaName = new URLSearchParams(location.search).get('replica');
if (replicaName === 'a' || replicaName === 'b') {
	replica = await openWorkspaceReplica(workspaceDefinition, {
		worker: () =>
			replicaName === 'a' ? new ReplicaAWorker() : new ReplicaBWorker(),
		onObserverError(error) {
			throw error;
		},
	});
}

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
	replicaPut(note: Note) {
		if (!replica) throw new Error('Replica is not open');
		return replica.tables.notes.put(note);
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
			replicaPut(note: Note): Promise<void>;
			replicaGet(id: string): Promise<Note | null>;
			replicaDispose(): Promise<void>;
		};
	}
}
