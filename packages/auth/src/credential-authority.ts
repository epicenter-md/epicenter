/** A transient bearer grant or the typed reason a transport cannot receive one. */
export type BearerAuthorization =
	| {
			status: 'authorized';
			accessToken: string;
			tokenGeneration: number;
	  }
	| {
			status: 'denied';
			permanence: 'permanent' | 'transient';
			code: 'signed-out' | 'reauth-required' | 'auth-unavailable';
	  };
