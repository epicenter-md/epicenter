/**
 * The Epicenter build: the SPA is a compiled application served below
 * `/apps/mail/`, and the Epicenter host mounts the mail surface at `/api/mail`
 * on the same trusted origin (ADR-0191).
 *
 * No credential is attached. An application window inside Epicenter runs as
 * Epicenter (ADR-0179): same origin, same browser session, which the host
 * already requires of every request it serves. A mail-only bearer would be the
 * only one of its kind and would protect nothing the session does not, so this
 * build mints, injects, and reads none.
 */

/** Where the Epicenter host mounted the mail surface. Absolute because `hc`
 * needs an absolute base; the localhost fallback keeps a stray import from
 * throwing at load in a non-browser context. */
export const mailApiBase =
	typeof window === 'undefined'
		? 'http://localhost/api/mail'
		: `${window.location.origin}/api/mail`;

/** The host's session rides the request as an ordinary same-origin cookie, so
 * this is plain `fetch`. Declared with an explicit signature to match the
 * standalone seam rather than restating Bun's `fetch.preconnect`. */
export const mailApiFetch = (
	input: RequestInfo | URL,
	init?: RequestInit,
): Promise<Response> => fetch(input, init);
