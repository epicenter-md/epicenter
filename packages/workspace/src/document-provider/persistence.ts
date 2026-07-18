import type * as Y from '@y/y';

/** Stable row identity shared by metadata and document providers. */
export type RowAddress = {
	table: string;
	rowId: string;
};

/** One attached document's local persistence lifetime. */
export type DocumentPersistenceLease = {
	/** Resolves after persisted state has been replayed into the document. */
	whenLoaded: Promise<void>;
	/** Waits for the transaction-complete persistence cut captured by this call. */
	whenDurable(): Promise<void>;
	/** Stops persistence after every update already observed has committed. */
	dispose(): Promise<void>;
};

/** Workspace-scoped persistence for independently loadable row documents. */
export type DocumentStore = {
	/** Attach one live Yjs document to its durable update log. */
	attach(address: RowAddress, document: Y.Doc): DocumentPersistenceLease;
	/** Capture the current durable document state without opening a live lease. */
	capture(address: RowAddress): Promise<Uint8Array | undefined>;
	/** Delete one closed document's durable update log. */
	delete(address: RowAddress): Promise<void>;
	/** Delete every closed document update log in this workspace store. */
	deleteAll(): Promise<void>;
};
