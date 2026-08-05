/**
 * Bun-owned routes on the one trusted Epicenter origin.
 *
 * The surface catalog is deliberately closed and compiled. Rust can mirror
 * the IDs, paths, and stable window labels without discovering or loading an
 * application registry. The bootstrap route is host infrastructure: Tauri
 * exchanges the per-launch credential there before any SPA reaches domain
 * code.
 */

import { LOCAL_BLOB_PATH } from '@epicenter/blobs/webview';

const stripTrailing = (value: string) => value.replace(/\/+$/, '');

function route(pattern: string) {
	return {
		pattern,
		url: (baseUrl: string) => `${stripTrailing(baseUrl)}${pattern}`,
	} as const;
}

function surface<const TId extends string>(id: TId, title: string) {
	return {
		id,
		title,
		windowLabel: id,
		...route(`/apps/${id}/`),
	};
}

export const SURFACE_ROUTES = {
	home: surface('home', 'Home'),
	whispering: surface('whispering', 'Whispering'),
	honeycrisp: surface('honeycrisp', 'Honeycrisp'),
	mail: surface('mail', 'Mail'),
	books: surface('books', 'Books'),
} as const;

export type SurfaceId = keyof typeof SURFACE_ROUTES;

export const BOOTSTRAP_ROUTE = route('/_epicenter/bootstrap');
export const ACCOUNT_SIGN_IN_ROUTE = route('/_epicenter/account/sign-in');
export const ACCOUNT_SIGN_OUT_ROUTE = route('/_epicenter/account/sign-out');
export const ACCOUNT_INSTANCE_ROUTE = route('/_epicenter/account/instance');
export const ACCOUNT_PROFILE_ROUTE = route('/_epicenter/account/profile');
export const HOME_ROUTE = SURFACE_ROUTES.home;
export const WHISPERING_ROUTE = SURFACE_ROUTES.whispering;
export const HONEYCRISP_ROUTE = SURFACE_ROUTES.honeycrisp;
export const MAIL_ROUTE = SURFACE_ROUTES.mail;
export const BOOKS_ROUTE = SURFACE_ROUTES.books;
/** What Home lists as launchable (ADR-0189). */
export const APPLICATIONS_ROUTE = route('/api/apps');
export const SESSION_ROUTE = route('/api/home/session');
export const SESSION_STREAM_ROUTE = route('/api/home/session/stream');
/**
 * The raw view: what namespaces exist, and one read-only statement (ADR-0209).
 *
 * On this one trusted origin an application could reach these too, so they are
 * a product boundary rather than a sandbox, exactly as ADR-0162 says. What
 * makes "applications receive no SQL" true is that no typed application API
 * carries SQL, not that this route is hidden from them.
 */
export const INSPECT_ROUTE = route('/api/home/inspect');
export const INSPECT_QUERY_ROUTE = route('/api/home/inspect/query');
export const LOCAL_BLOB_ROUTE = {
	pattern: `${LOCAL_BLOB_PATH}/:blobId`,
} as const;
/**
 * Host-owned remote copy operations for one local blob. The id is the only
 * input: no route accepts a destination URL, transfer header, or body, so the
 * host's own deployment authority is the only reachable target.
 */
export const LOCAL_BLOB_REMOTE_ROUTES = {
	upload: { pattern: `${LOCAL_BLOB_PATH}/:blobId/upload` },
	download: { pattern: `${LOCAL_BLOB_PATH}/:blobId/download` },
	purge: { pattern: `${LOCAL_BLOB_PATH}/:blobId/purge` },
} as const;
