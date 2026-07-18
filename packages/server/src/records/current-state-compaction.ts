import type { RoundReceipt } from '@epicenter/row-sync';
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { trySync } from 'wellcrafted/result';
import type { CurrentStateRowAuthority } from '../workspace-authority/authority.js';

/** Keep this many recent authority sequences available for incremental pull. */
export const CURRENT_STATE_RETENTION_WINDOW = 1_000;

const CurrentStateCompactionError = defineErrors({
	MaintenanceFailed: ({ cause }: { cause: unknown }) => ({
		message: `Could not compact row transport history: ${extractErrorMessage(cause)}`,
		cause,
	}),
});

/** Compact predictably after acceptance without making maintenance correctness. */
export function runCurrentStateTransportCompaction(
	compactThrough: CurrentStateRowAuthority['compactThrough'],
	receipt: RoundReceipt,
	log: Logger = createLogger('server/records'),
): void {
	const requestedFloor = Math.max(
		0,
		receipt.appliedThrough - CURRENT_STATE_RETENTION_WINDOW,
	);
	const { error } = trySync({
		try: () => compactThrough(requestedFloor),
		catch: (cause) => CurrentStateCompactionError.MaintenanceFailed({ cause }),
	});
	if (error !== null) log.warn(error);
}
