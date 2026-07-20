/**
 * Merge the room and row-document `WebSocketHandler`s into the one handler
 * `Bun.serve` accepts, dispatching each socket to its owner by the `surface` tag
 * on `ws.data`.
 *
 * `Bun.serve` accepts exactly ONE `websocket` handler, but a Bun host that
 * serves both surfaces needs both on one port and one server. Each backend owns
 * a disjoint `ws.data` shape and its own coordinator state, so this merge reads
 * the tag stamped at `server.upgrade` time and forwards every lifecycle callback
 * to the one handler that owns that socket.
 *
 * This is a two-surface merge on purpose, not a generic N-way router: a Bun
 * instance has exactly these two WebSocket surfaces, and a third one earns a new
 * ADR, not another map entry. Both backends bind the SAME `Server` (`bindServer`
 * on each) so their respective `handleUpgrade`/`fetch` calls upgrade onto the one
 * Bun server this merged handler drives.
 */

import type { ServerWebSocket, WebSocketHandler } from 'bun';
import type { BunWorkspaceDocumentSocketData } from './records/current-state-bun.js';
import type { BunRoomSocketData } from './room/backends/bun/registry.js';

/** The two disjoint `ws.data` shapes this merged handler dispatches between. */
export type MergedSocketData =
	| BunRoomSocketData
	| BunWorkspaceDocumentSocketData;

/**
 * Build the one `WebSocketHandler` that routes each socket to its owning backend
 * by the `surface` tag `server.upgrade` stamped onto `ws.data`. Each backend
 * handler expects its own concrete `ws.data`, not the union, so `pick` reads the
 * tag and hands the socket to that backend's handler as its own type: this
 * function owns that one narrowing so each caller passes its two typed handlers
 * directly.
 */
export function mergeBunWebSocketHandlers(handlers: {
	rooms: WebSocketHandler<BunRoomSocketData>;
	documents: WebSocketHandler<BunWorkspaceDocumentSocketData>;
}): WebSocketHandler<MergedSocketData> {
	const pick = (
		ws: ServerWebSocket<MergedSocketData>,
	): WebSocketHandler<MergedSocketData> =>
		(ws.data.surface === 'rooms'
			? handlers.rooms
			: handlers.documents) as WebSocketHandler<MergedSocketData>;

	return {
		open(ws) {
			pick(ws).open?.(ws);
		},
		message(ws, message) {
			pick(ws).message?.(ws, message);
		},
		close(ws, code, reason) {
			pick(ws).close?.(ws, code, reason);
		},
		drain(ws) {
			pick(ws).drain?.(ws);
		},
		ping(ws, data) {
			pick(ws).ping?.(ws, data);
		},
		pong(ws, data) {
			pick(ws).pong?.(ws, data);
		},
	};
}
