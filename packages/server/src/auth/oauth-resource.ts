import type { Context } from 'hono';
import type { OAuthError } from './oauth-errors.js';

/**
 * Map an {@link OAuthError} to the protected-resource HTTP failure response.
 *
 * The serialized error object (`{ name, message, ...fields }`) is the JSON
 * body; clients reconstruct by branching on `error.name`. `InvalidToken` is a
 * 401 with a `WWW-Authenticate` challenge; `ServerError` is a 503 the client
 * should retry rather than treat as a rejected token.
 *
 * This helper is runtime-neutral and serves plain-HTTP rejections (inference,
 * session, billing).
 */
export function createOAuthUnauthorizedResourceResponse(
	c: Context,
	error: OAuthError,
) {
	// A bearer challenge only belongs on an actual auth rejection, not a 503.
	if (error.status === 401) {
		c.header('WWW-Authenticate', 'Bearer error="invalid_token"');
	}
	return c.json(error, error.status);
}
