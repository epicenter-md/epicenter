/**
 * `@epicenter/sync`: WebSocket subprotocol auth.
 *
 * A browser `WebSocket` cannot set request headers, so a bearer credential
 * rides the subprotocol list instead: the client offers `epicenter` plus
 * `bearer.<token>`, and the server extracts the token and echoes back only the
 * main subprotocol. These constants and helpers are the one vocabulary the
 * client and server halves of that handshake must agree on.
 *
 * The package exports the vocabulary shared by browser and server store-sync
 * upgrades.
 */

export {
	BEARER_SUBPROTOCOL_PREFIX,
	isOpenWebSocketDenial,
	MAIN_SUBPROTOCOL,
	type OpenWebSocketDenial,
	parseSubprotocols,
} from './auth-subprotocol';
export {
	GENERATIONS_ROUTE,
	LOG_POSITION_HEADER,
} from './generations-route.js';
export { DATA_ID, STORE_SYNC_ROUTE } from './store-route.js';
