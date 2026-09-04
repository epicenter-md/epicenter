import { createHostedBrowserRedirectAuth } from '@epicenter/auth';
import { fromAuth } from '@epicenter/auth/svelte';
import { EPICENTER_WHISPERING_OAUTH_CLIENT_ID } from '@epicenter/constants/oauth-clients';
import { APP_URLS } from '@epicenter/constants/vite';
import { APP_ID } from '$lib/app-id';

export const authClient = createHostedBrowserRedirectAuth({
	appId: APP_ID,
	oauthClientId: EPICENTER_WHISPERING_OAUTH_CLIENT_ID,
	baseURL: APP_URLS.API,
});

// Boot code takes `authClient`; a component that must track takes `auth`.
export const auth = fromAuth(authClient);

if (import.meta.hot) {
	import.meta.hot.dispose(() => authClient[Symbol.dispose]());
}
