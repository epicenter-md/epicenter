import type {
	SerializedTableDefinition,
	SerializedValueDefinition,
} from '@epicenter/lens';
import type {
	DocumentPublishOutcome,
	DocumentPullResponse,
} from '../documents.js';

export type {
	SerializedTableDefinition,
	SerializedValueDefinition,
} from '@epicenter/lens';

import type {
	Address,
	ExchangeRequest,
	ExchangeResponse,
	JsonValue,
	RowAddress,
	ValueAddress,
} from '../protocol/index.js';
import type { SyncState } from '../sync-supervisor.js';

/**
 * One network call the worker asks the sync-attached page to perform on its
 * behalf. The page owns credentials and fetch; the worker owns the replica,
 * the documents, and every synchronization decision.
 */
export type SessionTransportRequest =
	| { kind: 'exchange'; request: ExchangeRequest }
	| { kind: 'document-publish'; address: RowAddress; update: Uint8Array }
	| {
			kind: 'document-pull';
			address: RowAddress;
			sinceVersion: string | undefined;
	  };

export type SessionTransportResponse =
	| { kind: 'exchange'; response: ExchangeResponse }
	| { kind: 'document-publish'; outcome: DocumentPublishOutcome }
	| { kind: 'document-pull'; response: DocumentPullResponse };

export type BrowserOperation =
	| { kind: 'open' }
	| {
			kind: 'table-create';
			definition: SerializedTableDefinition;
			fields: Record<string, unknown>;
	  }
	| {
			kind: 'table-get';
			definition: SerializedTableDefinition;
			address: RowAddress;
	  }
	| {
			kind: 'table-update';
			definition: SerializedTableDefinition;
			address: RowAddress;
			patch: Record<string, unknown>;
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
	| {
			kind: 'value-get';
			definition: SerializedValueDefinition;
			address: ValueAddress;
	  }
	| {
			kind: 'value-set';
			definition: SerializedValueDefinition;
			address: ValueAddress;
			value: JsonValue;
	  }
	| {
			kind: 'value-unset';
			definition: SerializedValueDefinition;
			address: ValueAddress;
	  }
	| {
			kind: 'document-open';
			definition: SerializedTableDefinition;
			address: RowAddress;
	  }
	| { kind: 'document-update'; documentId: number; update: Uint8Array }
	| { kind: 'document-pull'; documentId: number }
	| { kind: 'document-issue'; documentId: number }
	| { kind: 'document-close'; documentId: number }
	| {
			kind: 'attach-sync';
			transportKey: number;
			deploymentId: string;
			principalId: string;
			hasCredentials: boolean;
			canPublishDocuments: boolean;
			canPullDocuments: boolean;
	  }
	| { kind: 'sync-credentials'; transportKey: number; hasCredentials: boolean }
	| { kind: 'disconnect' };

export type BrowserRequest = {
	type: 'request';
	id: number;
	operation: BrowserOperation;
};

export type BrowserTransportResult =
	| {
			type: 'transport-result';
			transportId: number;
			transportKey: number;
			response: SessionTransportResponse;
	  }
	| {
			type: 'transport-error';
			transportId: number;
			transportKey: number;
			name: string;
			message: string;
	  };

export type BrowserWorkerInbound = BrowserRequest | BrowserTransportResult;

/**
 * One committed replica notification, forwarded whole.
 *
 * The frame carries the batch the replica emitted, not one message per address.
 * A commit installing sixty-four rows crosses the port once, and the page's
 * dispatcher is what turns it into at most one call per affected handle. Per
 * address frames would have made a batched commit look like sixty-four
 * independent commits to every listener downstream.
 */
export type BrowserInvalidation = {
	type: 'invalidation';
	changes: readonly Address[];
};

export type BrowserWorkerMessage =
	| { type: 'result'; id: number; value: unknown }
	| { type: 'error'; id: number; name: string; message: string }
	| BrowserInvalidation
	| {
			type: 'document-update';
			documentId: number;
			update: Uint8Array;
	  }
	| {
			type: 'document-revoked';
			documentId: number;
			message: string;
	  }
	| {
			type: 'sync-status';
			state: SyncState;
			lastError?: string;
	  }
	| {
			type: 'transport-request';
			transportId: number;
			transportKey: number;
			request: SessionTransportRequest;
	  }
	| {
			type: 'transport-cancel';
			transportId: number;
			transportKey: number;
	  };
