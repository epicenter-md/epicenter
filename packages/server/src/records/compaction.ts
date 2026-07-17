import type { RecordAuthorityCompactionPolicy } from '@epicenter/row-sync';

/** Internal production policy shared by both authority storage backends. */
export const RECORDS_COMPACTION_POLICY = {
	minimumRetainedSequences: 1_000,
	maxChunkBytes: 512 * 1024,
} satisfies RecordAuthorityCompactionPolicy;
