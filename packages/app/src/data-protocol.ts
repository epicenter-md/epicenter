/**
 * @fileoverview The data operations this client speaks, and where it sends them.
 *
 * The vocabulary an operation carries, addresses and serialized definitions, is
 * `@epicenter/lens`. That is the contract package an app author already imports
 * to declare a Lens, and this client already depends on it, so redeclaring its
 * types here would be a second structural copy that compiles cleanly while
 * drifting.
 *
 * What is declared here is the operation union, the response envelope, and the
 * two routes. Those belong to the runtime that answers them, and that runtime is
 * `@epicenter/data`: SQLite, Yjs, a replica, and a sync supervisor. This package
 * is MIT, compiled, and handed to strangers, so it names what it sends rather
 * than importing it. The refusal is of the dependency, not of shared vocabulary.
 *
 * The naming is checked by being used: `apps/epicenter/src/app-client-data-parity.test.ts`
 * drives the published client through real same-origin HTTP and a real socket
 * into the host's own data owner, and asserts on what the host actually did. An
 * operation the host would not accept, or would interpret differently, fails
 * there rather than in someone's app.
 *
 * That is acceptance and interpretation, not a field-by-field comparison of the
 * two declarations. A field this client never sends is outside what driving it
 * can observe, so adding one still needs its own coverage.
 *
 * What is deliberately absent: row documents. They are Yjs, and a client that
 * cannot depend on the replica runtime cannot honestly hand out a `Y.Doc`.
 */

import type {
	RowAddress,
	SerializedTableDefinition,
} from '@epicenter/lens';

/** Where the host answers data operations, relative to the Epicenter origin. */
export const DATA_ROUTE = '/api/data';

/**
 * Where the host publishes committed addresses, on the same origin.
 *
 * One socket per document, carrying `ObservationFrame`s and nothing else.
 * `@epicenter/lens` owns that frame and the carrier that reads it.
 */
export const DATA_OBSERVE_ROUTE = '/api/data/observe';

/** Every operation an installed app may ask the host to perform on its data. */
export type WireDataOperation =
	| { kind: 'open' }
	| { kind: 'disconnect' }
	| {
			kind: 'table-create';
			definition: SerializedTableDefinition;
			rowId?: string;
			fields: Record<string, unknown>;
	  }
	| {
			kind: 'table-get';
			definition: SerializedTableDefinition;
			address: RowAddress;
	  }
	/**
	 * An update names what to write and what to remove, rather than carrying one
	 * patch object with `undefined` holes in it. `JSON.stringify` drops a key
	 * whose value is `undefined`, so a patch that meant "remove this optional
	 * field" would arrive meaning nothing at all, and the field would silently
	 * survive.
	 */
	| {
			kind: 'table-update';
			definition: SerializedTableDefinition;
			address: RowAddress;
			set: Record<string, unknown>;
			unset: string[];
	  }
	| {
			kind: 'table-delete';
			definition: SerializedTableDefinition;
			address: RowAddress;
	  }
	| {
			kind: 'table-entries-page';
			definition: SerializedTableDefinition;
			after?: string;
	  }
	;

/** The envelope every data operation answers with. */
export type WireDataResponse =
	| { data: unknown; error: null }
	| { data: null; error: { name: string; message: string } };

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
