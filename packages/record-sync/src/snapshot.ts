import { encodedJsonBytes } from './admission.js';
import { canonicalJson } from './canonical-json.js';
import type {
	SnapshotChunk,
	SnapshotManifest,
	SnapshotManifestBody,
	SnapshotRow,
} from './protocol.js';

export type Sha256 = (value: string) => Promise<string>;

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
		checksum: await sha256(canonicalJson({ generation, index, rows })),
	};
}

/** Encode ordered current rows into byte-bounded snapshot chunks. */
export async function createSnapshotChunks(
	sha256: Sha256,
	{
		generation,
		rows: sourceRows,
		maxChunkBytes,
	}: {
		generation: number;
		rows: readonly SnapshotRow[];
		maxChunkBytes: number;
	},
): Promise<SnapshotChunk[]> {
	const pages: SnapshotRow[][] = [];
	let rows: SnapshotRow[] = [];
	for (const row of sourceRows) {
		const candidate = [...rows, row];
		const index = pages.length;
		if (
			encodedJsonBytes({
				generation,
				index,
				rows: candidate,
				checksum: '0'.repeat(64),
			}) <= maxChunkBytes
		) {
			rows = candidate;
			continue;
		}
		if (rows.length === 0) {
			throw new Error('Snapshot row exceeds maxChunkBytes');
		}
		pages.push(rows);
		rows = [row];
		if (
			encodedJsonBytes({
				generation,
				index: pages.length,
				rows,
				checksum: '0'.repeat(64),
			}) > maxChunkBytes
		) {
			throw new Error('Snapshot row exceeds maxChunkBytes');
		}
	}
	if (rows.length > 0 || pages.length === 0) pages.push(rows);
	const chunks = await Promise.all(
		pages.map((page, index) =>
			createSnapshotChunk(sha256, generation, index, page),
		),
	);
	if (chunks.some((chunk) => encodedJsonBytes(chunk) > maxChunkBytes)) {
		throw new Error('Snapshot checksum encoding exceeds maxChunkBytes');
	}
	return chunks;
}

export async function createSnapshotManifest(
	sha256: Sha256,
	body: SnapshotManifestBody,
): Promise<SnapshotManifest> {
	return { ...body, checksum: await sha256(canonicalJson(body)) };
}

export async function isValidSnapshotChunk(
	sha256: Sha256,
	chunk: SnapshotChunk,
): Promise<boolean> {
	return (
		chunk.checksum ===
		(await sha256(
			canonicalJson({
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
	return checksum === (await sha256(canonicalJson(body)));
}
