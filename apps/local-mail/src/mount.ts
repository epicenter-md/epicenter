/**
 * Where Local Mail's HTTP surface is mounted, and the dev port that serves it.
 *
 * The surface itself carries no path prefix (see `http/api.ts`): a host mounts
 * it wherever it likes and applies its own gate (ADR-0191). But the triage SPA
 * is compiled once against one base, so "wherever" is in practice one agreed
 * path, and this is it. A host that wanted a different prefix would have to
 * rebuild the SPA, which is exactly why this is one shared constant rather than
 * a value each side happens to spell the same way.
 *
 * Two servers mount it here: the Epicenter host in production, and
 * `scripts/dev-api.ts` when developing the SPA with HMR.
 */

/** The path a host mounts the mail surface at, and the base the SPA calls. */
export const MAIL_API_PREFIX = '/api/mail';

/**
 * The loopback port `scripts/dev-api.ts` binds, and the port the SPA's Vite dev
 * server proxies to. Dev only: nothing in production reads it, because Epicenter
 * serves the surface on its own origin.
 *
 * Fixed rather than ephemeral so no discovery file is needed. The standalone
 * host's `0600` presence file existed only because its port was ephemeral, and
 * it was deleted along with it.
 */
export const MAIL_DEV_API_PORT = 4177;
