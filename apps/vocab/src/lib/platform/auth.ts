import { EPICENTER_VOCAB_OAUTH_CLIENT_ID } from '@epicenter/constants/oauth-clients';
import { APP_URLS } from '@epicenter/constants/vite';
import { createHostedBrowserRedirectAuth } from '@epicenter/auth/svelte';
import { instanceSetting } from '$lib/instance';

export const auth = createHostedBrowserRedirectAuth({
	instanceSetting,
	namespace: 'vocab',
	clientId: EPICENTER_VOCAB_OAUTH_CLIENT_ID,
	api: APP_URLS.API,
});

if (import.meta.hot) {
	import.meta.hot.dispose(() => auth[Symbol.dispose]());
}
