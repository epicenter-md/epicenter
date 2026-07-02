import { createWebStoragePersistedAuthStorage } from '@epicenter/auth';
import { createTauriDeepLinkOAuthLauncher } from '@epicenter/auth/oauth-launchers/tauri';
import {
	EPICENTER_HONEYCRISP_OAUTH_CLIENT_ID,
	EPICENTER_HONEYCRISP_TAURI_OAUTH_REDIRECT_URI,
} from '@epicenter/constants/oauth-clients';
import { APP_URLS } from '@epicenter/constants/vite';
import { createAppAuthClient } from '@epicenter/svelte/auth';
import { instanceSetting } from '$lib/instance';
import type { PlatformAuth } from './types';

// Hosted OAuth uses the hosted API even when the selected workspace sync target
// is self-hosted. The persisted instance setting only decides whether the auth
// client uses hosted OAuth or an operator token.
export const auth: PlatformAuth = createAppAuthClient(instanceSetting.read(), {
	clientId: EPICENTER_HONEYCRISP_OAUTH_CLIENT_ID,
	persistedAuthStorage: createWebStoragePersistedAuthStorage({
		key: 'honeycrisp.auth.persisted',
		storage: window.localStorage,
	}),
	launcher: createTauriDeepLinkOAuthLauncher({
		issuer: `${APP_URLS.API}/auth`,
		clientId: EPICENTER_HONEYCRISP_OAUTH_CLIENT_ID,
		resource: APP_URLS.API,
		redirectUri: EPICENTER_HONEYCRISP_TAURI_OAUTH_REDIRECT_URI,
		// The OAuth callback may cold-start the app, so localStorage keeps the
		// PKCE transaction alive across the browser-to-app round trip.
		storage: window.localStorage,
	}),
});

if (import.meta.hot) {
	import.meta.hot.dispose(() => auth[Symbol.dispose]());
}
