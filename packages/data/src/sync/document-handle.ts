/**
 * One open document, owning everything about being open.
 *
 * The thing that replaces a control plane. `documents.ts` describes itself as
 * a manager that "reuses one live `Y.Doc` per address, persists through the
 * store's ONE durable queue, accepts remote bytes from the store's ONE
 * connection" — and every "one" in that sentence was true of a positional log
 * carried on a single socket. Under one object per document (ADR-0277) none of
 * them is, and what is left for a manager to do is hold a map.
 *
 * So a handle owns its own lifetime instead: its bytes, its socket, its timer,
 * and the hook that saves it when the page goes away. Closing it ends all four.
 * Nothing has to enumerate open documents to persist them, because nothing has
 * to persist them — each one persists itself.
 *
 * ## The root document is one of these
 *
 * It is the handle nobody closes. That is the entire difference between the
 * application document and a note's body: one is opened when the database opens
 * and closed when it closes, and the other is opened when somebody looks at a
 * note. Same type, same lifecycle, different lifetime.
 *
 * ## Why opening is asynchronous
 *
 * `store.ts` already says it, and fast storage does not change it: "it is a
 * load, and a synchronous surface in front of one either forces eager loading
 * or hands out a half-hydrated handle an editor merges keystrokes into at the
 * wrong position." OPFS being quick makes that window small, not safe — a
 * ProseMirror editor bound to a `Y.Type` that is about to have three thousand
 * structs applied underneath it is wrong however briefly it lasts.
 */
import type * as Y from '@y/y';

import type { Blobs } from '../store/blobs.js';
import { persistOnHide } from '../store/flush-on-hide.js';
import type { DocumentSocket } from './document-frames.js';
import { openDocumentReplica } from './document-replica.js';
import { openDocumentSession } from './document-session.js';

export type DocumentHandle = {
	/** The live document. Truth while open (ADR-0238). */
	readonly document: Y.Doc;
	/** A socket is live for this document. */
	attach(socket: DocumentSocket): void;
	/**
	 * Bytes arrived on that socket. Returns whether they were a frame.
	 *
	 * A host wires its socket's message event to this. The pair is deliberate
	 * and was missing for an hour: `attach` gives the handle somewhere to
	 * write, and this is where reading lands. A handle with only `attach` can
	 * talk and cannot listen, which a test caught by being unable to wire one.
	 */
	receive(message: Uint8Array): boolean;
	detach(): void;
	/** Write now rather than on the next idle, and send whatever is owed. */
	settle(): Promise<void>;
	/** Settle, then release the socket, the timer and the hook. */
	close(): Promise<void>;
};

export type OpenDocumentHandleOptions = {
	blobs: Blobs;
	/** This document's key, which carries its generation (ADR-0276). */
	key: string;
	/**
	 * How long after the last edit to write and send.
	 *
	 * One timer, not two. The durable write and the push are triggered
	 * together because they are the same moment — work has stopped arriving —
	 * and because sending what is not yet durable is the one ordering this
	 * design refuses (`document-replica.ts`).
	 */
	idleMs?: number;
	/** Injected so a test can drive the timer rather than wait for it. */
	schedule?: (run: () => void, ms: number) => () => void;
};

const DEFAULT_IDLE_MS = 1_000;

const timeout: NonNullable<OpenDocumentHandleOptions['schedule']> = (
	run,
	ms,
) => {
	const id = setTimeout(run, ms);
	return () => clearTimeout(id);
};

export async function openDocumentHandle({
	blobs,
	key,
	idleMs = DEFAULT_IDLE_MS,
	schedule = timeout,
}: OpenDocumentHandleOptions): Promise<DocumentHandle> {
	const replica = await openDocumentReplica({ blobs, key });
	const session = openDocumentSession({ replica });

	let cancelIdle: (() => void) | undefined;
	let closed = false;

	/** Write the document and send what the peer lacks. In that order. */
	async function settle(): Promise<void> {
		cancelIdle?.();
		cancelIdle = undefined;
		if (closed) return;
		await replica.persist();
		// After the write, never before: a peer told about bytes this device
		// might not have on its next boot is the one direction that loses work
		// silently rather than re-sending.
		session.flush();
	}

	function onLocalWork(): void {
		if (closed) return;
		cancelIdle?.();
		cancelIdle = schedule(() => {
			cancelIdle = undefined;
			void settle();
		}, idleMs);
	}

	// `updateV2` fires for remote applications too. Persisting those is not
	// waste: bytes that arrived are bytes this device now holds, and a reload
	// that had to re-fetch them would be asking for something it was already
	// given.
	replica.document.on('updateV2' as never, onLocalWork as never);

	// The page can go away between the last edit and the timer. This is the
	// only thing that reaches past that, and it is per handle rather than a
	// list somebody has to keep: a document that is open saves itself.
	const stopHideHook = persistOnHide(() => replica.persist());

	return Object.freeze({
		document: replica.document,
		attach: (socket: DocumentSocket) => session.attach(socket),
		receive: (message: Uint8Array) => session.receive(message),
		detach: () => session.detach(),
		settle,
		async close() {
			if (closed) return;
			await settle();
			closed = true;
			cancelIdle?.();
			cancelIdle = undefined;
			stopHideHook();
			replica.document.off('updateV2' as never, onLocalWork as never);
			session.dispose();
			replica.dispose();
		},
	});
}
