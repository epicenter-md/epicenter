import type {
	SnapshotChunk,
	SnapshotManifest,
	SnapshotManifestBody,
	SnapshotRow,
} from './protocol.js';

export type Sha256 = (value: string) => Promise<string>;

function stableJson(value: unknown): string {
	return JSON.stringify(sort(value));
}

function sort(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sort);
	if (value !== null && typeof value === 'object')
		return Object.fromEntries(
			Object.entries(value)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, child]) => [key, sort(child)]),
		);
	return value;
}

export async function createSnapshotChunk(
	sha256: Sha256,
	generation: number,
	index: number,
	rows: SnapshotRow[],
): Promise<SnapshotChunk> {
	return {
		generation,
		index,
		rows,
		checksum: await sha256(stableJson({ generation, index, rows })),
	};
}

export async function createSnapshotManifest(
	sha256: Sha256,
	body: SnapshotManifestBody,
): Promise<SnapshotManifest> {
	return { ...body, checksum: await sha256(stableJson(body)) };
}

export async function isValidSnapshotChunk(
	sha256: Sha256,
	chunk: SnapshotChunk,
): Promise<boolean> {
	return (
		chunk.checksum ===
		(await sha256(
			stableJson({
				generation: chunk.generation,
				index: chunk.index,
				rows: chunk.rows,
			}),
		))
	);
}

export async function isValidSnapshotManifest(
	sha256: Sha256,
	manifest: SnapshotManifest,
): Promise<boolean> {
	const { checksum, ...body } = manifest;
	return checksum === (await sha256(stableJson(body)));
}
