import type { Handle } from '@sveltejs/kit';

/** Keep OPFS SQLite's worker environment cross-origin isolated in every host. */
export const handle: Handle = ({ event, resolve }) => {
	event.setHeaders({
		'Cross-Origin-Opener-Policy': 'same-origin',
		'Cross-Origin-Embedder-Policy': 'require-corp',
	});
	return resolve(event);
};
