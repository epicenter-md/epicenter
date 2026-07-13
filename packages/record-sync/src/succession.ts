import { type Static, Type } from 'typebox';
import { Value } from 'typebox/value';
import {
	isAdmissibleSnapshotRow,
	isBoundedIdentifier,
	isBoundedRecordsSchemaHash,
	RECORD_SYNC_ADMISSION_LIMITS,
} from './admission.js';
import { canonicalJson } from './canonical-json.js';
import type { SnapshotChunk, SnapshotRow } from './protocol.js';
import {
	createSnapshotManifest,
	isValidSnapshotChunk,
	type Sha256,
} from './snapshot.js';
import type { RecordSyncSqlite } from './sqlite.js';

export const RECORD_SUCCESSION_LIMITS = {
	chunks: 2_048,
	rows: 1_000_000,
	encodedBytes: 1024 * 1024 * 1024,
} as const;

const candidateChunkIdentitySchema = Type.Object(
	{
		index: Type.Integer({ minimum: 0 }),
		checksum: Type.String({ minLength: 1 }),
		rowCount: Type.Integer({ minimum: 0 }),
		encodedBytes: Type.Integer({ minimum: 1 }),
	},
	{ additionalProperties: false },
);
export type CandidateChunkIdentity = Static<
	typeof candidateChunkIdentitySchema
>;

export type CandidateManifestBody = {
	format: 1;
	sourceDatabaseId: string;
	sourceHead: number;
	targetRecordsSchemaHash: string;
	chunks: CandidateChunkIdentity[];
	rowCount: number;
	encodedBytes: number;
};

export const CandidateManifestSchema = Type.Object(
	{
		format: Type.Literal(1),
		sourceDatabaseId: Type.String({ minLength: 1 }),
		sourceHead: Type.Integer({ minimum: 0 }),
		targetRecordsSchemaHash: Type.String({ minLength: 1 }),
		chunks: Type.Array(candidateChunkIdentitySchema, { minItems: 1 }),
		rowCount: Type.Integer({ minimum: 0 }),
		encodedBytes: Type.Integer({ minimum: 1 }),
		candidateId: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);
export type CandidateManifest = Static<typeof CandidateManifestSchema>;

export function parseCandidateManifest(value: unknown): CandidateManifest {
	if (!Value.Check(CandidateManifestSchema, value))
		throw new TypeError('Invalid records succession candidate manifest');
	return value;
}

export type StageCandidateResult =
	| { ok: true; candidateId: string; replaced: boolean }
	| {
			ok: false;
			reason:
				| 'invalid-manifest'
				| 'wrong-source'
				| 'candidate-too-large'
				| 'candidate-already-exists';
	  };

export type UploadCandidateChunkResult =
	| { ok: true }
	| {
			ok: false;
			reason: 'candidate-not-staged' | 'chunk-out-of-range' | 'invalid-chunk';
	  };

export type SealCandidateResult =
	| { ok: true }
	| {
			ok: false;
			reason: 'candidate-not-staged' | 'missing-chunks' | 'rows-not-canonical';
	  };

export type ActivateCandidateResult =
	| { ok: true; status: 'activated' | 'already-active' }
	| {
			ok: false;
			reason: 'candidate-not-staged' | 'candidate-not-sealed' | 'stale-head';
	  };

export type DiscardCandidateResult =
	| { ok: true }
	| { ok: false; reason: 'candidate-not-staged' };

type StoredCandidate = {
	manifest_json: string;
	sealed: number;
	snapshot_manifest_json: string | null;
};

export async function createCandidateManifest({
	sha256,
	sourceDatabaseId,
	sourceHead,
	targetRecordsSchemaHash,
	chunks,
}: {
	sha256: Sha256;
	sourceDatabaseId: string;
	sourceHead: number;
	targetRecordsSchemaHash: string;
	chunks: readonly SnapshotChunk[];
}): Promise<CandidateManifest> {
	const identities = chunks.map((chunk) => ({
		index: chunk.index,
		checksum: chunk.checksum,
		rowCount: chunk.rows.length,
		encodedBytes: encodedBytes(chunk),
	}));
	const body: CandidateManifestBody = {
		format: 1,
		sourceDatabaseId,
		sourceHead,
		targetRecordsSchemaHash,
		chunks: identities,
		rowCount: identities.reduce((sum, chunk) => sum + chunk.rowCount, 0),
		encodedBytes: identities.reduce(
			(sum, chunk) => sum + chunk.encodedBytes,
			0,
		),
	};
	return { ...body, candidateId: await sha256(canonicalJson(body)) };
}

/** Create the internal one-slot records-database succession authority. */
export function createRecordSuccession({
	database,
	sha256,
}: {
	database: RecordSyncSqlite;
	sha256: Sha256;
}) {
	function readFamily() {
		return database.all<{
			current_database_id: string;
			staged_candidate_id: string | null;
		}>(
			`SELECT current_database_id, staged_candidate_id
			 FROM record_sync_family WHERE id = 1`,
		)[0];
	}

	function readCandidate(candidateId: string): StoredCandidate | undefined {
		return database.all<StoredCandidate>(
			`SELECT manifest_json, sealed, snapshot_manifest_json
			 FROM record_sync_candidate_manifests WHERE candidate_id = ?`,
			[candidateId],
		)[0];
	}

	function readChunk(
		candidateId: string,
		index: number,
	): SnapshotChunk | undefined {
		const stored = database.all<{ chunk_json: string }>(
			`SELECT chunk_json FROM record_sync_candidate_chunks
			 WHERE candidate_id = ? AND chunk_index = ?`,
			[candidateId, index],
		)[0];
		return stored ? JSON.parse(stored.chunk_json) : undefined;
	}

	function removeCandidate(candidateId: string): void {
		database.run(
			'DELETE FROM record_sync_candidate_chunks WHERE candidate_id = ?',
			[candidateId],
		);
		database.run(
			'DELETE FROM record_sync_candidate_manifests WHERE candidate_id = ?',
			[candidateId],
		);
		database.run(
			`UPDATE record_sync_family SET staged_candidate_id = NULL
			 WHERE staged_candidate_id = ?`,
			[candidateId],
		);
	}

	return {
		async stage(manifest: CandidateManifest): Promise<StageCandidateResult> {
			if (!(await isValidCandidateManifest(sha256, manifest)))
				return { ok: false, reason: 'invalid-manifest' };
			if (exceedsLimits(manifest))
				return { ok: false, reason: 'candidate-too-large' };
			return database.transaction(() => {
				const family = readFamily();
				if (!family) throw new Error('record-sync family is not initialized');
				const existingDatabase = database.all<{ present: number }>(
					`SELECT 1 AS present FROM record_sync_databases
					 WHERE database_id = ?`,
					[manifest.candidateId],
				)[0];
				if (existingDatabase)
					return { ok: false, reason: 'candidate-already-exists' };
				if (manifest.sourceDatabaseId !== family.current_database_id)
					return { ok: false, reason: 'wrong-source' };
				if (family.staged_candidate_id === manifest.candidateId)
					return {
						ok: true,
						candidateId: manifest.candidateId,
						replaced: false,
					};
				const replaced = family.staged_candidate_id !== null;
				if (family.staged_candidate_id)
					removeCandidate(family.staged_candidate_id);
				database.run(
					`INSERT INTO record_sync_candidate_manifests(
						candidate_id, manifest_json, sealed, snapshot_manifest_json
					) VALUES (?, ?, 0, NULL)`,
					[manifest.candidateId, JSON.stringify(manifest)],
				);
				database.run(
					'UPDATE record_sync_family SET staged_candidate_id = ? WHERE id = 1',
					[manifest.candidateId],
				);
				return { ok: true, candidateId: manifest.candidateId, replaced };
			});
		},

		async upload(
			candidateId: string,
			chunk: SnapshotChunk,
		): Promise<UploadCandidateChunkResult> {
			const family = database.transaction(readFamily);
			if (family?.staged_candidate_id !== candidateId)
				return { ok: false, reason: 'candidate-not-staged' };
			const stored = readCandidate(candidateId);
			if (!stored) throw new Error('staged candidate state is incomplete');
			const manifest: CandidateManifest = JSON.parse(stored.manifest_json);
			const expected = manifest.chunks[chunk.index];
			if (!expected) return { ok: false, reason: 'chunk-out-of-range' };
			if (
				chunk.generation !== 1 ||
				chunk.checksum !== expected.checksum ||
				chunk.rows.length !== expected.rowCount ||
				encodedBytes(chunk) !== expected.encodedBytes ||
				chunk.rows.some((row) => !isAdmissibleSnapshotRow(row)) ||
				encodedBytes(chunk) >
					RECORD_SYNC_ADMISSION_LIMITS.encodedSnapshotChunkBytes ||
				!(await isValidSnapshotChunk(sha256, chunk))
			)
				return { ok: false, reason: 'invalid-chunk' };
			return database.transaction(() => {
				if (readFamily()?.staged_candidate_id !== candidateId)
					return { ok: false, reason: 'candidate-not-staged' };
				database.run(
					`INSERT OR IGNORE INTO record_sync_candidate_chunks(
						candidate_id, chunk_index, chunk_json
					) VALUES (?, ?, ?)`,
					[candidateId, chunk.index, JSON.stringify(chunk)],
				);
				return { ok: true };
			});
		},

		async seal(candidateId: string): Promise<SealCandidateResult> {
			const captured = database.transaction(() => {
				if (readFamily()?.staged_candidate_id !== candidateId) return null;
				const stored = readCandidate(candidateId);
				if (!stored) throw new Error('staged candidate state is incomplete');
				if (stored.sealed === 1) return { sealed: true as const };
				const manifest: CandidateManifest = JSON.parse(stored.manifest_json);
				let previous: SnapshotRow | undefined;
				for (let index = 0; index < manifest.chunks.length; index += 1) {
					const chunk = readChunk(candidateId, index);
					if (!chunk) return { missing: true as const };
					const first = chunk.rows[0];
					if (
						!rowsAreCanonical(chunk.rows) ||
						(previous && first && compareIdentity(previous, first) >= 0)
					)
						return { canonical: false as const };
					previous = chunk.rows.at(-1) ?? previous;
				}
				return { sealed: false as const, manifest };
			});
			if (!captured) return { ok: false, reason: 'candidate-not-staged' };
			if ('sealed' in captured && captured.sealed) return { ok: true };
			if ('missing' in captured) return { ok: false, reason: 'missing-chunks' };
			if ('canonical' in captured)
				return { ok: false, reason: 'rows-not-canonical' };
			const snapshot = await createSnapshotManifest(sha256, {
				generation: 1,
				snapshotSequence: 1,
				chunkChecksums: captured.manifest.chunks.map((chunk) => chunk.checksum),
				actorHighWater: {},
			});
			return database.transaction(() => {
				if (readFamily()?.staged_candidate_id !== candidateId)
					return { ok: false, reason: 'candidate-not-staged' };
				const current = readCandidate(candidateId);
				if (!current) throw new Error('staged candidate state is incomplete');
				if (current.sealed === 1) return { ok: true };
				database.run(
					`UPDATE record_sync_candidate_manifests
					 SET sealed = 1, snapshot_manifest_json = ?
					 WHERE candidate_id = ?`,
					[JSON.stringify(snapshot), candidateId],
				);
				return { ok: true };
			});
		},

		activate(candidateId: string): ActivateCandidateResult {
			return database.transaction(() => {
				const family = readFamily();
				if (!family) throw new Error('record-sync family is not initialized');
				if (family.current_database_id === candidateId)
					return { ok: true, status: 'already-active' };
				if (family.staged_candidate_id !== candidateId)
					return { ok: false, reason: 'candidate-not-staged' };
				const stored = readCandidate(candidateId);
				if (!stored) throw new Error('staged candidate state is incomplete');
				if (stored.sealed !== 1 || stored.snapshot_manifest_json === null)
					return { ok: false, reason: 'candidate-not-sealed' };
				const manifest: CandidateManifest = JSON.parse(stored.manifest_json);
				const source = database.all<{ server_sequence: number }>(
					`SELECT server_sequence FROM record_sync_databases
					 WHERE database_id = ?`,
					[manifest.sourceDatabaseId],
				)[0];
				if (
					family.current_database_id !== manifest.sourceDatabaseId ||
					!source ||
					source.server_sequence !== manifest.sourceHead
				)
					return { ok: false, reason: 'stale-head' };
				database.run(
					`INSERT INTO record_sync_databases(
						database_id, storage_version, protocol_major, records_schema_hash,
						status, server_sequence, watermark, snapshot_generation
					) SELECT ?, storage_version, protocol_major, ?, 'live', 1, 1, 1
					  FROM record_sync_databases WHERE database_id = ?`,
					[
						candidateId,
						manifest.targetRecordsSchemaHash,
						manifest.sourceDatabaseId,
					],
				);
				for (let index = 0; index < manifest.chunks.length; index += 1) {
					const chunk = readChunk(candidateId, index);
					if (!chunk) throw new Error('sealed candidate chunk is missing');
					for (const row of chunk.rows)
						database.run(
							`INSERT INTO record_sync_canonical_rows(
								database_id, table_name, row_id, cells_json
							) VALUES (?, ?, ?, ?)`,
							[candidateId, row.table, row.rowId, JSON.stringify(row.cells)],
						);
				}
				database.run(
					`INSERT INTO record_sync_snapshot_manifest(database_id, manifest_json)
					 VALUES (?, ?)`,
					[candidateId, stored.snapshot_manifest_json],
				);
				for (let index = 0; index < manifest.chunks.length; index += 1) {
					const chunk = readChunk(candidateId, index);
					if (!chunk) throw new Error('sealed candidate chunk is missing');
					database.run(
						`INSERT INTO record_sync_snapshot_chunks(
							database_id, chunk_index, generation, rows_json, checksum
						) VALUES (?, ?, ?, ?, ?)`,
						[
							candidateId,
							chunk.index,
							chunk.generation,
							JSON.stringify(chunk.rows),
							chunk.checksum,
						],
					);
				}
				database.run(
					"UPDATE record_sync_databases SET status = 'fenced' WHERE database_id = ?",
					[manifest.sourceDatabaseId],
				);
				database.run(
					`UPDATE record_sync_family
					 SET current_database_id = ?, staged_candidate_id = NULL WHERE id = 1`,
					[candidateId],
				);
				database.run(
					'DELETE FROM record_sync_candidate_chunks WHERE candidate_id = ?',
					[candidateId],
				);
				database.run(
					'DELETE FROM record_sync_candidate_manifests WHERE candidate_id = ?',
					[candidateId],
				);
				return { ok: true, status: 'activated' };
			});
		},

		discard(candidateId: string): DiscardCandidateResult {
			return database.transaction(() => {
				if (readFamily()?.staged_candidate_id !== candidateId)
					return { ok: false, reason: 'candidate-not-staged' };
				removeCandidate(candidateId);
				return { ok: true };
			});
		},
	};
}

async function isValidCandidateManifest(
	sha256: Sha256,
	manifest: CandidateManifest,
): Promise<boolean> {
	const body: CandidateManifestBody = {
		format: manifest.format,
		sourceDatabaseId: manifest.sourceDatabaseId,
		sourceHead: manifest.sourceHead,
		targetRecordsSchemaHash: manifest.targetRecordsSchemaHash,
		chunks: manifest.chunks,
		rowCount: manifest.rowCount,
		encodedBytes: manifest.encodedBytes,
	};
	if (
		body.format !== 1 ||
		!isBoundedIdentifier(body.sourceDatabaseId) ||
		!isBoundedRecordsSchemaHash(body.targetRecordsSchemaHash) ||
		!isBoundedIdentifier(manifest.candidateId) ||
		!Number.isSafeInteger(body.sourceHead) ||
		body.sourceHead < 0 ||
		body.chunks.length === 0 ||
		manifest.candidateId !== (await sha256(canonicalJson(body)))
	)
		return false;
	for (const [index, chunk] of body.chunks.entries())
		if (
			chunk.index !== index ||
			chunk.checksum.length === 0 ||
			!Number.isSafeInteger(chunk.rowCount) ||
			chunk.rowCount < 0 ||
			!Number.isSafeInteger(chunk.encodedBytes) ||
			chunk.encodedBytes < 1
		)
			return false;
	return (
		body.rowCount ===
			body.chunks.reduce((sum, chunk) => sum + chunk.rowCount, 0) &&
		body.encodedBytes ===
			body.chunks.reduce((sum, chunk) => sum + chunk.encodedBytes, 0)
	);
}

function exceedsLimits(manifest: CandidateManifest): boolean {
	return (
		manifest.chunks.length > RECORD_SUCCESSION_LIMITS.chunks ||
		manifest.rowCount > RECORD_SUCCESSION_LIMITS.rows ||
		manifest.encodedBytes > RECORD_SUCCESSION_LIMITS.encodedBytes
	);
}

function rowsAreCanonical(rows: readonly SnapshotRow[]): boolean {
	for (let index = 1; index < rows.length; index += 1) {
		const previous = rows[index - 1];
		const current = rows[index];
		if (!previous || !current || compareIdentity(previous, current) >= 0)
			return false;
	}
	return true;
}

function compareIdentity(left: SnapshotRow, right: SnapshotRow): number {
	return (
		compareUtf8(left.table, right.table) || compareUtf8(left.rowId, right.rowId)
	);
}

function compareUtf8(left: string, right: string): number {
	const leftBytes = new TextEncoder().encode(left);
	const rightBytes = new TextEncoder().encode(right);
	for (
		let index = 0;
		index < Math.min(leftBytes.length, rightBytes.length);
		index += 1
	) {
		const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return leftBytes.length - rightBytes.length;
}

function encodedBytes(value: unknown): number {
	return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
