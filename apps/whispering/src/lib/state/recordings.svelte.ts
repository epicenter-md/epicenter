import type { RecordLensError } from '@epicenter/workspace/sqlite';
import { Ok } from 'wellcrafted/result';
import { onWhisperingRecordsChanged, whispering } from '#platform/whispering';
import type { Recording } from '$lib/workspace';

export type { Recording } from '$lib/workspace';

const PAGE_SIZE = 500;

function createRecordings() {
	let rows = $state.raw<Recording[]>([]);
	let nonconforming = $state.raw<RecordLensError[]>([]);
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
		const nextNonconforming: RecordLensError[] = [];
		const nextCanonicalIds = new Map<string, string>();
		let cursor: string | undefined;
		try {
			do {
				const page = await whispering.tables.recordings.scan({
					...(cursor && { cursor }),
					limit: PAGE_SIZE,
				});
				for (const { id: canonicalId, sourceId, ...recording } of page.rows) {
					if (nextCanonicalIds.has(sourceId)) {
						throw new Error(`Duplicate recording source id '${sourceId}'`);
					}
					nextCanonicalIds.set(sourceId, canonicalId);
					nextRows.push({ id: sourceId, ...recording });
				}
				nextNonconforming.push(...page.nonconforming);
				cursor = page.nextCursor;
			} while (cursor !== undefined);
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
	onWhisperingRecordsChanged(() => void refresh().catch(() => undefined));

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
				const result = await whispering.tables.recordings.patch(
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
			const result = await whispering.tables.recordings.patch(
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
