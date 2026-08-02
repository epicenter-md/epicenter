/**
 * The mail surface on a loopback port, for developing the triage SPA with HMR.
 *
 * Not a host and never shipped. It serves `/api/mail` and nothing else: no
 * static assets, no bearer, no HTML injection, no presence file, no window. The
 * standalone host that did all of those was deleted by ADR-0191, and this must
 * not grow back into it. In production the only thing serving this surface is
 * the Epicenter host, at the same path, so the SPA's one API base is correct
 * under both and needs no build-time seam.
 *
 * It exists because Mail's data plane is its engine. Whispering and Honeycrisp
 * develop against their own browser-owned data plane; this is Mail's equivalent,
 * and there is no alternative: a Vite dev server cannot authenticate against a
 * running Epicenter, whose launch token travels Rust to Bun over stdin, is never
 * written to disk, and is not relaxed in dev.
 *
 * Run it beside `bun run --cwd ui dev`, which proxies to this port.
 */

import { openMailEngine } from '../src/engine.ts';
import { MAIL_API_PREFIX, MAIL_DEV_API_PORT } from '../src/mount.ts';

const { data: engine, error } = await openMailEngine({
	log: (message) => console.error(message),
});
if (error) {
	console.error(error.message);
	process.exit(1);
}

const server = Bun.serve({
	hostname: '127.0.0.1',
	port: MAIL_DEV_API_PORT,
	fetch(request) {
		const url = new URL(request.url);
		// The DNS-rebinding kill switch, kept even in dev: a request whose Host is
		// not this exact loopback origin is refused before routing.
		if (request.headers.get('host') !== `127.0.0.1:${server.port}`) {
			return new Response('Forbidden', { status: 403 });
		}
		if (!url.pathname.startsWith(`${MAIL_API_PREFIX}/`)) {
			return new Response('Not found', { status: 404 });
		}
		// Strip the prefix the same way the Epicenter host does, because the mail
		// surface's routes carry none of their own.
		url.pathname = url.pathname.slice(MAIL_API_PREFIX.length) || '/';
		return engine.api.fetch(new Request(url.toString(), request));
	},
});

console.error(
	`Mail dev API on http://127.0.0.1:${server.port}${MAIL_API_PREFIX} for ${engine.accountEmails.length} account(s): ${engine.accountEmails.join(', ')}.`,
);

process.on('SIGINT', async () => {
	server.stop();
	await engine.close();
	process.exit(0);
});
