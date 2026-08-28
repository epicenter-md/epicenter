/**
 * Bun-owned routes on the one trusted Epicenter origin.
 *
 * The built-in route table is deliberately closed and compiled. Rust can mirror
 * the IDs and paths without discovering or loading an application registry, and
 * it derives its own window labels from those IDs: a window label is Tauri's
 * handle, so Bun states no opinion about one. The bootstrap route is host
 * infrastructure: Tauri exchanges the per-launch credential there before any
 * SPA reaches domain code.
 */

import { LOCAL_BLOB_PATH } from '@epicenter/blobs/webview';
import { MIRROR_PATH } from '@epicenter/data/artifact/protocol';

const stripTrailing = (value: string) => value.replace(/\/+$/, '');

function route(pattern: string) {
	return {
		pattern,
		url: (baseUrl: string) => `${stripTrailing(baseUrl)}${pattern}`,
	} as const;
}

function builtInRoute<const TId extends string>(id: TId, title: string) {
	return {
		id,
		title,
		...route(`/apps/${id}/`),
	};
}

export const BUILT_IN_ROUTES = {
	home: builtInRoute('home', 'Home'),
	whispering: builtInRoute('whispering', 'Whispering'),
	honeycrisp: builtInRoute('honeycrisp', 'Honeycrisp'),
	mail: builtInRoute('mail', 'Mail'),
	books: builtInRoute('books', 'Books'),
} as const;

export type BuiltInRouteId = keyof typeof BUILT_IN_ROUTES;

export const BOOTSTRAP_ROUTE = route('/_epicenter/bootstrap');
export const ACCOUNT_SIGN_IN_ROUTE = route('/_epicenter/account/sign-in');
export const ACCOUNT_SIGN_OUT_ROUTE = route('/_epicenter/account/sign-out');
export const ACCOUNT_INSTANCE_ROUTE = route('/_epicenter/account/instance');
export const ACCOUNT_PROFILE_ROUTE = route('/_epicenter/account/profile');
export const HOME_ROUTE = BUILT_IN_ROUTES.home;
export const WHISPERING_ROUTE = BUILT_IN_ROUTES.whispering;
export const HONEYCRISP_ROUTE = BUILT_IN_ROUTES.honeycrisp;
export const MAIL_ROUTE = BUILT_IN_ROUTES.mail;
export const BOOKS_ROUTE = BUILT_IN_ROUTES.books;
/** What Home lists as launchable (ADR-0189). */
export const APPLICATIONS_ROUTE = route('/api/apps');
export const SESSION_ROUTE = route('/api/home/session');
export const SESSION_STREAM_ROUTE = route('/api/home/session/stream');
export const LOCAL_BLOB_ROUTE = {
	pattern: `${LOCAL_BLOB_PATH}/:blobId`,
} as const;
/**
 * One pass of the `~/Epicenter` mirror (ADR-0271).
 *
 * A place and a database name a folder, and nothing below that appears in the
 * URL: a pass carries its files and its manifest in an NDJSON body, so there
 * is no per-file path to route, capture, or validate. That is what the earlier
 * per-file design cost, and it cost it silently: Hono routes a bare `*` but
 * captures nothing under it, so every write arrived with an empty path.
 */
export const MIRROR_ROUTE = route(`${MIRROR_PATH}/:place/:databaseId`);
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
