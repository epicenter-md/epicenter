/**
 * Standalone `local-mail app`: the SPA is served at the loopback origin root,
 * the mail surface is mounted at `/api`, and the host authenticates it with a
 * per-launch bearer handed over out of band.
 *
 * The bearer arrives as `window.__LOCAL_MAIL__`, injected into the served HTML
 * before this code runs. It is a loopback credential, never a Gmail token, and
 * it never rides the URL. In dev there is no global: the Vite proxy injects the
 * running host's bearer on each proxied `/api` request instead, so `readBearer`
 * returns null and this module attaches nothing.
 *
 * The Epicenter build resolves `mail-host.epicenter-host.ts` instead, where the
 * host's own session already authenticates the request (ADR-0191).
 */

declare global {
	interface Window {
		__LOCAL_MAIL__?: { origin?: string; bearer: string };
	}
}

function readBearer(): string | null {
	if (typeof window === 'undefined') return null;
	return window.__LOCAL_MAIL__?.bearer ?? null;
}

/** Where this host mounted the mail surface. `hc` needs an absolute base, and
 * this module only ever executes in the browser (the SPA is `ssr: false`,
 * `prerender: false`); the localhost fallback keeps a stray import from
 * throwing at load. */
export const mailApiBase =
	typeof window === 'undefined'
		? 'http://localhost/api'
		: `${window.location.origin}/api`;

/** Attach the per-launch bearer from the injected global. Typed with an
 * explicit signature rather than `typeof fetch` so it does not have to restate
 * Bun's `fetch.preconnect`. */
export const mailApiFetch = async (
	input: RequestInfo | URL,
	init?: RequestInit,
): Promise<Response> => {
	const headers = new Headers(init?.headers);
	const bearer = readBearer();
	if (bearer) headers.set('authorization', `Bearer ${bearer}`);
	return fetch(input, { ...init, headers });
};
