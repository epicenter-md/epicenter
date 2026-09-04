import { createSameOriginCookieAuth } from '@epicenter/auth';
import { fromAuth } from '@epicenter/auth/svelte';

// The dashboard is served by the API at the same origin (api.epicenter.so/dashboard),
// so it authenticates with the first-party Better Auth session cookie rather than
// running PKCE against its own origin. See createSameOriginCookieAuth. The default
// callbackURL (the current path) returns the user to where they were after sign-in.
export const authClient = createSameOriginCookieAuth({
	baseURL: window.location.origin,
});

// Boot code takes `authClient`; a component that must track takes `auth`.
export const auth = fromAuth(authClient);

if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		authClient[Symbol.dispose]();
	});

	// `accept` is what makes the `dispose` run. Vite disposes only the module an
	// update was ACCEPTED at, so a leaf with a disposer and no accept is never
	// one: the update walks up to the nearest self-accepting importer and that
	// module's disposer runs instead, leaving this client's credential
	// authority alive beside its replacement. Invalidating immediately hands
	// the update back up exactly as before, with this leaf released first.
	import.meta.hot.accept(() => import.meta.hot?.invalidate());
}
