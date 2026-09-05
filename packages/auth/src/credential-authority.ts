import type { SyncRefusal } from '@epicenter/sync/auth-subprotocol';

/** A transient bearer grant or the typed reason a transport cannot receive one. */
export type BearerAuthorization =
	| {
			status: 'authorized';
			accessToken: string;
			tokenGeneration: number;
	  }
	| {
			status: 'denied';
			code: SyncRefusal;
	  };
