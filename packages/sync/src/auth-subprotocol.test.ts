/**
 * WebSocket Auth Subprotocol Tests
 *
 * Verifies the shared bearer subprotocol helpers used by auth clients and API
 * middleware.
 *
 * Key behaviors:
 * - Bearer prefix comes from the shared constants package
 * - Subprotocol headers parse into their comma-separated token list
 * - Formatting and parsing are inverses, so the client's offer and the
 *   server's read are the same list
 */

import { expect, test } from 'bun:test';
import {
	BEARER_SUBPROTOCOL_PREFIX,
	bearerSubprotocol,
	formatSubprotocols,
	MAIN_SUBPROTOCOL,
	parseSubprotocols,
} from './auth-subprotocol.js';

test('parseSubprotocols splits a comma-separated subprotocol header', () => {
	const header = `${MAIN_SUBPROTOCOL}, ${BEARER_SUBPROTOCOL_PREFIX}token-1`;

	expect(parseSubprotocols(header)).toEqual([
		MAIN_SUBPROTOCOL,
		`${BEARER_SUBPROTOCOL_PREFIX}token-1`,
	]);
});

test('formatSubprotocols and parseSubprotocols are inverses', () => {
	const offered = [MAIN_SUBPROTOCOL, bearerSubprotocol('token-1')];

	expect(parseSubprotocols(formatSubprotocols(offered))).toEqual(offered);
});
