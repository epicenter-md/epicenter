import type {
	RowLensError,
	WorkspaceHandle,
} from '@epicenter/workspace/sqlite';
import type { Recording, whisperingWorkspace } from '../workspace';

export type WhisperingRecordings = {
	readonly sorted: Recording[];
	readonly count: number;
	readonly nonconforming: RowLensError[];
	readonly loadError: unknown;
	get(id: Recording['id']): Recording | undefined;
	create(value: Omit<Recording, 'id'>): Promise<Recording>;
	update(
		id: Recording['id'],
		partial: Partial<Omit<Recording, 'id' | 'audioBlobId'>>,
	): ReturnType<
		WorkspaceHandle<
			typeof whisperingWorkspace
		>['tables']['recordings']['update']
	>;
	delete(id: Recording['id']): Promise<void>;
	refresh(): Promise<void>;
	subscribe(listener: () => void): () => void;
};

export function createWhisperingRecordings({
	workspace,
	onRecordsChanged,
	reportBackgroundError,
}: {
	workspace: WorkspaceHandle<typeof whisperingWorkspace>;
	onRecordsChanged(listener: () => void): () => void;
	reportBackgroundError(cause: unknown): void;
}) {
	let rows: Recording[] = [];
	let sorted: Recording[] = [];
	let nonconforming: RowLensError[] = [];
	let loadError: unknown = null;
	let refreshGeneration = 0;
	let isDisposed = false;
	const listeners = new Set<() => void>();
	const notify = () => {
		for (const listener of listeners) listener();
	};

	async function refresh({ rethrow = false }: { rethrow?: boolean } = {}) {
		refreshGeneration += 1;
		while (!isDisposed) {
			const generation = refreshGeneration;
			try {
				const listed = await workspace.tables.recordings.list();
				if (isDisposed) return;
				if (generation !== refreshGeneration) continue;
				rows = listed.rows as Recording[];
				sorted = rows.toSorted(
					(left, right) =>
						new Date(right.recordedAt).getTime() -
						new Date(left.recordedAt).getTime(),
				);
				nonconforming = listed.nonconforming;
				loadError = null;
				notify();
			} catch (cause) {
				if (isDisposed) return;
				if (generation !== refreshGeneration) continue;
				loadError = cause;
				notify();
				if (rethrow) throw cause;
				reportBackgroundError(cause);
			}
			return;
		}
	}

	const unsubscribeRecords = onRecordsChanged(() => void refresh());
	const ready = refresh({ rethrow: true });
	const recordings: WhisperingRecordings = {
		get sorted() {
			return sorted;
		},
		get count() {
			return rows.length;
		},
		get nonconforming() {
			return nonconforming;
		},
		get loadError() {
			return loadError;
		},
		get(id) {
			return rows.find((recording) => recording.id === id);
		},
		async create(value) {
			const created = await workspace.tables.recordings.create(value);
			void refresh();
			return created as Recording;
		},
		async update(id, partial) {
			const result = await workspace.tables.recordings.update(id, partial);
			void refresh();
			return result;
		},
		async delete(id) {
			await workspace.tables.recordings.delete(id);
			void refresh();
		},
		refresh,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};

	return {
		recordings,
		ready,
		dispose() {
			isDisposed = true;
			refreshGeneration += 1;
			unsubscribeRecords();
			listeners.clear();
		},
	};
}
