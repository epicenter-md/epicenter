/**
 * `@epicenter/sync`: WebSocket subprotocol auth.
 *
 * A browser `WebSocket` cannot set request headers, so a bearer credential
 * rides the subprotocol list instead: the client offers `epicenter` plus
 * `bearer.<token>`, and the server extracts the token and echoes back only the
 * main subprotocol. These constants and helpers are the one vocabulary the
 * client and server halves of that handshake must agree on.
 *
 * The Yjs sync wire protocol this package was named for is gone (ADR-0166).
 * The attach relay (ADR-0115) is the only remaining WebSocket surface, and it
 * forwards opaque bytes rather than framing document updates.
 */

export {
	BEARER_SUBPROTOCOL_PREFIX,
	isOpenWebSocketDenial,
	MAIN_SUBPROTOCOL,
	type OpenWebSocketDenial,
	parseSubprotocols,
} from './auth-subprotocol';
