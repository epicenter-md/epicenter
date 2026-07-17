import { encodedJsonBytes } from './admission.js';
import { canonicalJson } from './canonical-json.js';
import type {
	SnapshotBodyUpdate,
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
	bodies: SnapshotBodyUpdate[],
): Promise<SnapshotChunk> {
	return {
		generation,
		index,
		rows,
		bodies,
		checksum: await sha256(canonicalJson({ generation, index, rows, bodies })),
	};
}

type StagedChunk = { rows: SnapshotRow[]; bodies: SnapshotBodyUpdate[] };

/** Encode ordered current rows and body baselines into byte-bounded chunks. */
export async function createSnapshotChunks(
	sha256: Sha256,
	{
		generation,
		rows: sourceRows,
		bodies: sourceBodies = [],
		maxChunkBytes,
	}: {
		generation: number;
		rows: readonly SnapshotRow[];
		bodies?: readonly SnapshotBodyUpdate[];
		maxChunkBytes: number;
	},
): Promise<SnapshotChunk[]> {
	const items: (
		| { kind: 'row'; row: SnapshotRow }
		| { kind: 'body'; body: SnapshotBodyUpdate }
	)[] = [
		...sourceRows.map((row) => ({ kind: 'row' as const, row })),
		...sourceBodies.map((body) => ({ kind: 'body' as const, body })),
	];
	const pages: StagedChunk[] = [];
	let staged: StagedChunk = { rows: [], bodies: [] };

	const encodedBytes = (chunk: StagedChunk, index: number) =>
		encodedJsonBytes({
			generation,
			index,
			rows: chunk.rows,
			bodies: chunk.bodies,
			checksum: '0'.repeat(64),
		});

	for (const item of items) {
		const candidate: StagedChunk =
			item.kind === 'row'
				? { rows: [...staged.rows, item.row], bodies: staged.bodies }
				: { rows: staged.rows, bodies: [...staged.bodies, item.body] };
		if (encodedBytes(candidate, pages.length) <= maxChunkBytes) {
			staged = candidate;
			continue;
		}
		if (staged.rows.length === 0 && staged.bodies.length === 0) {
			throw new Error('Snapshot entry exceeds maxChunkBytes');
		}
		pages.push(staged);
		staged =
			item.kind === 'row'
				? { rows: [item.row], bodies: [] }
				: { rows: [], bodies: [item.body] };
		if (encodedBytes(staged, pages.length) > maxChunkBytes) {
			throw new Error('Snapshot entry exceeds maxChunkBytes');
		}
	}
	if (staged.rows.length > 0 || staged.bodies.length > 0 || pages.length === 0) {
		pages.push(staged);
	}
	const chunks = await Promise.all(
		pages.map((page, index) =>
			createSnapshotChunk(sha256, generation, index, page.rows, page.bodies),
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
				bodies: chunk.bodies,
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
