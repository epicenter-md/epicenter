/// <reference lib="dom" />

/**
 * The desktop leaf: the trusted Epicenter origin is the owner, reached over
 * same-origin HTTP.
 *
 * Three capabilities, three owners, and only one of them is the host's.
 *
 * **Data stays client-owned, and the host contributes nothing to it.** The
 * store lives in the WebView, exactly as it does in a browser tab, because the
 * host serves bundles and brokers credentials and owns no application data
 * (ADR-0226, ADR-0227). `openData` is the same call here as in a browser: a
 * deployed app is a trusted app (ADR-0334), so there is no admission round trip
 * and no second party whose answer could mean anything.
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
import { openClientOwnedData } from './client-owned-data.js';
import {
	AppError,
	type AppSqliteDatabase,
	type EpicenterBinding,
	SecretError,
	type SecretStore,
} from './index.js';
import {
	APP_STORAGE_PATH,
	type AppStorageRequest,
	type AppStorageResponse,
	isAppStorageResponse,
} from './protocol.js';

export type DesktopBindingOptions = {
	appId: string;
	baseURL?: string;
	fetch?: typeof globalThis.fetch;
};

export function createDesktopBinding(
	options: DesktopBindingOptions,
): EpicenterBinding {
	const request = createOwnerRequest(options);
	const { appId } = options;
	return {
		// No admission round trip. A deployed app is a trusted app (ADR-0334),
		// and the store is client-owned in every runtime (ADR-0226), so there
		// was never a second party whose answer could mean anything.
		openData: async (definition, account) =>
			openClientOwnedData(appId, definition, account),
		openSqlite: async (name) => Ok(createOwnedSqlite(request, appId, name)),
		deleteSqlite: (name) =>
			unwrap(
				request({ kind: 'sqlite-delete', appId, name }),
				'sqlite-delete',
				() => undefined,
			),
		secrets: createKeychainSecrets(request, appId),
	};
}

type OwnerRequest = (
	message: AppStorageRequest,
) => Promise<Result<AppStorageResponse, AppError>>;

function createOwnerRequest({
	baseURL = globalThis.location?.origin,
	fetch: fetchImplementation = globalThis.fetch,
}: DesktopBindingOptions): OwnerRequest {
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
		put: async (accountId, value) => {
			const result = await request({
				kind: 'secret-put',
				appId,
				accountId,
				value,
			});
			return result.error === null
				? Ok(undefined)
				: SecretError.StorageFailed({ cause: result.error });
		},
		get: async (accountId) => {
			const result = await request({ kind: 'secret-get', appId, accountId });
			if (result.error !== null) {
				return SecretError.StorageFailed({ cause: result.error });
			}
			return result.data.kind === 'secret-get'
				? Ok(result.data.value)
				: SecretError.StorageFailed({
						cause: AppError.InvalidResponse().error,
					});
		},
		delete: async (accountId) => {
			const result = await request({ kind: 'secret-delete', appId, accountId });
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
