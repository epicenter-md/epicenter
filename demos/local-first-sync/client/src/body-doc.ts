/**
 * Lazy Yjs child document per note body.
 *
 * The Y.Doc is constructed ONLY when a body is opened; its durable form is
 * the `doc_updates` log inside the local SQLite database. Local edits emit
 * incremental Yjs updates as 'doc' ops (opaque to the server); remote 'doc'
 * ops land in the log and are applied here if the doc is open.
 *
 * This is the non-negotiable boundary: record metadata syncs per-cell with
 * server acceptance order; authored bodies merge with Yjs CRDT semantics.
 */

import * as Y from 'yjs';
import type { DbClient } from './db-client';

function toBase64(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

export type BodyHandle = {
	text: Y.Text;
	/** Number of update frames applied at open (proves lazy hydration). */
	frameCount: number;
	insert(index: number, content: string): void;
	applyRemoteFromLog(): Promise<void>;
	close(): void;
};

export async function openBody(opts: {
	db: DbClient;
	noteId: string;
}): Promise<BodyHandle> {
	const docId = `note-body-${opts.noteId}`;
	const doc = new Y.Doc({ gc: true });
	const text = doc.getText('body');

	const frames = await opts.db.docUpdates(docId);
	for (const frame of frames) Y.applyUpdate(doc, fromBase64(frame), 'log');
	let appliedFrames = frames.length;

	// Local edits (origin != 'log') become durable 'doc' ops.
	doc.on('update', (update: Uint8Array, origin: unknown) => {
		if (origin === 'log') return;
		void opts.db.write({
			kind: 'doc',
			docId,
			update: toBase64(update),
		});
	});

	return {
		text,
		frameCount: frames.length,
		insert(index, content) {
			text.insert(index, content);
		},
		/** Re-read the log tail (after a pull) and apply any new frames. */
		async applyRemoteFromLog() {
			const allFrames = await opts.db.docUpdates(docId);
			for (const frame of allFrames.slice(appliedFrames)) {
				Y.applyUpdate(doc, fromBase64(frame), 'log');
			}
			appliedFrames = allFrames.length;
		},
		close() {
			doc.destroy();
		},
	};
}
