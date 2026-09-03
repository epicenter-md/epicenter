import { createSameOriginCookieAuth } from '@epicenter/auth';
import { fromAuth } from '@epicenter/auth/svelte';

// The dashboard is served by the API at the same origin (api.epicenter.so/dashboard),
// so it authenticates with the first-party Better Auth session cookie rather than
// running PKCE against its own origin. See createSameOriginCookieAuth. The default
// callbackURL (the current path) returns the user to where they were after sign-in.
export const auth = fromAuth(
	createSameOriginCookieAuth({
		baseURL: window.location.origin,
	}),
);

if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		auth[Symbol.dispose]();
	});
}
