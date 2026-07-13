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
