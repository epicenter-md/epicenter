import type { DocumentSyncIssue, RowDocument } from '@epicenter/data';

/**
 * Pull newer authority-accepted state for one open note document: once
 * immediately, then on an interval while the resolved note view stays
 * mounted. Transient pull failures are ignored here; app-wide sync status
 * owns network trouble, and the locally durable document stays usable either
 * way. Returns a stop function for unmount.
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
		try {
			await document.pull();
			const issue = await document.syncIssue();
			if (!stopped) onIssue?.(issue);
		} catch {
			// A disposed or revoked handle throws; cleanup owns stopping.
		}
	};
	void tick();
	const timer = setInterval(() => void tick(), intervalMs);
	return () => {
		stopped = true;
		clearInterval(timer);
	};
}
