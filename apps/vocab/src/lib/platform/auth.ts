import { createHostedBrowserRedirectAuth } from '@epicenter/auth';
import { fromAuth } from '@epicenter/auth/svelte';
import { EPICENTER_VOCAB_OAUTH_CLIENT_ID } from '@epicenter/constants/oauth-clients';
import { APP_URLS } from '@epicenter/constants/vite';

export const auth = fromAuth(
	createHostedBrowserRedirectAuth({
		namespace: 'vocab',
		clientId: EPICENTER_VOCAB_OAUTH_CLIENT_ID,
		api: APP_URLS.API,
	}),
);

if (import.meta.hot) {
	import.meta.hot.dispose(() => auth[Symbol.dispose]());
}
