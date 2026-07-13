/**
 * Read-only recovery artifact for a replica fenced outside the current epoch.
 *
 * It captures the obsolete replica's self-describing local state and pending
 * logical intent. There is intentionally no inverse parser or replay operation:
 * an application or person decides how to use the exported facts.
 */

import { MutationSchema, SnapshotRowSchema } from '@epicenter/record-sync';
import { type Static, Type } from 'typebox';

export const RECORDS_RECOVERY_CHECKPOINT_FORMAT =
	'epicenter.records-recovery/1' as const;

const nonEmptyString = Type.String({ minLength: 1 });

export const RecordsRecoveryCheckpointSchema = Type.Object(
	{
		format: Type.Literal(RECORDS_RECOVERY_CHECKPOINT_FORMAT),
		workspaceId: nonEmptyString,
		recordsEpoch: nonEmptyString,
		recordsDescriptor: nonEmptyString,
		recordsSchemaHash: nonEmptyString,
		rows: Type.Array(SnapshotRowSchema),
		pendingMutations: Type.Array(MutationSchema),
	},
	{ additionalProperties: false },
);

export type RecordsRecoveryCheckpoint = Static<
	typeof RecordsRecoveryCheckpointSchema
>;
