/**
 * The Super Chat shell's own loopback HTTP routes.
 *
 * `/api/session` returns the tool catalog plus the current conversation
 * snapshot; `/api/session/stream` upgrades to the chat WebSocket (ADR-0084).
 * Both live on the shell's private `127.0.0.1` Bun server behind the per-launch
 * token.
 *
 * These are NOT the cloud `/api/session` auth contract (`@epicenter/constants`,
 * which returns `{ principalId, email }`). The shell's session is a chat
 * transcript, not an authenticated principal; the two share only the string
 * `/api/session` by coincidence, so the shell owns its route strings locally
 * rather than reaching into the cross-deployment API surface.
 */

const stripTrailing = (s: string) => s.replace(/\/+$/, '');

export const SESSION_ROUTE = {
	pattern: '/api/session',
	url: (baseURL: string) => `${stripTrailing(baseURL)}/api/session`,
} as const;

export const SESSION_STREAM_ROUTE = {
	pattern: '/api/session/stream',
	url: (baseURL: string) => `${stripTrailing(baseURL)}/api/session/stream`,
} as const;
