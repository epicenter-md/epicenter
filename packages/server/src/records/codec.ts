import type { DocumentCodec } from '@epicenter/row-sync';
import * as Y from '@y/y';

/** Merge opaque Yjs updates into one garbage-collected full-state update. */
export const rowDocumentCodec = {
	isValidUpdate(update: Uint8Array): boolean {
		const document = new Y.Doc({ gc: true });
		try {
			try {
				Y.applyUpdate(document, update);
				return true;
			} catch {
				return false;
			}
		} finally {
			document.destroy();
		}
	},
	mergedCompactState(parts: readonly Uint8Array[]): Uint8Array {
		const document = new Y.Doc({ gc: true });
		try {
			for (const part of parts) Y.applyUpdate(document, part);
			return Y.encodeStateAsUpdate(document);
		} finally {
			document.destroy();
		}
	},
} satisfies DocumentCodec;
