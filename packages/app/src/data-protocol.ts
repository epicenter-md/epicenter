/**
 * @fileoverview The data operations this client speaks, and the shapes they carry.
 *
 * Declared here rather than imported, for the same reason `protocol.ts` names
 * the host commands by hand. `@epicenter/data` owns the runtime that answers
 * these operations, and that runtime is SQLite, Yjs, a replica, and a sync
 * supervisor. This package is MIT, compiled, and handed to strangers; depending
 * on that closure to reuse eleven type aliases would be paying a very large
 * price for a very small saving.
 *
 * So the vocabulary is small, deliberately chosen, and proved rather than
 * assumed: `apps/epicenter` carries a drift test that checks every operation
 * kind and every field below against the host's own protocol, in both
 * directions. A field that appears on one side and not the other fails a test
 * rather than failing at runtime in someone's app.
 *
 * What is deliberately absent: row documents. They are Yjs, and a client that
 * cannot depend on the replica runtime cannot honestly hand out a `Y.Doc`.
 */

/** Where the host answers data operations, relative to the Epicenter origin. */
export const DATA_ROUTE = '/api/data';

/** Where the host publishes committed addresses, on the same origin. */
export const DATA_OBSERVE_ROUTE = '/api/data/observe';

/** One table definition, projected to JSON for the wire. */
export type WireTableDefinition = {
	namespace: string;
	table: string;
	fields: Record<string, unknown>;
	optionalFields: string[];
};

/** One value address, which is also the value's whole identity. */
export type WireValueAddress = {
	kind: 'value';
	namespace: string;
	valueName: string;
};

/** One row address. */
export type WireRowAddress = {
	kind: 'row';
	namespace: string;
	tableName: string;
	rowId: string;
};

export type WireAddress = WireRowAddress | WireValueAddress;

/** One value definition, projected to JSON for the wire. */
export type WireValueDefinition = {
	address: WireValueAddress;
	value: unknown;
};

/** Every operation an installed app may ask the host to perform on its data. */
export type WireDataOperation =
	| { kind: 'open' }
	| { kind: 'disconnect' }
	| {
			kind: 'table-create';
			definition: WireTableDefinition;
			fields: Record<string, unknown>;
	  }
	| {
			kind: 'table-get';
			definition: WireTableDefinition;
			address: WireRowAddress;
	  }
	| {
			kind: 'table-update';
			definition: WireTableDefinition;
			address: WireRowAddress;
			patch: Record<string, unknown>;
	  }
	| {
			kind: 'table-delete';
			definition: WireTableDefinition;
			address: WireRowAddress;
	  }
	| {
			kind: 'table-entries-page';
			definition: WireTableDefinition;
			after?: string;
	  }
	| {
			kind: 'value-get';
			definition: WireValueDefinition;
			address: WireValueAddress;
	  }
	| {
			kind: 'value-set';
			definition: WireValueDefinition;
			address: WireValueAddress;
			value: unknown;
	  }
	| {
			kind: 'value-unset';
			definition: WireValueDefinition;
			address: WireValueAddress;
	  };

/** The envelope every data operation answers with. */
export type WireDataResponse =
	| { data: unknown; error: null }
	| { data: null; error: { name: string; message: string } };

/**
 * One committed batch of addresses, forwarded whole.
 *
 * The wire says which addresses moved and nothing else. It does not encode
 * reconnection, reset, table scope, or a cursor: only the client knows which
 * handles it was holding across a gap, so recovering from one is its job.
 */
export type WireInvalidationFrame = {
	type: 'invalidation';
	changes: WireAddress[];
};

/**
 * One page of a table traversal, in stable row-ID order.
 *
 * Each entry is already an ordinary `Result` when it arrives: the host
 * classifies a row it could not project as an error rather than dropping it, so
 * paging never silently loses the rows a Lens cannot interpret.
 */
export type WireEntriesPage = {
	entries: unknown[];
	nextAfter?: string;
};
