import type {
	RowAuthority,
	RowAuthorityCompactionPolicy,
} from '@epicenter/row-sync';
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { trySync } from 'wellcrafted/result';

/** Internal production policy shared by both authority storage backends. */
export const RECORDS_COMPACTION_POLICY = {
	minimumRetainedSequences: 1_000,
} satisfies RowAuthorityCompactionPolicy;

const RecordsCompactionError = defineErrors({
	MaintenanceFailed: ({ cause }: { cause: unknown }) => ({
		message: `Could not compact row-sync history: ${extractErrorMessage(cause)}`,
		cause,
	}),
});

/** Run best-effort authority maintenance without hiding operational failures. */
export function runRecordsCompaction(
	authority: Pick<RowAuthority, 'maybeCompact'>,
	log: Logger = createLogger('server/records'),
): void {
	const { error } = trySync({
		try: () => authority.maybeCompact(RECORDS_COMPACTION_POLICY),
		catch: (cause) => RecordsCompactionError.MaintenanceFailed({ cause }),
	});
	if (error !== null) log.warn(error);
}
