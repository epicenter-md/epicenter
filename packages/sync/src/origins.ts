/**
 * Transport origin sentinels for Yjs sync.
 *
 * Canonical definitions live here because every transport that touches a
 * shared Y.Doc must agree on them. When the WebSocket handler applies a
 * remote update, it tags it with `SYNC_ORIGIN`; the BroadcastChannel handler
 * tags cross-tab updates with `BC_ORIGIN`. Handlers check origins to avoid
 * echo loops (e.g., BC must not re-broadcast what it just received from WS,
 * and vice versa).
 *
 * Historically each transport defined its own symbol locally, which meant
 * two separate symbols for the same semantic "this update came from the
 * server" concept: fine as long as only one transport existed per Y.Doc,
 * risky once multiple layers could attach. These exports make the contract
 * explicit and unambiguous.
 *
 * **Not here**: self-loop guards that never leave their defining module
 * (`DEDUP_ORIGIN` in y-keyvalue-lww.ts, `REENCRYPT_ORIGIN` in
 * y-keyvalue-lww-encrypted.ts). Those are genuinely private and don't
 * benefit from sharing.
 */

/** Origin for updates applied from the WebSocket sync transport. */
export const SYNC_ORIGIN = Symbol.for('@epicenter/sync/sync-origin');

/** Origin for updates applied from BroadcastChannel cross-tab sync. */
export const BC_ORIGIN = Symbol.for('@epicenter/sync/bc-origin');

/**
 * Origins that mean a realtime transport already applied this update locally.
 *
 * Realtime transport listeners use this list to avoid forwarding an update
 * back through another realtime transport.
 */
const TRANSPORT_ORIGINS = [
	SYNC_ORIGIN,
	BC_ORIGIN,
] as const satisfies readonly unknown[];

export function isTransportOrigin(origin: unknown): boolean {
	return (
		typeof origin === 'symbol' &&
		TRANSPORT_ORIGINS.some((transportOrigin) => transportOrigin === origin)
	);
}
