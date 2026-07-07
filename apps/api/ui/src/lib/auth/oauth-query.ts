/**
 * The signed OAuth params from Better Auth's authorize redirect.
 *
 * When a user lands on `/sign-in` or `/consent` mid-OAuth-flow, the URL
 * carries the original authorize query plus a `sig` signature. Sending the
 * whole query back as `oauth_query` lets Better Auth's after-hook continue
 * the OAuth flow once the user authenticates or consents. Absent `sig`, the
 * visit is a plain sign-in and no `oauth_query` is sent.
 */
export function getOAuthQuery(): string | undefined {
	const params = new URLSearchParams(window.location.search);
	return params.has('sig') ? params.toString() : undefined;
}
