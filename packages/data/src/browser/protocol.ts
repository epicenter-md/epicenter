import type {
	DocumentAddress,
	DocumentPublishOutcome,
	DocumentPullResponse,
} from '../documents.js';
import type {
	ExchangeRequest,
	ExchangeResponse,
	JsonValue,
} from '../protocol/index.js';
import type { SyncState } from '../sync-supervisor.js';

/**
 * One network call the worker asks the sync-attached page to perform on its
 * behalf. The page owns credentials and fetch; the worker owns the replica,
 * the documents, and every synchronization decision.
 */
export type SessionTransportRequest =
	| { kind: 'exchange'; request: ExchangeRequest }
	| { kind: 'document-publish'; address: DocumentAddress; update: Uint8Array }
	| {
			kind: 'document-pull';
			address: DocumentAddress;
			sinceVersion: string | undefined;
	  };

export type SessionTransportResponse =
	| { kind: 'exchange'; response: ExchangeResponse }
	| { kind: 'document-publish'; outcome: DocumentPublishOutcome }
	| { kind: 'document-pull'; response: DocumentPullResponse };

export type SerializedTableDefinition = {
	key: string;
	fields: Record<string, unknown>;
	optionalFields: string[];
};

export type SerializedValueDefinition = {
	key: string;
	value: unknown;
};

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
			rowId: string;
	  }
	| {
			kind: 'table-update';
			definition: SerializedTableDefinition;
			rowId: string;
			patch: Record<string, unknown>;
	  }
	| {
			kind: 'table-delete';
			definition: SerializedTableDefinition;
			rowId: string;
	  }
	| {
			kind: 'table-entries-page';
			definition: SerializedTableDefinition;
			after?: string;
	  }
	| {
			kind: 'value-get';
			definition: SerializedValueDefinition;
	  }
	| {
			kind: 'value-set';
			definition: SerializedValueDefinition;
			value: JsonValue;
	  }
	| {
			kind: 'value-unset';
			definition: SerializedValueDefinition;
	  }
	| {
			kind: 'document-open';
			definition: SerializedTableDefinition;
			rowId: string;
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

export type BrowserInvalidation = {
	type: 'invalidation';
	token: string;
	change:
		| { kind: 'table'; key: string; rowIds: string[] }
		| { kind: 'value'; key: string };
	broadcast: boolean;
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
	  }
	| {
			type: 'transport-retire';
			transportKey: number;
	  }
	| { type: 'client-revoked'; name: string; message: string };

export type BrowserInvalidationSignal = Omit<BrowserInvalidation, 'broadcast'>;
