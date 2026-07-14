import { createHash } from 'node:crypto';
import type {
	SnapshotChunk,
	SnapshotManifest,
	SnapshotManifestBody,
	SnapshotRow,
} from './protocol';
import { stableJson } from './util';

function sha256(value: unknown): string {
	return createHash('sha256').update(stableJson(value)).digest('hex');
}

export function createSnapshotChunk(
	generation: number,
	index: number,
	rows: SnapshotRow[],
): SnapshotChunk {
	return {
		generation,
		index,
		rows,
		checksum: sha256({ generation, index, rows }),
	};
}

export function createSnapshotManifest(
	body: SnapshotManifestBody,
): SnapshotManifest {
	return { ...body, checksum: sha256(body) };
}

export function isValidSnapshotManifest(manifest: SnapshotManifest): boolean {
	const { checksum, ...body } = manifest;
	return checksum === sha256(body);
}

export function isValidSnapshotChunk(chunk: SnapshotChunk): boolean {
	return (
		chunk.checksum ===
		sha256({
			generation: chunk.generation,
			index: chunk.index,
			rows: chunk.rows,
		})
	);
}
