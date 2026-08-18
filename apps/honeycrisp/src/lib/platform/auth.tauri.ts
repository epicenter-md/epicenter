import {
	type AuthClient,
	createSerializedPersistedAuthStorage,
} from '@epicenter/auth';
import {
	EPICENTER_HONEYCRISP_OAUTH_CLIENT_ID,
	EPICENTER_HONEYCRISP_TAURI_OAUTH_REDIRECT_URI,
} from '@epicenter/constants/oauth-clients';
import { APP_URLS } from '@epicenter/constants/vite';
import { createHostedDeepLinkAuth } from '@epicenter/svelte/auth/tauri';
import { invoke } from '@tauri-apps/api/core';
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import { createLogger } from 'wellcrafted/logger';
import { tryAsync } from 'wellcrafted/result';
import { instanceSetting } from '$lib/instance';

const log = createLogger('honeycrisp/platform/auth');

const KeyringError = defineErrors({
	ReadFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to read from the OS keyring: ${extractErrorMessage(cause)}`,
		cause,
	}),
	WriteFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to write to the OS keyring: ${extractErrorMessage(cause)}`,
		cause,
	}),
});

/**
 * Strict like the `localStorage` adapter's `set`: a grant that could not be
 * persisted must fail the sign-in or refresh that produced it, not silently
 * look saved.
 */
async function writeGrant(serialized: string | null): Promise<void> {
	const { error } = await tryAsync({
		try: () => invoke('keyring_write', { value: serialized }),
		catch: (cause) => KeyringError.WriteFailed({ cause }),
	});
	if (error !== null) throw error;
}

declare global {
	interface Window {
		__EPICENTER_HONEYCRISP_AUTH_BOOTSTRAP__?: {
			serialized: string | null;
			error: string | null;
		};
	}
}

const bootstrap = window.__EPICENTER_HONEYCRISP_AUTH_BOOTSTRAP__;
if (!bootstrap) {
	throw new Error('Honeycrisp did not preload its credential store.');
}
delete window.__EPICENTER_HONEYCRISP_AUTH_BOOTSTRAP__;
// Tolerant like the localStorage adapter's read: a locked or unavailable
// keychain starts signed out, and the next sign-in re-establishes the grant.
if (bootstrap.error !== null) {
	log.warn(KeyringError.ReadFailed({ cause: new Error(bootstrap.error) }));
}

export const auth: AuthClient = createHostedDeepLinkAuth({
	instanceSetting,
	clientId: EPICENTER_HONEYCRISP_OAUTH_CLIENT_ID,
	redirectUri: EPICENTER_HONEYCRISP_TAURI_OAUTH_REDIRECT_URI,
	api: APP_URLS.API,
	persistedAuthStorage: createSerializedPersistedAuthStorage({
		initial: bootstrap.serialized,
		write: writeGrant,
	}),
});

if (import.meta.hot) {
	import.meta.hot.dispose(() => auth[Symbol.dispose]());
}
