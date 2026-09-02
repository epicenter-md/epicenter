/**
 * The one application-owned handle for Epicenter capabilities (ADR-0316).
 *
 * An application creates `epicenter` once, with its declared application id,
 * and reaches its data, its relational stores, and its secrets through it. It
 * never selects IndexedDB, OPFS, Bun SQLite, a native path, a keychain, or a
 * host IPC mechanism, because none of those names appear on this surface.
 *
 * **The runtime arrives as a binding, chosen at build time.** There is no
 * `typeof window` test here and there must not be one: the desktop build runs
 * in a WebView, so a runtime sniff cannot tell it apart from a browser tab,
 * and the two differ in exactly the ways that matter (a keychain, a Bun-owned
 * file). Applications select the leaf through the `#platform/*` condition the
 * repository already uses for auth and instance seams; a build that forgot to
 * fails to resolve rather than silently running the wrong owner.
 *
 * Runtime differences are typed failures, never branches (ADR-0181). A browser
 * build has no keychain, so its secret leaf answers from tab memory and forgets
 * everything on close; the application handles that because a `Result` obliges
 * it to.
 */

import type { LocalData } from '@epicenter/data';
import type { DataDefinition } from '@epicenter/data/definition';
import type { SqliteRow, SqliteValue } from '@epicenter/sqlite';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';
import { isDatabaseName, isProtocolAppId, isSecretLabel } from './protocol.js';

export const AppError = defineErrors({
	InvalidAppId: ({ appId }: { appId: string }) => ({
		message: `The application id '${appId}' is not valid.`,
		appId,
	}),
	InvalidDatabaseName: ({ databaseName }: { databaseName: string }) => ({
		message: `The SQLite database name '${databaseName}' is not valid.`,
		databaseName,
	}),
	StorageFailed: ({ cause }: { cause: unknown }) => ({
		message: 'The application storage owner failed.',
		cause,
	}),
	ProtocolFailed: ({ status }: { status: number }) => ({
		message: `The application storage owner rejected the request (${status}).`,
		status,
	}),
	InvalidResponse: () => ({
		message: 'The application storage owner returned an invalid response.',
	}),
});
export type AppError = InferErrors<typeof AppError>;

export const SecretError = defineErrors({
	InvalidAccountId: ({ accountId }: { accountId: string }) => ({
		message: `The account id '${accountId}' is not valid.`,
		accountId,
	}),
	StorageFailed: ({ cause }: { cause: unknown }) => ({
		message: 'The secret owner failed.',
		cause,
	}),
});
export type SecretError = InferErrors<typeof SecretError>;

/**
 * All `run`, `all`, and `batch` (ADR-0312). A transaction never crosses this
 * boundary, so `batch` is how several statements become one, and there is no
 * `close`: the owner holds the handle for the life of the application, and the
 * only thing that ends that life is `deleteSqlite` (ADR-0321).
 */
export type AppSqliteDatabase = {
	run(
		sql: string,
		parameters?: readonly SqliteValue[],
	): Promise<Result<{ changes: number }, AppError>>;
	all<TRow extends SqliteRow = SqliteRow>(
		sql: string,
		parameters?: readonly SqliteValue[],
	): Promise<Result<TRow[], AppError>>;
	batch(
		statements: readonly {
			sql: string;
			parameters?: readonly SqliteValue[];
		}[],
	): Promise<Result<{ changes: number[] }, AppError>>;
};

/**
 * Three verbs and no enumeration (ADR-0310).
 *
 * There is no way to ask whether this runtime keeps a secret across a session,
 * and that absence is the design: a browser build answers `null` from `get`
 * after a reload, which is the same answer a new desktop device gives, and the
 * application already has to handle it. A `durable` flag would be a platform
 * test wearing a capability's clothes.
 */
export type SecretStore = {
	put(accountId: string, value: string): Promise<Result<void, SecretError>>;
	get(accountId: string): Promise<Result<string | null, SecretError>>;
	delete(accountId: string): Promise<Result<void, SecretError>>;
};

export type EpicenterBinding = {
	openData<TDefinition extends DataDefinition>(
		definition: TDefinition,
	): Promise<Result<LocalData<TDefinition>, AppError>>;
	openSqlite(name: string): Promise<Result<AppSqliteDatabase, AppError>>;
	deleteSqlite(name: string): Promise<Result<void, AppError>>;
	secrets: SecretStore;
};

export type CreateEpicenterOptions = {
	appId: string;
	/** The runtime leaf, resolved by the application's build condition. */
	binding: EpicenterBinding;
};

export type EpicenterHandle = {
	readonly appId: string;
	openData<TDefinition extends DataDefinition>(
		definition: TDefinition,
	): Promise<Result<LocalData<TDefinition>, AppError>>;
	openSqlite(name: string): Promise<Result<AppSqliteDatabase, AppError>>;
	/**
	 * Delete one database this application named, and close the owner's handle
	 * to it (ADR-0321).
	 *
	 * There is no `list`, for the same reason `secrets` has none: the
	 * application's own rows are the only thing that knows a name exists. A name
	 * that was never created deletes successfully, because the caller asked for
	 * it to be gone and it is.
	 */
	deleteSqlite(name: string): Promise<Result<void, AppError>>;
	readonly secrets: SecretStore;
};

/** Create one handle whose every capability is scoped to `appId`. */
export function createEpicenter(
	options: CreateEpicenterOptions,
): EpicenterHandle {
	if (!isProtocolAppId(options.appId)) {
		throw new Error(
			AppError.InvalidAppId({ appId: options.appId }).error.message,
		);
	}
	const { binding } = options;

	return Object.freeze({
		appId: options.appId,
		openData<TDefinition extends DataDefinition>(definition: TDefinition) {
			return binding.openData(definition);
		},
		openSqlite(name: string) {
			if (!isDatabaseName(name)) {
				return Promise.resolve(
					AppError.InvalidDatabaseName({ databaseName: name }),
				);
			}
			return binding.openSqlite(name);
		},
		deleteSqlite(name: string) {
			if (!isDatabaseName(name)) {
				return Promise.resolve(
					AppError.InvalidDatabaseName({ databaseName: name }),
				);
			}
			return binding.deleteSqlite(name);
		},
		secrets: Object.freeze({
			put(accountId: string, value: string) {
				if (!isSecretLabel(accountId)) {
					return Promise.resolve(SecretError.InvalidAccountId({ accountId }));
				}
				return binding.secrets.put(accountId, value);
			},
			get(accountId: string) {
				if (!isSecretLabel(accountId)) {
					return Promise.resolve(SecretError.InvalidAccountId({ accountId }));
				}
				return binding.secrets.get(accountId);
			},
			delete(accountId: string) {
				if (!isSecretLabel(accountId)) {
					return Promise.resolve(SecretError.InvalidAccountId({ accountId }));
				}
				return binding.secrets.delete(accountId);
			},
		}),
	});
}
