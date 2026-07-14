/**
 * Shared workload: Honeycrisp's real notes metadata shape (9 fields).
 * Deterministic content so every engine sees identical bytes.
 */

export type NoteRow = {
	id: string;
	folderId: string | null;
	title: string;
	preview: string;
	pinned: boolean;
	createdAt: string;
	updatedAt: string;
	deletedAt: string | null;
	wordCount: number | null;
};

export const FIELD_KEYS = [
	'folderId',
	'title',
	'preview',
	'pinned',
	'createdAt',
	'updatedAt',
	'deletedAt',
	'wordCount',
] as const;
export type FieldKey = (typeof FIELD_KEYS)[number];

const BASE_TS = 1_760_000_000_000;

export function noteId(index: number): string {
	return `note-${index.toString().padStart(6, '0')}`;
}

export function makeNote(index: number, revision: number): NoteRow {
	const ts = new Date(BASE_TS + index * 60_000 + revision).toISOString();
	return {
		id: noteId(index),
		folderId: index % 7 === 0 ? null : `folder-${index % 12}`,
		title: `Note ${index} rev ${revision} ${index % 50 === 0 ? 'needle' : 'hay'}`,
		preview: `Preview text for note ${index}: the quick brown fox jumps over the lazy dog, revision ${revision}.`,
		pinned: index % 11 === 0,
		createdAt: new Date(BASE_TS + index * 60_000).toISOString(),
		updatedAt: ts,
		deletedAt: index % 97 === 0 ? ts : null,
		wordCount: index % 13 === 0 ? null : 40 + (index % 400),
	};
}

/** Deterministic churn plan: mixed one-cell patches, deletes, reinserts. */
export type ChurnOp =
	| { kind: 'patch'; id: string; field: 'title' | 'updatedAt'; value: string }
	| { kind: 'delete'; id: string }
	| { kind: 'reinsert'; index: number; revision: number };

export function churnPlan(rowCount: number, opCount: number): ChurnOp[] {
	const ops: ChurnOp[] = [];
	for (let i = 0; i < opCount; i++) {
		const index = (i * 7919) % rowCount;
		const mode = i % 20;
		if (mode === 0) ops.push({ kind: 'delete', id: noteId(index) });
		else if (mode === 1) ops.push({ kind: 'reinsert', index, revision: i });
		else if (mode % 2 === 0)
			ops.push({
				kind: 'patch',
				id: noteId(index),
				field: 'title',
				value: `Note ${index} churned ${i}`,
			});
		else
			ops.push({
				kind: 'patch',
				id: noteId(index),
				field: 'updatedAt',
				value: new Date(BASE_TS + i).toISOString(),
			});
	}
	return ops;
}

/**
 * Remote batch: what "another client" sends — cell-level edits to M rows,
 * disjoint fields from local churn where possible (preview edits).
 */
export type RemoteCellEdit = {
	id: string;
	field: FieldKey;
	value: string | number | boolean | null;
};

export function remotePlan(
	rowCount: number,
	editCount: number,
): RemoteCellEdit[] {
	const edits: RemoteCellEdit[] = [];
	for (let i = 0; i < editCount; i++) {
		const index = (i * 104729) % rowCount;
		edits.push({
			id: noteId(index),
			field: 'preview',
			value: `Remote preview edit ${i} for note ${index}.`,
		});
	}
	return edits;
}

/** Result contract every bench page fulfills on `window.bench`. */
export type BenchApi = {
	engine: string;
	/** Wipe this engine's persistence. */
	reset(): Promise<void>;
	/** Insert n rows and wait until durably persisted. */
	seed(n: number): Promise<{ insertMs: number; persistMs: number }>;
	/** On a fresh page load: hydrate from persistence until first query works. */
	hydrate(): Promise<{ hydrateMs: number; rowCount: number }>;
	/** First 100 live rows ordered by updatedAt desc. */
	query100(): Promise<{ ms: number; count: number }>;
	/** Substring search over title+preview. */
	search(needle: string): Promise<{ ms: number; count: number }>;
	/** One-cell edit: patch title of one row, time until engine notifies readers. */
	editOne(index: number): Promise<{ ms: number }>;
	/** Apply the deterministic churn plan. */
	churn(opCount: number): Promise<{ ms: number }>;
	/** Apply a remote batch through the engine's sync-apply path. */
	remoteApply(editCount: number): Promise<{ ms: number }>;
	/** Persistence footprint in bytes (best effort). */
	persistSize(): Promise<{ bytes: number; detail: string }>;
	/** Memory in bytes (UA-specific measurement incl. workers when available). */
	memory(): Promise<{ bytes: number; source: string }>;
};

declare global {
	interface Window {
		bench: BenchApi;
		benchReady: Promise<void>;
	}
}

export async function measureMemory(): Promise<{
	bytes: number;
	source: string;
}> {
	const perf = performance as unknown as {
		measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }>;
		memory?: { usedJSHeapSize: number };
	};
	if (crossOriginIsolated && perf.measureUserAgentSpecificMemory) {
		try {
			const result = await perf.measureUserAgentSpecificMemory();
			return { bytes: result.bytes, source: 'measureUserAgentSpecificMemory' };
		} catch {
			// Unavailable in some headless configurations; fall through.
		}
	}
	if (perf.memory) {
		return { bytes: perf.memory.usedJSHeapSize, source: 'performance.memory' };
	}
	return { bytes: -1, source: 'unavailable' };
}

export async function storageEstimate(): Promise<{
	bytes: number;
	detail: string;
}> {
	const estimate = await navigator.storage.estimate();
	const details = (estimate as { usageDetails?: Record<string, number> })
		.usageDetails;
	return {
		bytes: estimate.usage ?? -1,
		detail: details ? JSON.stringify(details) : 'no usageDetails',
	};
}

export function now(): number {
	return performance.now();
}
