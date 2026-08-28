/**
 * The WebView half of the mirror: where a pass is sent (ADR-0271).
 *
 * The application renders and whoever owns a filesystem writes, so something
 * has to carry one to the other. That is a same-origin request on the trusted
 * Epicenter origin, which needs no capability grant, and this is the one place
 * its shape is written down: the host declares its route from `MIRROR_PATH` and
 * an application builds its URL from the same constant, so the two cannot
 * drift.
 *
 * ## One verb, and why
 *
 * A pass says what the workspace holds. It does not say what to do to the
 * folder file by file, and it never asks what the folder currently contains:
 * the host owns the folder, so the host owns the diff. That is what deletes a
 * listing route, a delete route, an index route, and the sweep the application
 * used to run against a set it had to remember.
 *
 * The body's shape belongs to `./protocol.js`, which both ends read so neither
 * composes a line the other cannot parse. Batches exist because WebKit, which
 * is the WebView on macOS, does not support a streaming request body
 * (`duplex: 'half'`); a bounded batch is the same design with a ceiling on how
 * much is buffered at once.
 *
 * Deliberately thin. It sends bytes and reports whether that worked. It does
 * not retry, queue, or remember: the mirror is derived from a store that
 * already persisted the commit, so a batch that failed is re-rendered by the
 * next commit or the next boot, and a retry queue here would be a second
 * durability story competing with the real one.
 */
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import { defineErrors, type InferErrors } from 'wellcrafted/error';

import { MIRROR_PATH, type MirrorPlace } from './protocol.js';

export const MirrorSinkError = defineErrors({
	/**
	 * The host refused or could not write. The folder is a convenience over a
	 * filesystem that may be full, read-only, or on a drive someone unplugged;
	 * the store is unaffected, so this is reported and never thrown.
	 */
	MirrorSendFailed: ({
		status,
		cause,
	}: { status?: number; cause?: unknown }) => ({
		message:
			status === undefined
				? 'The mirror could not reach the host'
				: `The mirror was refused with ${status}`,
		status,
		cause,
	}),
});
export type MirrorSinkError = InferErrors<typeof MirrorSinkError>;

/** The absolute same-origin URL one place's folder is written through. */
function mirrorFolderUrl({
	place,
	databaseId,
}: {
	place: MirrorPlace;
	databaseId: string;
}): string {
	return `${MIRROR_PATH}/${encodeURIComponent(place)}/${encodeURIComponent(databaseId)}`;
}

export type MirrorSink = {
	/**
	 * Send one batch of a pass.
	 *
	 * The batch containing the manifest line is the last one, and it is what
	 * tells the host the pass is complete. Nothing else distinguishes batches.
	 */
	send(ndjson: string): Promise<Result<void, MirrorSinkError>>;
};

/**
 * The sink one place's folder is written through.
 *
 * `fetch` is injected so a test drives this without a host and without a
 * network, which is the whole of what makes the caller testable.
 */
export function createMirrorSink({
	place,
	databaseId,
	fetch: httpFetch = globalThis.fetch,
}: {
	place: MirrorPlace;
	databaseId: string;
	fetch?: typeof globalThis.fetch;
}): MirrorSink {
	const url = mirrorFolderUrl({ place, databaseId });
	return {
		async send(ndjson) {
			const { data: response, error } = await tryAsync({
				try: () =>
					httpFetch(url, {
						method: 'PUT',
						body: ndjson,
						// Same-origin and refusing a redirect, for the same reason the
						// blob adapter does: this carries a person's notes to a loopback
						// origin and must not follow one anywhere else.
						credentials: 'same-origin',
						redirect: 'error',
						headers: { 'content-type': 'application/x-ndjson' },
					}),
				catch: (cause) => MirrorSinkError.MirrorSendFailed({ cause }),
			});
			if (error !== null) return Err(error);
			if (!response.ok) {
				return MirrorSinkError.MirrorSendFailed({ status: response.status });
			}
			return Ok(undefined);
		},
	};
}

export { attachMirror, type MirrorableData } from './mirror.js';
// An application needs the verb and the word for which folder it is writing.
// The wire format itself is the host's business and this package's, and both
// read it from `./protocol.js` directly.
export type { MirrorPlace } from './protocol.js';
