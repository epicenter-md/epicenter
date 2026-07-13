import type { AuthState } from '@epicenter/auth';
import type { openWhisperingBrowser } from '$lib/workspace/browser';

/** The complete local-first product runtime, including while signed out. */
export type WhisperingWorkspace = ReturnType<typeof openWhisperingBrowser>;

export type AccountSession = Extract<AuthState, { status: 'signed-in' }>;

/** Remote resources created only below the authenticated account gate. */
export type AccountRuntime = {
	session: AccountSession;
};
