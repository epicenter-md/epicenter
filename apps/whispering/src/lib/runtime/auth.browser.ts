import { EPICENTER_WHISPERING_OAUTH_CLIENT_ID } from '@epicenter/constants/oauth-clients';
import { APP_URLS } from '@epicenter/constants/vite';
import { createHostedBrowserRedirectAuth } from '@epicenter/svelte/auth';
import { instanceSetting } from '$lib/instance';
import type { WhisperingAuth } from '$lib/environment/contract';

export const auth: WhisperingAuth = createHostedBrowserRedirectAuth({
	instanceSetting,
	namespace: 'whispering',
	clientId: EPICENTER_WHISPERING_OAUTH_CLIENT_ID,
	api: APP_URLS.API,
});

if (import.meta.hot) {
	import.meta.hot.dispose(() => auth[Symbol.dispose]());
}
