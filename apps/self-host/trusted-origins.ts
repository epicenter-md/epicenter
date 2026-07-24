/**
 * The self-host instance trust policy, shared by both runtime entries
 * (`server.ts` on Bun, `worker/index.ts` on Cloudflare) so the two cannot drift.
 *
 * `@epicenter/server` deliberately requires each deployable to declare its own
 * `resolveTrustedOrigins` rather than defaulting one: the set gates CORS, so
 * implicit trust is a security hole. A self-host trusts its OWN origin, the
 * Tauri desktop client, and exact operator-supplied browser origins, never
 * Epicenter cloud's domains.
 */
export function resolveSelfHostTrustedOrigins(
	baseURL: string,
	configuredOrigins = '',
): string[] {
	const origins = [new URL(baseURL).origin, 'tauri://localhost'];
	for (const candidate of configuredOrigins.split(',')) {
		const value = candidate.trim();
		if (value === '') continue;
		origins.push(parseExactOrigin(value));
	}
	return [...new Set(origins)];
}

/**
 * Accept only a value a browser could actually put in an `Origin` header, since
 * that header is the only thing the CORS middleware ever compares this set
 * against. Two rules together:
 *
 * 1. `new URL(value).origin` must round-trip back to the input. This rejects
 *    paths, queries, fragments, embedded credentials, a trailing slash, an
 *    explicit default port, an uppercase scheme or host, and opaque origins
 *    (which stringify to `null`), all as one equality.
 * 2. The scheme must be `http:` or `https:` and the host must carry no `*`.
 *    Round-tripping alone is not enough: `https://*.example.com` and
 *    `ws://host` are both valid URLs whose origin equals the input, so rule 1
 *    would take them and then silently never match a real request. An operator
 *    who tries a wildcard deserves a boot failure telling them wildcards are
 *    unsupported, not an entry that quietly does nothing.
 */
function parseExactOrigin(value: string): string {
	const rejected = new Error(
		`TRUSTED_BROWSER_ORIGINS must contain exact origins, received '${value}'`,
	);
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw rejected;
	}
	const isBrowserOrigin =
		(parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
		!parsed.host.includes('*');
	if (!isBrowserOrigin || parsed.origin !== value) throw rejected;
	return parsed.origin;
}
