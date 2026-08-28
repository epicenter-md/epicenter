/**
 * The store's local-persistence debt: accepted work the durable engine has not
 * confirmed yet (ADR-0238).
 *
 * Each store owns one controller. It holds the ordered queue of durable
 * operations the live document has accepted, hands the WHOLE queue to the
 * runtime's storage port as one atomic batch, and mirrors what the engine has
 * confirmed so the sync sender can read durable facts without touching
 * storage. A failed flush retains everything, in order, and reports
 * `blocked`; a later enqueue or an explicit `flush()` retries. Nothing here
 * ever invalidates the live document.
 */

import { defineErrors } from 'wellcrafted/error';
import type { Logger } from 'wellcrafted/logger';

/**
 * One unsent entry, at the local position that orders it, naming the document
 * its bytes belong to (the application document or a row's derived address).
 */
export type OutboxEntry = { id: number; document: string; bytes: Uint8Array };

/**
 * One durable fact the store owes its storage, in the order it was accepted.
 *
 * `append` names the document its bytes belong to: the application document,
 * or a row's derived address (ADR-0248). It carries its outbox id when the
 * bytes are locally authored work a replica owes the authority, and
 * `undefined` for received bytes and for a device document's own work (which
 * is owed to nobody). Ids are assigned by the store, not the port, so the
 * in-memory mirror and the durable engine can never disagree about which
 * entry an acknowledgement names.
 *
 * `retire` is a row deletion's durable half: it records the address as
 * tombstoned and deletes the document's stored chain and outbox entries, in
 * the same atomic batch as the scalar row removal, so a late write can never
 * resurrect the address (ADR-0248).
 */
/**
 * What the store owes its storage, in acceptance order.
 *
 * Four arms, and the shape of the union is the design. What used to be six
 * collapsed when two facts turned out to be one: "the authority does not have
 * these bytes" and "the authority gave these bytes no position" say the same
 * thing, so an append carries a nullable `authoritySeq` and the outbox and the
 * cursor are both READ OFF IT rather than stored beside it.
 *
 * That is what deletes `dropOutbox` (an ack is not a deletion, it is a
 * position landing), `replaceOutbox` (a compaction that carried no invariant,
 * and the only one that crossed this boundary while the far larger fold stayed
 * private to the port), and `cursor` (never a fact of its own).
 */
export type DurableOp =
	| {
			kind: 'append';
			document: string;
			/**
			 * One monotone sequence across every document, never reused.
			 *
			 * Never reused is the load-bearing half. The fold used to renumber a
			 * document's chain from 1, so a position recorded against it silently
			 * came to mean a different update, which is why owed work had to live
			 * in a relation of its own. Stable ids make it a column.
			 */
			id: number;
			bytes: Uint8Array;
			/** The authority's log position, or `undefined` while it has none. */
			authoritySeq: number | undefined;
	  }
	| {
			/**
			 * The authority took responsibility through `throughId` and put those
			 * bytes at `authoritySeq`.
			 *
			 * One submission is one envelope and lands as ONE log entry, so every
			 * covered append takes the same position. This is both halves of what
			 * the client used to do in two calls, `advance` and `acknowledge`.
			 */
			kind: 'ack';
			throughId: number;
			authoritySeq: number;
	  }
	| { kind: 'identity'; id: string }
	| { kind: 'retire'; document: string };

/**
 * Everything the durable engine held at open, materialized once.
 *
 * `outbox` and `cursor` are DERIVED here rather than stored: owed work is
 * every append the authority gave no position, and the cursor is the highest
 * position any append carries. The port computes both while it has the file
 * open, so the store never asks storage a second question.
 */
export type DurableSnapshot = {
	/** The application document's own chain; row documents hydrate on open. */
	updates: Uint8Array[];
	/** Appends with no authority position, in id order. */
	outbox: OutboxEntry[];
	/**
	 * The highest authority position any append carries, or 0.
	 *
	 * A derived cursor cannot outrun the bytes it accounts for, because it is
	 * computed from them. It can only LAG, which is safe: a re-received entry
	 * is applied again, and an update is idempotent.
	 */
	cursor: number;
	identity: string | undefined;
	/** Every durably retired document address (ADR-0248). */
	tombstones: string[];
	/** The highest id any append carries, so the store mints from here. */
	lastId: number;
};

/**
 * The runtime-native durable engine: apply one batch atomically, or not at
 * all.
 *
 * `commit` may be synchronous (a file SQLite, a Durable Object's storage) or
 * asynchronous (IndexedDB). The atomicity requirement is absolute either way:
 * a batch that half-commits would let a cursor outrun the bytes it accounts
 * for, which is exactly the corruption ADR-0231 exists to prevent. Ordering
 * within the batch is the queue's order.
 *
 * The two readers serve the document manager (ADR-0248): a row document
 * hydrates from its stored chain at open, and a snapshot bundle enumerates
 * every chain the store holds. Both treat the address as an opaque string.
 */
export type DurablePort = {
	commit(ops: readonly DurableOp[]): void | Promise<void>;
	/** One document's stored chain, oldest first. Empty when nothing is held. */
	readDocument(document: string): Uint8Array[] | Promise<Uint8Array[]>;
	/** Every document address with a stored chain, the application's included. */
	listDocuments(): string[] | Promise<string[]>;
};

export type PersistenceStatus = 'saved' | 'pending' | 'blocked';

/**
 * The public face of the local-persistence debt (ADR-0238).
 *
 * `saved` means no accepted work remains only in memory. `pending` means work
 * is waiting for, or participating in, a requested flush. `blocked` means the
 * latest flush failed and edits may be lost on restart; a later edit or an
 * explicit `flush()` retries.
 */
export type PersistenceCapability = {
	get(): PersistenceStatus;
	/** Hear when the status changes. Never fires initially. */
	subscribe(listener: () => void): () => void;
	/**
	 * Request one attempt over everything outstanding. Resolves when the
	 * controller settles, whatever the outcome; the outcome is `get()`'s
	 * answer.
	 */
	flush(): Promise<void>;
};

const PersistenceError = defineErrors({
	/**
	 * A flush failed and the work is retained in memory.
	 *
	 * Logged, never returned: the caller that triggered the flush already got
	 * its `Ok`, because acceptance and durability are two steps (ADR-0238).
	 * The status is the channel; this is the diagnostic behind it.
	 */
	FlushFailed: ({ cause, retained }: { cause: unknown; retained: number }) => ({
		message: `A durable flush failed; ${retained} operation(s) retained in memory`,
		cause,
		retained,
	}),
	/**
	 * A subscriber threw while being told about persistence. Logged, never
	 * returned: it is the subscriber's own bug, and one broken listener must
	 * not cost the others their notification.
	 */
	SubscriberThrew: ({ cause }: { cause: unknown }) => ({
		message: 'A persistence subscriber threw while being notified',
		cause,
	}),
});

export type PersistenceController = {
	/**
	 * Accept ops in order and request one coalesced flush attempt.
	 *
	 * On a synchronous port the attempt runs before this returns, so a
	 * successful write is durable when the accepting verb returns.
	 */
	enqueue(ops: readonly DurableOp[]): void;
	/** The public status surface, frozen for the store to expose. */
	persistence: PersistenceCapability;
	/**
	 * What the durable engine has confirmed. The sync sender reads THIS, never
	 * the live document and never the queue: a local edit is offered to the
	 * authority only once it is durable (ADR-0238).
	 */
	durableOutbox(): readonly OutboxEntry[];
	/**
	 * Bytes accepted for one document that the durable engine has not
	 * confirmed: the in-flight batch and the queue, in order.
	 *
	 * The document manager's hydration overlay (ADR-0248): a row document
	 * opened while an asynchronous flush is out must still see everything the
	 * store accepted. A byte the durable read already covered may appear here
	 * again during that window; re-applying it is free because an update is
	 * idempotent.
	 */
	pendingAppends(document: string): Uint8Array[];
	/** Every document named by an unconfirmed append, for state enumeration. */
	pendingDocuments(): string[];
	/**
	 * Whether anything at all is held, durably or queued: updates, outbox
	 * entries, a moved cursor. The identity stamp's emptiness check.
	 */
	hasAnyState(): boolean;
	/**
	 * Hear that a flush durably grew the outbox: the moment the transport has
	 * something it may send.
	 */
	onOutboxGrew(listener: () => void): () => void;
	/** One final attempt, then settle. Disposal's drain. */
	drain(): Promise<void>;
};

export function createPersistenceController({
	port,
	loaded,
	log,
}: {
	port: DurablePort;
	loaded: DurableSnapshot;
	log: Logger;
}): PersistenceController {
	/** Accepted ops the durable engine has not confirmed, in order. */
	let queue: DurableOp[] = [];
	/** Whether a batch is out against an asynchronous port. */
	let inFlight = false;
	/** Whether ops arrived while a batch was out. */
	let again = false;

	// The durable mirror: what the engine has confirmed, advanced only on a
	// successful flush. Reading it never touches storage, which is what lets
	// the sync sender stay synchronous over an asynchronous engine.
	let outbox: OutboxEntry[] = [...loaded.outbox];
	let cursor = loaded.cursor;
	let identity = loaded.identity;
	let hasUpdates = loaded.updates.length > 0;
	let hasTombstones = loaded.tombstones.length > 0;
	/** The batch handed to an asynchronous port and not yet settled. */
	let flying: readonly DurableOp[] = [];

	const statusListeners = new Set<() => void>();
	const outboxGrewListeners = new Set<() => void>();
	/** Callers awaiting `flush()`, resolved whenever the controller settles. */
	let settled: (() => void)[] = [];

	function status(): PersistenceStatus {
		if (inFlight || again) return 'pending';
		if (queue.length > 0) return 'blocked';
		return 'saved';
	}

	let lastStatus: PersistenceStatus = status();

	function notifyStatus(): void {
		const next = status();
		if (next === lastStatus) return;
		lastStatus = next;
		for (const listener of [...statusListeners]) {
			try {
				listener();
			} catch (cause) {
				log.error(PersistenceError.SubscriberThrew({ cause }).error);
			}
		}
	}

	function settle(): void {
		if (inFlight || again) return;
		const waiting = settled;
		settled = [];
		for (const resolve of waiting) resolve();
	}

	function absorb(batch: readonly DurableOp[]): boolean {
		let outboxGrew = false;
		for (const op of batch) {
			switch (op.kind) {
				case 'append': {
					hasUpdates = true;
					// Owed exactly when the authority has no position for it, which
					// is the same test the port runs against the column.
					if (op.authoritySeq === undefined) {
						outbox.push({ id: op.id, document: op.document, bytes: op.bytes });
						outboxGrew = true;
					} else if (op.authoritySeq > cursor) {
						cursor = op.authoritySeq;
					}
					break;
				}
				case 'ack':
					// One op, both halves: the covered work stops being owed, and the
					// position it landed at becomes the cursor. They were always one
					// fact reported twice.
					outbox = outbox.filter((entry) => entry.id > op.throughId);
					if (op.authoritySeq > cursor) cursor = op.authoritySeq;
					break;
				case 'identity':
					identity ??= op.id;
					break;
				case 'retire':
					hasTombstones = true;
					outbox = outbox.filter((entry) => entry.document !== op.document);
					break;
			}
		}
		return outboxGrew;
	}

	function succeeded(batch: readonly DurableOp[]): void {
		const outboxGrew = absorb(batch);
		if (outboxGrew) {
			for (const listener of [...outboxGrewListeners]) {
				try {
					listener();
				} catch (cause) {
					log.error(PersistenceError.SubscriberThrew({ cause }).error);
				}
			}
		}
	}

	function failed(batch: readonly DurableOp[], cause: unknown): void {
		// Everything comes back, in order, ahead of whatever arrived meanwhile.
		// The live document already holds this work; only the durable copy is
		// behind, and the status says so.
		queue = [...batch, ...queue];
		log.error(
			PersistenceError.FlushFailed({ cause, retained: queue.length }).error,
		);
	}

	/**
	 * Hand the whole queue to the port. Synchronous ports finish inline, so a
	 * verb on Bun returns with its write durable; asynchronous ports coalesce
	 * everything accepted mid-flight into the next batch.
	 */
	function attempt(): void {
		if (inFlight) {
			again = true;
			return;
		}
		if (queue.length === 0) {
			notifyStatus();
			settle();
			return;
		}
		const batch = queue;
		queue = [];
		let outcome: void | Promise<void>;
		try {
			outcome = port.commit(batch);
		} catch (cause) {
			failed(batch, cause);
			notifyStatus();
			settle();
			return;
		}
		if (outcome === undefined) {
			succeeded(batch);
			notifyStatus();
			settle();
			return;
		}
		inFlight = true;
		flying = batch;
		notifyStatus();
		void outcome
			.then(
				() => succeeded(batch),
				(cause) => failed(batch, cause),
			)
			.finally(() => {
				inFlight = false;
				flying = [];
				if (again) {
					again = false;
					attempt();
					return;
				}
				notifyStatus();
				settle();
			});
	}

	function flush(): Promise<void> {
		attempt();
		if (!inFlight && !again) return Promise.resolve();
		return new Promise((resolve) => {
			settled.push(resolve);
		});
	}

	return {
		enqueue(ops: readonly DurableOp[]): void {
			if (ops.length === 0) return;
			queue.push(...ops);
			attempt();
		},
		persistence: Object.freeze({
			get: status,
			subscribe(listener: () => void): () => void {
				statusListeners.add(listener);
				return () => statusListeners.delete(listener);
			},
			flush,
		}),
		durableOutbox: () => outbox,
		pendingAppends(document: string): Uint8Array[] {
			const bytes: Uint8Array[] = [];
			for (const op of [...flying, ...queue]) {
				if (op.kind === 'append' && op.document === document) {
					bytes.push(op.bytes);
				}
			}
			return bytes;
		},
		pendingDocuments(): string[] {
			const documents = new Set<string>();
			for (const op of [...flying, ...queue]) {
				if (op.kind === 'append') documents.add(op.document);
			}
			return [...documents];
		},
		hasAnyState: () =>
			hasUpdates ||
			hasTombstones ||
			outbox.length > 0 ||
			cursor > 0 ||
			identity !== undefined ||
			queue.length > 0 ||
			inFlight,
		onOutboxGrew(listener: () => void): () => void {
			outboxGrewListeners.add(listener);
			return () => outboxGrewListeners.delete(listener);
		},
		drain: flush,
	};
}
