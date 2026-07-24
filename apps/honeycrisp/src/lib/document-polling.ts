import type { DocumentSyncIssue, RowDocument } from '@epicenter/data';
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import { createLogger } from 'wellcrafted/logger';
import { tryAsync, trySync } from 'wellcrafted/result';

const log = createLogger('honeycrisp/document-polling');

const NotePollingError = defineErrors({
	TickFailed: ({ cause }: { cause: unknown }) => ({
		message: `Could not read this note's sync state: ${extractErrorMessage(cause)}`,
		cause,
	}),
	ConsumerThrew: ({ cause }: { cause: unknown }) => ({
		message: `Note sync-issue subscriber threw: ${extractErrorMessage(cause)}`,
		cause,
	}),
});

/**
 * Pull newer authority-accepted state for one open note document: once
 * immediately, then on an interval while the resolved note view stays
 * mounted. Returns a stop function for unmount.
 *
 * Two failure channels, matching the handle's own contract. A failed pull is
 * an ordinary sync outcome: app-wide sync status owns network trouble, the
 * locally durable document stays editable, and the durable sync issue is
 * still worth reporting, so the tick finishes normally. A rejected tick means
 * the handle refused the call, which may be terminal (disposed or revoked) or
 * transient (a worker or desktop-owner request that failed); polling cannot
 * tell the two apart, so it reports the failure and keeps its interval rather
 * than disabling itself for the life of the mounted note. A tick never
 * rejects, because the interval driving it has nowhere to report one.
 */
export function startNoteDocumentPolling(
	document: Pick<RowDocument, 'pull' | 'syncIssue'>,
	{
		intervalMs = 1_000,
		onIssue,
	}: {
		intervalMs?: number;
		onIssue?: (issue: DocumentSyncIssue) => void;
	} = {},
): () => void {
	let stopped = false;
	const tick = async () => {
		if (stopped) return;
		const { data: issue, error } = await tryAsync({
			try: async () => {
				const { error: pullError } = await document.pull();
				if (pullError !== null) {
					log.debug('Note document pull failed', pullError);
				}
				return document.syncIssue();
			},
			catch: (cause) => NotePollingError.TickFailed({ cause }),
		});
		// Losing the race with teardown is the expected way a tick fails: the
		// view is unmounting and disposing the handle this call still holds.
		if (stopped) return;
		if (error !== null) {
			log.warn(error);
			return;
		}
		// Adapted separately from the read above, not folded into it: a
		// throwing consumer is the consumer's bug, and reporting it as a failed
		// document read would be a lie. It gets its own owner rather than
		// escaping, because the only place it could escape to is an unhandled
		// rejection from the interval.
		const { error: consumerError } = trySync({
			try: () => onIssue?.(issue),
			catch: (cause) => NotePollingError.ConsumerThrew({ cause }),
		});
		if (consumerError !== null) log.error(consumerError);
	};
	void tick();
	const timer = setInterval(() => void tick(), intervalMs);
	return () => {
		stopped = true;
		clearInterval(timer);
	};
}
