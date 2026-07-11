import { createSerializedPersistedAuthStorage } from '@epicenter/auth';
import {
	EPICENTER_DESKTOP_OAUTH_CLIENT_ID,
	EPICENTER_DESKTOP_TAURI_OAUTH_REDIRECT_URI,
} from '@epicenter/constants/oauth-clients';
import { APP_URLS } from '@epicenter/constants/vite';
import { createHostedDeepLinkAuth } from '@epicenter/svelte/auth/tauri';
import { createLogger } from 'wellcrafted/logger';
import { instanceSetting } from '$lib/instance';
import { commands } from '$lib/tauri/commands';
import type { WhisperingAuth } from '$lib/environment/contract';

const log = createLogger('whispering/runtime/auth');

declare global {
	interface Window {
		__EPICENTER_WHISPERING_AUTH_BOOTSTRAP__?: {
			serialized: string | null;
			error: string | null;
		};
	}
}

/**
 * Strict like the `localStorage` adapter's `set`: a grant that could not be
 * persisted must fail the sign-in or refresh that produced it, not silently
 * look saved.
 */
async function writeGrant(serialized: string | null): Promise<void> {
	const { error } = await commands.keyringWrite(serialized);
	if (error !== null) {
		throw new Error(`Failed to write to the OS keyring: ${error}`);
	}
}

const bootstrap = window.__EPICENTER_WHISPERING_AUTH_BOOTSTRAP__;
if (!bootstrap) {
	throw new Error('Epicenter did not preload the Whispering credential store.');
}
delete window.__EPICENTER_WHISPERING_AUTH_BOOTSTRAP__;
if (bootstrap.error !== null) log.warn(new Error(bootstrap.error));

export const auth: WhisperingAuth = createHostedDeepLinkAuth({
	instanceSetting,
	clientId: EPICENTER_DESKTOP_OAUTH_CLIENT_ID,
	redirectUri: EPICENTER_DESKTOP_TAURI_OAUTH_REDIRECT_URI,
	api: APP_URLS.API,
	persistedAuthStorage: createSerializedPersistedAuthStorage({
		initial: bootstrap.serialized,
		write: writeGrant,
	}),
});

if (import.meta.hot) {
	import.meta.hot.dispose(() => auth[Symbol.dispose]());
}
