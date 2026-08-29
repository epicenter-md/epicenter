/**
 * The document manager: one independent Yjs document per opaque address
 * (ADR-0248).
 *
 * A row owns one rich document at its derived address, and this manager is
 * the whole runtime for those documents: it opens fully hydrated handles,
 * reuses one live `Y.Doc` per address, persists locally authored `updateV2`
 * bytes through the store's one durable queue, accepts remote bytes from the
 * store's one connection, refuses a retired address, and unloads a document
 * when its last handle closes.
 *
 * It knows nothing about databases, tables, rows, previews, schemas, or root
 * names. An address is an opaque string it never parses; the database layer
 * composes addresses (`documentAddress`) and composes row deletion with
 * retirement. Applications name their own roots inside a document and pick
 * their own formats; concurrent first creation of one named root converges,
 * because a top-level root is addressed by its name
 * (`evidence/independent-document-roots.test.ts`), which is why no root is
 * reserved at create time.
 */
import * as Y from '@y/y';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import type { Logger } from 'wellcrafted/logger';
import { Err, Ok, type Result } from 'wellcrafted/result';

import { copyBytes } from './log.js';
import type { DurableOp, PersistenceController } from './persistence.js';

export const DocumentError = defineErrors({
	/**
	 * This address was durably retired: its row was deleted, and a retired
	 * address takes no further bytes. Opening it again would mint an empty
	 * document whose writes go nowhere a row can ever read, so the open is
	 * refused rather than resurrecting anything.
	 */
	DocumentRetired: ({ address }: { address: string }) => ({
		message: `Document '${address}' was retired and cannot be opened`,
		address,
	}),
	/**
	 * The stored chain could not be read or replayed, so there is no fully
	 * hydrated document to hand out. A boot-shaped outcome, like an opener's
	 * StorageFailed: the caller renders a failure, and nothing half-hydrated
	 * ever escapes.
	 */
	HydrationFailed: ({
		address,
		cause,
	}: {
		address: string;
		cause: unknown;
	}) => ({
		message: `Document '${address}' could not be hydrated from storage`,
		address,
		cause,
	}),
});
export type DocumentError = InferErrors<typeof DocumentError>;

/**
 * One open document: the roots an application names inside it.
 *
 * `get` mirrors `Y.Doc.get(key, typeName)`: it mints the root on miss, which
 * is safe here because a top-level root is addressed by its NAME, so two
 * devices minting one root converge with both writes retained. `typeName` is
 * passed through unread; choosing a format is the application's business.
 *
 * Disposing releases this handle's hold. The manager unloads the live
 * document when the last handle closes; the bytes it accepted are already in
 * the durable queue, so unloading loses nothing.
 */
export type RowDocumentHandle = {
	get(root: string, typeName?: string | null): Y.Type;
	[Symbol.dispose](): void;
};

/** The manager's package-internal verbs, driven by the store engine only. */
type DocumentEngine = {
	/**
	 * Open one address, resolving only after complete local hydration.
	 *
	 * Two concurrent opens of one address share one live `Y.Doc`; each handle
	 * releases independently. The one refusal a caller concludes something
	 * from is `DocumentRetired`; `HydrationFailed` is storage trouble.
	 */
	open(address: string): Promise<Result<RowDocumentHandle, DocumentError>>;
	/**
	 * Take one remote section: apply it live when the address is open, and
	 * hand back the durable append op, or undefined for a retired address.
	 * The CALLER enqueues, so a whole envelope and its cursor land in one
	 * atomic batch.
	 */
	acceptRemote(address: string, bytes: Uint8Array): DurableOp | undefined;
	/**
	 * Retire one address: revoke the live document, remember the tombstone,
	 * and hand back the durable op that tombstones it and deletes its chain.
	 * The caller enqueues it beside the scalar row removal it composes with.
	 */
	retire(address: string): DurableOp;
	/**
	 * Every live or stored document's complete state, one section each: the
	 * snapshot bundle's document half. Retired addresses are excluded.
	 */
	states(): Promise<{ document: string; bytes: Uint8Array }[]>;
	/** Destroy every live document. Disposal's teardown. */
	destroy(): void;
};

/** Bytes replayed from storage, which must not be appended back to storage. */
const hydrationOrigin = Object.freeze({ kind: 'epicenter-hydration' });
/** Bytes that arrived from a peer: durable, but not local work. */
const remoteOrigin = Object.freeze({ kind: 'epicenter-remote' });

type LiveDocument = {
	doc: Y.Doc;
	references: number;
	hydration: Promise<Result<void, DocumentError>>;
};

export function createDocumentEngine({
	readDocument,
	listDocuments,
	appDocument,
	controller,
	mintOutboxId,
	tombstones,
	now,
	assertUsable,
	log,
}: {
	/** The durable port's chain reader, bound by the opener. */
	readDocument(address: string): Uint8Array[] | Promise<Uint8Array[]>;
	/** The durable port's chain enumeration, bound by the opener. */
	listDocuments(): string[] | Promise<string[]>;
	/**
	 * The one address that is not a row document: the application document's
	 * name in the shared log, excluded from `states()` because the engine
	 * encodes it from the live index instead.
	 */
	appDocument: string;
	controller: PersistenceController;
	/** Mints from the store's one outbox sequence; undefined on a device store. */
	mintOutboxId(): number | undefined;
	/** Durably retired addresses, loaded at open. Owned by this engine from here. */
	tombstones: readonly string[];
	now(): number;
	assertUsable(): void;
	log: Logger;
}): DocumentEngine {
	const retired = new Set(tombstones);
	const live = new Map<string, LiveDocument>();

	function attach(address: string, doc: Y.Doc): void {
		doc.on(
			'updateV2',
			(
				update: Uint8Array,
				origin: unknown,
				_doc: Y.Doc,
				transaction: Y.Transaction,
			) => {
				if (origin === hydrationOrigin || origin === remoteOrigin) return;
				// Same law as the application document: foreign bytes enter through
				// the store connection, never through a direct `Y.applyUpdateV2` on
				// the live document, which would republish them as this device's
				// own authored work.
				if (!transaction.local) {
					throw new Error(
						"Foreign bytes must enter through the store connection. A direct Y.applyUpdateV2 on a row document would be republished as this device's own work.",
					);
				}
				// An application writing inside its own document. The bytes join the
				// durable queue on their own; nothing else is going to flush them.
				controller.enqueue([
					{
						kind: 'append',
						document: address,
						bytes: copyBytes(update),
						takenAt: now(),
						outboxId: mintOutboxId(),
					},
				]);
			},
		);
	}

	async function hydrate(
		address: string,
		doc: Y.Doc,
	): Promise<Result<void, DocumentError>> {
		try {
			const chain = await readDocument(address);
			for (const stored of chain) {
				Y.applyUpdateV2(doc, copyBytes(stored), hydrationOrigin);
			}
			// Accepted work an asynchronous flush has not confirmed yet. A byte
			// the chain already covered may replay twice; an update is idempotent.
			for (const pending of controller.pendingAppends(address)) {
				Y.applyUpdateV2(doc, copyBytes(pending), hydrationOrigin);
			}
			return Ok(undefined);
		} catch (cause) {
			return DocumentError.HydrationFailed({ address, cause });
		}
	}

	function release(address: string): void {
		const entry = live.get(address);
		if (entry === undefined) return;
		entry.references -= 1;
		if (entry.references > 0) return;
		live.delete(address);
		// The durable queue already holds every accepted byte, so unloading the
		// live object loses nothing; the next open rehydrates.
		entry.doc.destroy();
	}

	function handleOver(address: string, entry: LiveDocument): RowDocumentHandle {
		let disposed = false;
		return {
			get(root: string, typeName?: string | null): Y.Type {
				assertUsable();
				// SAFETY: `Doc.get`'s rc typing takes `never` for the optional type
				// name; a string or null is the value it actually accepts.
				return entry.doc.get(root, (typeName ?? null) as never);
			},
			[Symbol.dispose]() {
				// Idempotent, because a Svelte effect that reruns can call the
				// teardown it was handed more than once.
				if (disposed) return;
				disposed = true;
				release(address);
			},
		};
	}

	return {
		async open(
			address: string,
		): Promise<Result<RowDocumentHandle, DocumentError>> {
			assertUsable();
			if (retired.has(address)) {
				return DocumentError.DocumentRetired({ address });
			}
			let entry = live.get(address);
			if (entry === undefined) {
				const doc = new Y.Doc({ gc: true });
				// Listener before hydration, replay under an origin it ignores, so
				// loading cannot append the bytes it just read.
				attach(address, doc);
				const created: LiveDocument = {
					doc,
					references: 0,
					hydration: hydrate(address, doc),
				};
				live.set(address, created);
				entry = created;
			}
			// Held before the await, so a concurrent close cannot unload the
			// document this open is hydrating.
			entry.references += 1;
			const { error } = await entry.hydration;
			if (error !== null) {
				release(address);
				return Err(error);
			}
			if (retired.has(address)) {
				// Retired while hydrating: the row deletion won, and this open
				// concludes the same refusal it would have met a moment later.
				release(address);
				return DocumentError.DocumentRetired({ address });
			}
			return Ok(handleOver(address, entry));
		},

		acceptRemote(address: string, bytes: Uint8Array): DurableOp | undefined {
			// A late update for a retired address is dropped whole: not applied,
			// not stored. This is what makes retirement durable against the wire.
			if (retired.has(address)) return undefined;
			const entry = live.get(address);
			if (entry !== undefined) {
				Y.applyUpdateV2(entry.doc, copyBytes(bytes), remoteOrigin);
			}
			return {
				kind: 'append',
				document: address,
				bytes: copyBytes(bytes),
				takenAt: now(),
				// Never the outbox: these bytes came FROM the authority.
				outboxId: undefined,
			};
		},

		retire(address: string): DurableOp {
			retired.add(address);
			const entry = live.get(address);
			if (entry !== undefined) {
				live.delete(address);
				// Revocation: destroying the document detaches its listeners, so a
				// handle still held keeps an inert object whose writes reach no
				// storage and no wire.
				entry.doc.destroy();
			}
			return { kind: 'retire', document: address };
		},

		async states(): Promise<{ document: string; bytes: Uint8Array }[]> {
			// Every address the store holds bytes for: the durable chains, the
			// live documents, and anything still waiting in the queue.
			const addresses = new Set<string>(live.keys());
			for (const address of await readAddresses()) addresses.add(address);
			for (const address of controller.pendingDocuments()) {
				addresses.add(address);
			}
			addresses.delete(appDocument);
			const sections: { document: string; bytes: Uint8Array }[] = [];
			for (const address of [...addresses].sort()) {
				if (retired.has(address)) continue;
				const entry = live.get(address);
				if (entry !== undefined) {
					sections.push({
						document: address,
						bytes: new Uint8Array(Y.encodeStateAsUpdateV2(entry.doc)),
					});
					continue;
				}
				const chain = [
					...(await readDocument(address)),
					...controller.pendingAppends(address),
				];
				if (chain.length === 0) continue;
				// SAFETY: the length check above proves the element exists, and
				// `copyBytes` returns freshly allocated `Uint8Array<ArrayBuffer>`s,
				// which is the buffer shape `mergeUpdatesV2`'s typing demands.
				sections.push({
					document: address,
					bytes:
						chain.length === 1
							? copyBytes(chain[0] as Uint8Array)
							: new Uint8Array(
									Y.mergeUpdatesV2(
										chain.map(copyBytes) as Uint8Array<ArrayBuffer>[],
									),
								),
				});
			}
			return sections;
		},

		destroy(): void {
			for (const entry of live.values()) entry.doc.destroy();
			live.clear();
		},
	};

	async function readAddresses(): Promise<string[]> {
		try {
			return await listDocuments();
		} catch (cause) {
			log.error(DocumentError.HydrationFailed({ address: '*', cause }).error);
			return [];
		}
	}
}
