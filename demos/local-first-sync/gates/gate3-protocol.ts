import { createHash } from 'node:crypto';

import type { Operation, SnapshotRow } from './protocol.js';
import { stableJson } from './util.js';

export const GATE3_LIMITS = {
	chunksPerCandidate: 8,
	rowsPerCandidate: 100,
	encodedCandidateBytes: 128 * 1024,
} as const;

export type DatabaseStatus = 'live' | 'fenced';

export type CandidateChunk = {
	index: number;
	rows: SnapshotRow[];
	checksum: string;
	rowCount: number;
	encodedBytes: number;
};

export type CandidateChunkIdentity = {
	index: number;
	checksum: string;
	rowCount: number;
	encodedBytes: number;
};

export type CandidateManifestBody = {
	format: 1;
	sourceDatabaseId: string;
	sourceHead: number;
	targetSchemaHash: string;
	chunks: CandidateChunkIdentity[];
	rowCount: number;
	encodedBytes: number;
};

export type CandidateManifest = CandidateManifestBody & {
	candidateId: string;
};

export type SourceSnapshot = {
	databaseId: string;
	schemaHash: string;
	head: number;
	rows: SnapshotRow[];
};

export type StageResult =
	| { ok: true; candidateId: string; replaced: boolean }
	| {
			ok: false;
			reason:
				| 'invalid-manifest'
				| 'wrong-source'
				| 'candidate-too-large'
				| 'candidate-already-exists';
	  };

export type UploadResult =
	| { ok: true }
	| {
			ok: false;
			reason: 'candidate-not-staged' | 'chunk-out-of-range' | 'invalid-chunk';
	  };

export type SealResult =
	| { ok: true }
	| {
			ok: false;
			reason: 'candidate-not-staged' | 'missing-chunks' | 'rows-not-canonical';
	  };

export type ActivateResult =
	| { ok: true; status: 'activated' | 'already-active' }
	| {
			ok: false;
			reason: 'candidate-not-staged' | 'candidate-not-sealed' | 'stale-head';
	  };

export type DiscardResult =
	| { ok: true }
	| { ok: false; reason: 'candidate-not-staged' };

export type WriteResult =
	| { ok: true; head: number }
	| {
			ok: false;
			reason: 'database-fenced' | 'database-not-live' | 'create-conflict';
	  };

export type ReadDatabaseResult =
	| { ok: true; snapshot: SourceSnapshot }
	| { ok: false; reason: 'database-not-readable' };

export type Gate3Dump = {
	currentDatabaseId: string;
	stagedUpload: {
		manifest: CandidateManifest;
		sealed: boolean;
		chunks: CandidateChunk[];
	} | null;
	databases: {
		id: string;
		schemaHash: string;
		status: DatabaseStatus;
		head: number;
		rows: SnapshotRow[];
	}[];
	checkpoints: { databaseId: string; chunks: CandidateChunk[] }[];
};

export type Gate3Authority = {
	sourceSnapshot(): SourceSnapshot;
	stage(manifest: CandidateManifest): StageResult;
	upload(candidateId: string, chunk: CandidateChunk): UploadResult;
	seal(candidateId: string): SealResult;
	activate(candidateId: string): ActivateResult;
	discard(candidateId: string): DiscardResult;
	write(databaseId: string, operation: Operation): WriteResult;
	readDatabase(databaseId: string): ReadDatabaseResult;
	checkpointChunks(databaseId: string): CandidateChunk[] | null;
	dump(): Gate3Dump;
};

export function createCandidateChunk(
	index: number,
	rows: SnapshotRow[],
): CandidateChunk {
	const ownedRows = structuredClone(rows);
	const body = { index, rows: ownedRows };
	return {
		...body,
		checksum: sha256(body),
		rowCount: ownedRows.length,
		encodedBytes: encodedBytes(body),
	};
}

export function createCandidateManifest({
	sourceDatabaseId,
	sourceHead,
	targetSchemaHash,
	chunks,
}: {
	sourceDatabaseId: string;
	sourceHead: number;
	targetSchemaHash: string;
	chunks: CandidateChunk[];
}): CandidateManifest {
	const identities = chunks
		.map(({ index, checksum, rowCount, encodedBytes }) => ({
			index,
			checksum,
			rowCount,
			encodedBytes,
		}))
		.sort((left, right) => left.index - right.index);
	const body: CandidateManifestBody = {
		format: 1,
		sourceDatabaseId,
		sourceHead,
		targetSchemaHash,
		chunks: identities,
		rowCount: identities.reduce((sum, chunk) => sum + chunk.rowCount, 0),
		encodedBytes: identities.reduce(
			(sum, chunk) => sum + chunk.encodedBytes,
			0,
		),
	};
	return { ...body, candidateId: sha256(body) };
}

export function isValidCandidateManifest(manifest: CandidateManifest): boolean {
	const { candidateId, ...body } = manifest;
	if (
		body.format !== 1 ||
		candidateId !== sha256(body) ||
		body.sourceDatabaseId.length === 0 ||
		body.targetSchemaHash.length === 0 ||
		!Number.isSafeInteger(body.sourceHead) ||
		body.sourceHead < 0 ||
		body.chunks.length === 0
	)
		return false;
	for (const [index, chunk] of body.chunks.entries()) {
		if (
			chunk.index !== index ||
			chunk.checksum.length === 0 ||
			!Number.isSafeInteger(chunk.rowCount) ||
			chunk.rowCount < 0 ||
			!Number.isSafeInteger(chunk.encodedBytes) ||
			chunk.encodedBytes < 1
		)
			return false;
	}
	return (
		body.rowCount ===
			body.chunks.reduce((sum, chunk) => sum + chunk.rowCount, 0) &&
		body.encodedBytes ===
			body.chunks.reduce((sum, chunk) => sum + chunk.encodedBytes, 0)
	);
}

export function exceedsCandidateLimits(manifest: CandidateManifest): boolean {
	return (
		manifest.chunks.length > GATE3_LIMITS.chunksPerCandidate ||
		manifest.rowCount > GATE3_LIMITS.rowsPerCandidate ||
		manifest.encodedBytes > GATE3_LIMITS.encodedCandidateBytes
	);
}

export function isValidCandidateChunk(
	expected: CandidateChunkIdentity,
	chunk: CandidateChunk,
): boolean {
	const body = { index: chunk.index, rows: chunk.rows };
	return (
		chunk.index === expected.index &&
		chunk.checksum === expected.checksum &&
		chunk.checksum === sha256(body) &&
		chunk.rowCount === expected.rowCount &&
		chunk.rowCount === chunk.rows.length &&
		chunk.encodedBytes === expected.encodedBytes &&
		chunk.encodedBytes === encodedBytes(body)
	);
}

export function areRowsCanonical(rows: readonly SnapshotRow[]): boolean {
	for (let index = 1; index < rows.length; index += 1) {
		const previous = rows[index - 1];
		const current = rows[index];
		if (!previous || !current || compareRows(previous, current) >= 0)
			return false;
	}
	return true;
}

export function canonicalRows(rows: readonly SnapshotRow[]): SnapshotRow[] {
	return structuredClone(rows).sort(compareRows);
}

function compareRows(left: SnapshotRow, right: SnapshotRow): number {
	const leftIdentity = stableJson([left.table, left.rowId]);
	const rightIdentity = stableJson([right.table, right.rowId]);
	return leftIdentity < rightIdentity
		? -1
		: leftIdentity > rightIdentity
			? 1
			: 0;
}

function sha256(value: unknown): string {
	return createHash('sha256').update(stableJson(value)).digest('hex');
}

function encodedBytes(value: unknown): number {
	return new TextEncoder().encode(stableJson(value)).byteLength;
}
