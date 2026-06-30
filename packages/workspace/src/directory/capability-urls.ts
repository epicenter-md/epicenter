/**
 * One box, one `baseUrl`. The capability surface a box serves is a fixed set of
 * path suffixes on that origin, never separately stored or separately
 * configured: `/mcp` (the box's tools, the only surface V0 builds) and `/v1`
 * (the box-local model proxy, a deferred sibling on the same origin). ADR-0079:
 * "capability reach = inference reach = the same `{baseUrl}`."
 *
 * Keeping derivation here, rather than letting each caller concatenate, means
 * the directory row stores exactly one address and every consumer agrees on
 * where the surfaces live. Pure: no I/O, no liveness, just string shape.
 */

/** Drop trailing slashes so `https://box/` and `https://box` derive the same suffixes. */
const stripTrailing = (s: string): string => s.replace(/\/+$/, '');

/** The capability surfaces a box serves, derived from its single stored `baseUrl`. */
export type CapabilityUrls = {
	/** The box's MCP tool endpoint (the only surface V0 builds). */
	mcp: string;
	/** The box-local OpenAI-compatible model proxy (deferred; reserved suffix). */
	v1: string;
};

/**
 * Derive a box's `{mcp, v1}` surfaces from its stored `baseUrl`. The suffixes
 * are append-only path segments on the same origin, so a box is reached through
 * one address and the two surfaces can never drift onto different hosts.
 */
export function capabilityUrls(baseUrl: string): CapabilityUrls {
	const base = stripTrailing(baseUrl);
	return { mcp: `${base}/mcp`, v1: `${base}/v1` };
}
