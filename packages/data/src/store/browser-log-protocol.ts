/**
 * What a page says to the worker that holds its durable log, and back.
 *
 * Deliberately tiny, and deliberately not a replica protocol. The worker holds
 * SQLite statements it never interprets and bytes it never reads; it does not
 * know what a row is, what a lens is, or that Yjs exists. Compare
 * `src/browser/protocol.ts` on the superseded stack, which had to carry table
 * reads, row documents, sync sessions and invalidations, because there the
 * worker owned the replica and the page was its client. Here the page owns
 * everything and the worker owns a file.
 */
import type { SqliteValue } from '@epicenter/sqlite';

/** One statement, exactly as the page ran it against its own database. */
export type LoggedStatement = {
	sql: string;
	parameters: readonly SqliteValue[];
};

export type BrowserLogRequest =
	/**
	 * Open the durable database for this application and hand back its bytes.
	 *
	 * The whole file, not a replay. It is the same schema the page is about to
	 * run, so deserializing it into memory leaves the page holding exactly what
	 * the last session committed, with nothing to reconcile.
	 */
	| { kind: 'open'; id: number; name: string }
	/** Apply one committed batch, in one transaction, in the order given. */
	| { kind: 'apply'; id: number; statements: readonly LoggedStatement[] }
	/** Resolve once every batch accepted so far has committed. */
	| { kind: 'settle'; id: number }
	| { kind: 'close'; id: number };

export type BrowserLogResponse =
	| { kind: 'opened'; id: number; bytes: Uint8Array | undefined }
	| { kind: 'ok'; id: number }
	| { kind: 'failed'; id: number; name: string; message: string }
	/**
	 * A batch failed with nobody waiting on it.
	 *
	 * The reason the page needs an alarm rather than an error. A mirrored write
	 * has already returned `Ok` by the time the worker refuses it, so this is
	 * the only way the page can ever learn that its durable copy has stopped
	 * keeping up.
	 */
	| { kind: 'alarm'; name: string; message: string };
