/// <reference lib="dom" />

/**
 * The desktop binding: the trusted Epicenter origin is the owner, reached over
 * same-origin HTTP.
 *
 * Two capabilities, and neither of them is the store. **Data stays
 * client-owned, and the host contributes nothing to it.** The store lives in
 * the WebView, exactly as it does in a browser tab, because the host serves
 * bundles and brokers credentials and owns no application data (ADR-0226,
 * ADR-0227). It is not on this leaf at all (ADR-0339): a deployed app is a
 * trusted app (ADR-0334), so there was no admission round trip and no second
 * party whose answer could mean anything, and a seam with one implementation
 * is not a seam.
 *
 * **This leaf builds a binding, not a handle.** Nothing about an epicenter
 * varies by runtime; the trusted owner's files and keychain do. So the leaf is
 * what varies, an application composes it, and one `createEpicenter` in
 * `@epicenter/app` serves every build.
 *
 * **SQLite is a Bun-owned file.** The owner maps `(appId, name)` to a path
 * below the one Epicenter data root; the application sends statements and never
 * sees the path. Deleting one is the same round trip, and the owner closes its
 * handle before it unlinks, because the application cannot (ADR-0321).
 *
 * **A secret is a keychain entry.** The owner hands it to Rust over the private
 * sidecar pipe, which is the only thing on this machine that names a keyring
 * entry. Nothing durable lands in the page.
 */

import type { SqliteRow, SqliteValue } from '@epicenter/sqlite';
import { Ok, type Result } from 'wellcrafted/result';
import {
	AppError,
	type AppSqliteDatabase,
	type EpicenterBindingFactory,
	SecretError,
	type SecretStore,
} from './index.js';
import {
	APP_STORAGE_PATH,
	type AppStorageRequest,
	type AppStorageResponse,
	isAppStorageResponse,
} from './protocol.js';

export type CreateDesktopBindingOptions = {
	/** The trusted origin that owns the files and the keychain entries. */
	baseURL?: string;
	fetch?: typeof globalThis.fetch;
};

/**
 * One binding over what the trusted origin owns, for whichever application
 * asks.
 *
 * A function of `appId` rather than a built binding, because that is the shape
 * `createEpicenter` takes: the handle resolves the id and hands it over, so the
 * files and the keychain cannot be scoped to a different application than the
 * store (ADR-0339).
 *
 * The origin and the fetch are read inside the returned function rather than
 * here, so a seam leaf evaluated at module scope does not refuse a build before
 * anything asked it for a handle.
 */
export function createDesktopBinding(
	options: CreateDesktopBindingOptions = {},
): EpicenterBindingFactory {
	return (appId) => {
		const request = createOwnerRequest(options);
		return {
			open: async (name) => Ok(createOwnedSqlite(request, appId, name)),
			delete: (name) =>
				unwrap(
					request({ kind: 'sqlite-delete', appId, name }),
					'sqlite-delete',
					() => undefined,
				),
			secrets: createKeychainSecrets(request, appId),
		};
	};
}

type OwnerRequest = (
	message: AppStorageRequest,
) => Promise<Result<AppStorageResponse, AppError>>;

function createOwnerRequest({
	baseURL = globalThis.location?.origin,
	fetch: fetchImplementation = globalThis.fetch,
}: CreateDesktopBindingOptions): OwnerRequest {
	if (!baseURL || !fetchImplementation) {
		throw new Error('The desktop binding needs an origin and fetch.');
	}
	return async (message) => {
		try {
			const response = await fetchImplementation(
				`${baseURL}${APP_STORAGE_PATH}`,
				{
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(message),
				},
			);
			if (!response.ok) {
				return AppError.ProtocolFailed({ status: response.status });
			}
			const body: unknown = await response.json();
			if (!isAppStorageResponse(body)) return AppError.InvalidResponse();
			return Ok(body);
		} catch (cause) {
			return AppError.StorageFailed({ cause });
		}
	};
}

function createOwnedSqlite(
	request: OwnerRequest,
	appId: string,
	name: string,
): AppSqliteDatabase {
	return {
		run: (sql, parameters) =>
			unwrap(
				request({
					kind: 'sqlite-run',
					appId,
					name,
					statement: { sql, parameters },
				}),
				'sqlite-run',
				(response) => ({ changes: response.changes }),
			),
		all: <TRow extends SqliteRow>(
			sql: string,
			parameters?: readonly SqliteValue[],
		) =>
			unwrap(
				request({
					kind: 'sqlite-all',
					appId,
					name,
					statement: { sql, parameters },
				}),
				'sqlite-all',
				(response) => response.rows as TRow[],
			),
		batch: (statements) =>
			unwrap(
				request({ kind: 'sqlite-batch', appId, name, statements }),
				'sqlite-batch',
				(response) => ({ changes: [...response.changes] }),
			),
	};
}

function createKeychainSecrets(
	request: OwnerRequest,
	appId: string,
): SecretStore {
	return {
		put: async (label, value) => {
			const result = await request({
				kind: 'secret-put',
				appId,
				label,
				value,
			});
			return result.error === null
				? Ok(undefined)
				: SecretError.StorageFailed({ cause: result.error });
		},
		get: async (label) => {
			const result = await request({ kind: 'secret-get', appId, label });
			if (result.error !== null) {
				return SecretError.StorageFailed({ cause: result.error });
			}
			return result.data.kind === 'secret-get'
				? Ok(result.data.value)
				: SecretError.StorageFailed({
						cause: AppError.InvalidResponse().error,
					});
		},
		delete: async (label) => {
			const result = await request({ kind: 'secret-delete', appId, label });
			return result.error === null
				? Ok(undefined)
				: SecretError.StorageFailed({ cause: result.error });
		},
	};
}

/** Unwrap one response, refusing an owner that answered about something else. */
function unwrap<TKind extends AppStorageResponse['kind'], TValue>(
	pending: Promise<Result<AppStorageResponse, AppError>>,
	kind: TKind,
	read: (response: Extract<AppStorageResponse, { kind: TKind }>) => TValue,
): Promise<Result<TValue, AppError>> {
	return pending.then((outcome) => {
		if (outcome.error !== null) return outcome;
		if (outcome.data.kind !== kind) return AppError.InvalidResponse();
		return Ok(
			read(outcome.data as Extract<AppStorageResponse, { kind: TKind }>),
		);
	});
}
