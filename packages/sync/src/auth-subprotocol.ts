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
 * Why a credential model refused to open a socket.
 *
 * A closed union so a status surface can map every arm exhaustively.
 */
export type SyncRefusal =
	/** No credential is held on this device. */
	| 'signed-out'
	/** The server refused the credential; only a sign-in produces a new one. */
	| 'reauth-required'
	/** The credential could not be verified right now; the next try may succeed. */
	| 'auth-unavailable'
	/** This client can never open a socket: a same-origin cookie, a desktop window. */
	| 'no-credential-model';

/**
 * Rejection an auth-owned `openWebSocket` throws when it refuses to open a
 * socket because no usable bearer can be attached right now.
 *
 * `code` says which refusal it is, and that is the whole of it. A refusal is
 * not a stop signal: the sync driver reports it as data on its status and
 * dials again on its ordinary backoff. Every arm but `'auth-unavailable'` is
 * decided locally with no request on the wire, so a dial capped at thirty
 * seconds costs a status read and nothing else.
 *
 * Declared here, beside the subprotocol carrier, because it is the other half
 * of the same client-side transport contract: `@epicenter/auth` constructs it
 * and the sync supervisor classifies it, and both already depend on this
 * package.
 */
export type OpenWebSocketDenial = {
	name: 'OpenWebSocketDenied';
	message: string;
	code: SyncRefusal;
};

const SYNC_REFUSALS: readonly SyncRefusal[] = [
	'signed-out',
	'reauth-required',
	'auth-unavailable',
	'no-credential-model',
];

/** Classify an unknown rejection as an {@link OpenWebSocketDenial}. */
export function isOpenWebSocketDenial(
	value: unknown,
): value is OpenWebSocketDenial {
	if (typeof value !== 'object' || value === null) return false;
	const candidate = value as Partial<OpenWebSocketDenial>;
	return (
		candidate.name === 'OpenWebSocketDenied' &&
		SYNC_REFUSALS.includes(candidate.code as SyncRefusal)
	);
}
