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

/** One unsent entry, at the local position that orders it. */
export type OutboxEntry = { id: number; bytes: Uint8Array };

/**
 * One durable fact the store owes its storage, in the order it was accepted.
 *
 * `append` carries its outbox id when the bytes are locally authored work a
 * replica owes the authority, and `undefined` for received bytes and for a
 * device document's own work (which is owed to nobody). Ids are assigned by
 * the store, not the port, so the in-memory mirror and the durable engine can
 * never disagree about which entry an acknowledgement names.
 */
export type DurableOp =
	| {
			kind: 'append';
			bytes: Uint8Array;
			takenAt: number;
			outboxId: number | undefined;
	  }
	| { kind: 'cursor'; seq: number }
	| { kind: 'identity'; id: string }
	| { kind: 'dropOutbox'; throughId: number }
	| { kind: 'replaceOutbox'; throughId: number; merged: Uint8Array };

/** Everything the durable engine held at open, materialized once. */
export type DurableSnapshot = {
	updates: Uint8Array[];
	outbox: OutboxEntry[];
	cursor: number;
	identity: string | undefined;
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
 */
export type DurablePort = {
	commit(ops: readonly DurableOp[]): void | Promise<void>;
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
					if (op.outboxId !== undefined) {
						outbox.push({ id: op.outboxId, bytes: op.bytes });
						outboxGrew = true;
					}
					break;
				}
				case 'cursor':
					cursor = op.seq;
					break;
				case 'identity':
					identity ??= op.id;
					break;
				case 'dropOutbox':
					outbox = outbox.filter((entry) => entry.id > op.throughId);
					break;
				case 'replaceOutbox': {
					const kept = outbox.filter((entry) => entry.id > op.throughId);
					outbox = [{ id: op.throughId, bytes: op.merged }, ...kept];
					break;
				}
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
		notifyStatus();
		void outcome
			.then(
				() => succeeded(batch),
				(cause) => failed(batch, cause),
			)
			.finally(() => {
				inFlight = false;
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
		hasAnyState: () =>
			hasUpdates ||
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
