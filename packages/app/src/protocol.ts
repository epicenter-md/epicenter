/**
 * Messages exchanged by an application handle and the trusted desktop owner.
 *
 * Three concerns cross this seam and only three: opening the application's
 * declared data, running statements against an application-owned SQLite file,
 * and holding one labeled secret. Every message names the application, because
 * the owner scopes everything it does by that identity rather than by the
 * socket it arrived on.
 *
 * `data-open` carries the definition's IDENTITY, never the definition. The
 * owner imports first-party definition modules from its own release (ADR-0313)
 * and answers whether this release ships that data id and whether the asking
 * application owns it. It does not receive a serialized declaration, and there
 * is no JSON spelling of one to receive.
 */

import { isAppId } from '@epicenter/constants/app-id';
import type { SqliteValue } from '@epicenter/sqlite';

export const APP_STORAGE_PATH = '/api/app-storage';

/**
 * The names this protocol admits, owned here because both ends read them.
 *
 * They lived in two places until they were moved: the client validated before
 * sending and the host validated on arrival, with the same two regular
 * expressions written out twice. That is how a client starts refusing what a
 * server accepts, or worse, the other way round.
 *
 * The application id reuses `isAppId`, which is the grammar that already names
 * a directory below the one Epicenter data root, so a name this protocol admits
 * and a name that can be a directory are one question with one answer. It is
 * imported from `@epicenter/constants/app-id` rather than `/app-data`, because
 * that module resolves an OS path and would drag `node:os` into every page that
 * bundles this one.
 */
export const isProtocolAppId = isAppId;

/** One SQLite database an application may name through `openSqlite`. */
export function isDatabaseName(value: string): boolean {
	return /^[a-z][a-z0-9_-]*$/.test(value);
}

/**
 * One label a secret may be filed under.
 *
 * Wider than anything that flows through it today: an Epicenter Data row id is
 * 24 lowercase alphanumerics. It is deliberately not narrowed to that, because
 * the label is the APPLICATION's to mint (ADR-0310) and this protocol has no
 * business assuming which minting an application uses. What it does refuse is
 * anything that could be read as a path or a separator, which is what keeps two
 * different pairs from naming one entry in the credential store.
 */
export function isSecretLabel(value: string): boolean {
	return /^[A-Za-z0-9._-]+$/.test(value);
}

export type SqliteStatement = {
	sql: string;
	parameters?: readonly SqliteValue[];
};

export type AppStorageRequest =
	| {
			kind: 'data-open';
			appId: string;
			dataId: string;
		}
	| {
			kind: 'sqlite-run';
			appId: string;
			name: string;
			statement: SqliteStatement;
		}
	| {
			kind: 'sqlite-all';
			appId: string;
			name: string;
			statement: SqliteStatement;
		}
	| {
			kind: 'sqlite-batch';
			appId: string;
			name: string;
			statements: readonly SqliteStatement[];
		}
	| {
			kind: 'secret-put';
			appId: string;
			accountId: string;
			value: string;
		}
	| {
			kind: 'secret-get';
			appId: string;
			accountId: string;
		}
	| {
			kind: 'secret-delete';
			appId: string;
			accountId: string;
		};

export type AppStorageResponse =
	/**
	 * Admission, and nothing else. It carried the id and the title back and no
	 * caller read either: the answer to "may I open this" is that the owner
	 * answered at all.
	 */
	| { kind: 'data-open' }
	| { kind: 'sqlite-run'; changes: number }
	| { kind: 'sqlite-all'; rows: readonly Record<string, unknown>[] }
	| { kind: 'sqlite-batch'; changes: readonly number[] }
	| { kind: 'secret-put' }
	| { kind: 'secret-get'; value: string | null }
	| { kind: 'secret-delete' };

const RESPONSE_KINDS: readonly AppStorageResponse['kind'][] = [
	'data-open',
	'sqlite-run',
	'sqlite-all',
	'sqlite-batch',
	'secret-put',
	'secret-get',
	'secret-delete',
];

export function isAppStorageResponse(
	value: unknown,
): value is AppStorageResponse {
	if (typeof value !== 'object' || value === null || !('kind' in value)) {
		return false;
	}
	return RESPONSE_KINDS.includes(value.kind as AppStorageResponse['kind']);
}
