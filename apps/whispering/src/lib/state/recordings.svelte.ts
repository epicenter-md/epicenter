import type { RowLensError } from '@epicenter/workspace/sqlite';
import { onWhisperingRecordsChanged, whispering } from '#platform/whispering';
import type { Recording } from '$lib/workspace';

export type { Recording } from '$lib/workspace';

function createRecordings() {
	let rows = $state.raw<Recording[]>([]);
	let nonconforming = $state.raw<RowLensError[]>([]);
	let loadError = $state.raw<unknown>(null);
	let refreshGeneration = 0;
	const sorted = $derived(
		rows.toSorted(
			(left, right) =>
				new Date(right.recordedAt).getTime() -
				new Date(left.recordedAt).getTime(),
		),
	);

	async function refresh(): Promise<void> {
		const generation = ++refreshGeneration;
		const nextRows: Recording[] = [];
		const nextNonconforming: RowLensError[] = [];
		try {
			const listed = await whispering.tables.recordings.list();
			for (const recording of listed.rows) {
				nextRows.push(recording as Recording);
			}
			nextNonconforming.push(...listed.nonconforming);
			if (generation !== refreshGeneration) return;
			rows = nextRows;
			nonconforming = nextNonconforming;
			loadError = null;
		} catch (cause) {
			if (generation === refreshGeneration) loadError = cause;
			throw cause;
		}
	}

	function refreshProjection(): void {
		// A durable mutation and a projection refresh are different commits. Once
		// SQLite accepts the write, callers must never mistake a later read failure
		// for a failed mutation and run destructive compensation against live data.
		void refresh().catch(() => undefined);
	}

	const whenReady = refresh();
	// Surfaces that gate on whenReady observe its rejection; when nothing
	// does (a boot that fails before this page is visited), the failure is
	// already on the WorkspaceGate and must not double as an
	// unhandled-rejection event.
	void whenReady.catch(() => undefined);
	const unsubscribe = onWhisperingRecordsChanged(
		() => void refresh().catch(() => undefined),
	);
	// This module is a singleton; without this, each hot reload leaves the old
	// instance's listener registered beside the new one.
	if (import.meta.hot) import.meta.hot.dispose(unsubscribe);

	return {
		whenReady,
		get sorted(): Recording[] {
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
		get(id: Recording['id']) {
			return rows.find((recording) => recording.id === id);
		},
		async create(value: Omit<Recording, 'id'>): Promise<Recording> {
			const created = await whispering.tables.recordings.create(value);
			refreshProjection();
			return created as Recording;
		},
		async update(
			id: Recording['id'],
			partial: Partial<Omit<Recording, 'id' | 'audioBlobId'>>,
		) {
			const result = await whispering.tables.recordings.update(id, partial);
			refreshProjection();
			return result;
		},
		async delete(id: Recording['id']): Promise<void> {
			await whispering.tables.recordings.delete(id);
			refreshProjection();
		},
		refresh,
	};
}

export const recordings = createRecordings();
