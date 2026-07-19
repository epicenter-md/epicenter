/**
 * The Bun host's own deployment transport, composed over the desktop
 * credential authority. Every outbound URL is host-constructed against the
 * authority's immutable `baseURL`; nothing here accepts a caller-supplied
 * destination. This is the only place in the desktop where a bearer is
 * attached to a request, which is what keeps WebView windows credential-free.
 */

import type { AuthFetch } from '@epicenter/auth';
import type { DesktopAuthAuthority } from './desktop-auth-authority.ts';

export function createDesktopAuthorityFetch(
	desktopAuth: Pick<DesktopAuthAuthority, 'authorize' | 'reportRejected'>,
	{
		fetch: fetchImpl = globalThis.fetch.bind(globalThis),
	}: { fetch?: AuthFetch } = {},
): AuthFetch {
	async function fetchWithAuthorization(
		input: Request | string | URL,
		init: RequestInit | undefined,
		authorization: Awaited<ReturnType<typeof desktopAuth.authorize>>,
	) {
		if (authorization.status !== 'authorized') {
			// A bare request lets the deployment answer 401 itself, so callers
			// see the same typed failure shape as an expired bearer.
			return fetchImpl(input, init);
		}
		const headers = new Headers(
			init?.headers ?? (input instanceof Request ? input.headers : undefined),
		);
		headers.set('authorization', `Bearer ${authorization.accessToken}`);
		return fetchImpl(input, { ...init, headers });
	}

	return async (input, init) => {
		const first = await desktopAuth.authorize();
		const response = await fetchWithAuthorization(input, init, first);
		if (response.status !== 401) return response;

		const refreshed = await desktopAuth.authorize({ forceRefresh: true });
		if (refreshed.status !== 'authorized') return response;
		const retry = await fetchWithAuthorization(input, init, refreshed);
		if (retry.status === 401) {
			desktopAuth.reportRejected(refreshed.tokenGeneration);
		}
		return retry;
	};
}
