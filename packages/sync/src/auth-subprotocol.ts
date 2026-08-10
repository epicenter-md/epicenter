/**
 * WebSocket subprotocol auth: shared client/server constants.
 *
 * Auth tokens travel inside the `Sec-WebSocket-Protocol` handshake header
 * as `bearer.<token>`, not in the URL's query string. The real threat is
 * server-side access logs (Cloudflare, Hono middleware, downstream APMs
 * like Sentry/Datadog): full URLs including query strings are captured by
 * default, so a `?token=` scheme leaks long-lived session tokens into any
 * system with log access. Subprotocol headers aren't captured by default
 * on those systems. The server extracts and consumes the bearer entry on
 * upgrade; only the main protocol name (`epicenter`) is echoed back on
 * the 101 response, so the token never round-trips.
 *
 * The `.` separator is required by RFC compliance: `Sec-WebSocket-Protocol`
 * values are RFC 7230 `token` productions, where `:` is not a valid `tchar`
 * but `.` is. Prior art for `<scheme>.<token>`: Phoenix channels
 * (`phx_bearer.<token>`), Supabase Realtime, and Kubernetes
 * (`base64url.bearer.authorization.k8s.io.<token>`).
 */

/** Primary subprotocol name every Epicenter client negotiates. */
export const MAIN_SUBPROTOCOL = 'epicenter';

/** Prefix for OAuth bearer tokens carried through WebSocket subprotocols. */
export const BEARER_SUBPROTOCOL_PREFIX = 'bearer.';

/**
 * Parse a `Sec-WebSocket-Protocol` header value into its list of tokens.
 *
 * RFC 6455 specifies the value as a comma-separated list of RFC 7230 tokens,
 * with optional whitespace after commas. Returns an empty list if the header
 * is absent.
 */
export function parseSubprotocols(header: string | null): string[] {
	if (!header) return [];
	return header.split(',').map((s) => s.trim());
}

/**
 * Rejection an auth-owned `openWebSocket` throws when it refuses to open a
 * socket because no usable bearer can be attached right now.
 *
 * `permanence` carries the same semantics as the server's auth close codes,
 * so a sync host makes one stop-or-backoff decision for both failure
 * carriers:
 *
 * - `'permanent'` (like close 4401): only an auth state change can produce a
 *   credential (signed out, reauth required, a window that holds no
 *   credential at all). Report `denied` to the sync driver, which stops for
 *   good; an auth change reloads the app, and the next generation dials
 *   fresh. There is no in-place resume.
 * - `'transient'` (like close 4503): credential verification was unreachable;
 *   the grant may be perfectly good. Report `closed`; the driver backs off
 *   and retries.
 *
 * `code` names the specific refusal (`'signed-out'`, `'reauth-required'`,
 * `'auth-unavailable'`) for status surfaces and logs; consumers branch on
 * `permanence`, not `code`.
 *
 * Declared here, beside the subprotocol carrier, because it is the other half
 * of the same client-side transport contract: `@epicenter/auth` constructs it
 * and the sync supervisor classifies it, and both already depend on this
 * package.
 */
export type OpenWebSocketDenial = {
	name: 'OpenWebSocketDenied';
	message: string;
	permanence: 'permanent' | 'transient';
	code: string;
};

/** Classify an unknown rejection as an {@link OpenWebSocketDenial}. */
export function isOpenWebSocketDenial(
	value: unknown,
): value is OpenWebSocketDenial {
	if (typeof value !== 'object' || value === null) return false;
	const candidate = value as Partial<OpenWebSocketDenial>;
	return (
		candidate.name === 'OpenWebSocketDenied' &&
		(candidate.permanence === 'permanent' ||
			candidate.permanence === 'transient') &&
		typeof candidate.code === 'string'
	);
}
