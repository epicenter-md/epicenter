import type { RowLensError } from '@epicenter/workspace/sqlite';
import { Ok } from 'wellcrafted/result';
import { onWhisperingRecordsChanged, whispering } from '#platform/whispering';
import type { Recording } from '$lib/workspace';

export type { Recording } from '$lib/workspace';

function createRecordings() {
	let rows = $state.raw<Recording[]>([]);
	let nonconforming = $state.raw<RowLensError[]>([]);
	let loadError = $state.raw<unknown>(null);
	let canonicalIdBySourceId = new Map<string, string>();
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
		const nextCanonicalIds = new Map<string, string>();
		try {
			const listed = await whispering.tables.recordings.list();
			for (const { id: canonicalId, sourceId, ...recording } of listed.rows) {
				if (nextCanonicalIds.has(sourceId)) {
					throw new Error(`Duplicate recording source id '${sourceId}'`);
				}
				nextCanonicalIds.set(sourceId, canonicalId);
				nextRows.push({ id: sourceId, ...recording });
			}
			nextNonconforming.push(...listed.nonconforming);
			if (generation !== refreshGeneration) return;
			rows = nextRows;
			nonconforming = nextNonconforming;
			canonicalIdBySourceId = nextCanonicalIds;
			loadError = null;
		} catch (cause) {
			if (generation === refreshGeneration) loadError = cause;
			throw cause;
		}
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
		get(id: string) {
			return rows.find((recording) => recording.id === id);
		},
		async set(recording: Recording): Promise<void> {
			const { id: sourceId, ...value } = recording;
			const canonicalId = canonicalIdBySourceId.get(sourceId);
			if (canonicalId) {
				const result = await whispering.tables.recordings.update(
					canonicalId,
					value,
				);
				if (result.error !== null) throw result.error;
			} else {
				await whispering.tables.recordings.create({ sourceId, ...value });
			}
			await refresh();
		},
		async update(id: string, partial: Partial<Omit<Recording, 'id'>>) {
			const canonicalId = canonicalIdBySourceId.get(id);
			if (!canonicalId) return Ok(undefined);
			const result = await whispering.tables.recordings.update(
				canonicalId,
				partial,
			);
			await refresh();
			return result;
		},
		async delete(id: string): Promise<void> {
			const canonicalId = canonicalIdBySourceId.get(id);
			if (!canonicalId) return;
			await whispering.tables.recordings.delete(canonicalId);
			await refresh();
		},
		async bulkDelete(ids: string[]): Promise<void> {
			await Promise.all(
				ids.map(async (id) => {
					const canonicalId = canonicalIdBySourceId.get(id);
					if (canonicalId)
						await whispering.tables.recordings.delete(canonicalId);
				}),
			);
			await refresh();
		},
		refresh,
	};
}

export const recordings = createRecordings();
