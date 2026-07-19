/**
 * The Bun host's own deployment transport, composed over the desktop
 * credential authority. Every outbound URL is host-constructed against the
 * authority's immutable `baseURL`; nothing here accepts a caller-supplied
 * destination. This is the only place in the desktop where a bearer is
 * attached to a request, which is what keeps WebView windows credential-free.
 */

import {
	type AuthFetch,
	type AuthFetchInput,
	fetchWithBearer,
	resolveTargetUrl,
} from '@epicenter/auth';
import type { DesktopAuthAuthority } from './desktop-auth-authority.ts';

export function createDesktopAuthorityFetch(
	desktopAuth: Pick<
		DesktopAuthAuthority,
		'authorize' | 'baseURL' | 'reportRejected'
	>,
	{
		fetch: fetchImpl = globalThis.fetch.bind(globalThis),
	}: { fetch?: AuthFetch } = {},
): AuthFetch {
	const epicenterOrigin = new URL(desktopAuth.baseURL).origin;

	async function fetchWithAuth(
		input: AuthFetchInput,
		init: RequestInit | undefined,
		providedAuthorization?: Awaited<ReturnType<typeof desktopAuth.authorize>>,
	) {
		let authorization = providedAuthorization;
		const response = await fetchWithBearer({
			input,
			init,
			fetch: fetchImpl,
			baseURL: desktopAuth.baseURL,
			epicenterOrigin,
			resolveToken: async () => {
				authorization ??= await desktopAuth.authorize();
				return authorization.status === 'authorized'
					? authorization.accessToken
					: null;
			},
		});
		return { authorization, response };
	}

	return async (input, init) => {
		const first = await fetchWithAuth(input, init);
		if (
			first.response.status !== 401 ||
			resolveTargetUrl(input, desktopAuth.baseURL)?.origin !== epicenterOrigin
		) {
			return first.response;
		}

		const refreshed = await desktopAuth.authorize({ forceRefresh: true });
		if (refreshed.status !== 'authorized') return first.response;
		const retry = await fetchWithAuth(input, init, refreshed);
		if (retry.response.status === 401) {
			desktopAuth.reportRejected(refreshed.tokenGeneration);
		}
		return retry.response;
	};
}
