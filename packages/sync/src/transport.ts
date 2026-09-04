/**
 * The client half of a store dial: what a socket is opened with, and who opens
 * it.
 *
 * A browser upgrade cannot set `Authorization`, so a dial is a URL and a
 * subprotocol list, and the two are one value here. The route builds the
 * address, auth appends the bearer entry, and a consumer imports this type
 * rather than declaring a narrower one (ADR-0346).
 */

/**
 * Everything a dial needs except the credential.
 *
 * `STORE_SYNC_ROUTE.address` builds it, an `openWebSocket` implementation
 * appends `bearerSubprotocol(token)` to `protocols`, and the server reads the
 * main subprotocol and the bearer back out of the one header.
 */
export type WebSocketAddress = {
	url: string;
	protocols: readonly string[];
};

/** How a host reaches its authority over a socket. */
export type SocketTransport = {
	/**
	 * Open a credentialed socket, or reject.
	 *
	 * Waits for in-flight machine work such as a token refresh, never for a
	 * human, so a rejection means signed out rather than slow. A rejection
	 * recognised by {@link isOpenWebSocketDenial} with `permanence: 'permanent'`
	 * stops the driver for good; anything else is a transient close.
	 */
	openWebSocket(address: WebSocketAddress): Promise<WebSocket>;
};

/**
 * Rejection an auth-owned `openWebSocket` throws when it refuses to open a
 * socket because no usable bearer can be attached right now.
 *
 * `permanence` carries the same semantics ADR-0095 gives the server's auth
 * close codes (4401 and 4503, which the store route does not send yet: it
 * still answers a refused upgrade with an HTTP status a browser cannot see),
 * so a sync host makes one stop-or-backoff decision for both failure
 * carriers:
 *
 * - `'permanent'`: only an auth state change can produce a credential (signed
 *   out, reauth required, a window that holds no credential at all). Report
 *   `denied` to the sync driver, which stops for good; an auth change reloads
 *   the app, and the next generation dials fresh. There is no in-place
 *   resume.
 * - `'transient'`: credential verification was unreachable; the grant may be
 *   perfectly good. Report `closed`; the driver backs off and retries.
 *
 * `code` names the specific refusal (`'signed-out'`, `'reauth-required'`,
 * `'auth-unavailable'`) for status surfaces and logs; consumers branch on
 * `permanence`, not `code`.
 *
 * Declared here, beside {@link SocketTransport}, because it is the other half
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
