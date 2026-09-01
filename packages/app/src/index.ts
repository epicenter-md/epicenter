/** The one application-owned handle for Epicenter capabilities. */

import {
	createBrowserBinding,
} from './browser.js';
import { createDesktopBinding } from './desktop.js';
import {
	APP_STORAGE_PATH,
	type AppStorageRequest,
	type AppStorageResponse,
} from './protocol.js';
import type { DataDefinition } from '@epicenter/data/definition';
import type { LocalData } from '@epicenter/data';
import type { SqliteRow, SqliteValue } from '@epicenter/sqlite';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';

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

export type AppSqliteRow = SqliteRow;
export type AppSqliteValue = SqliteValue;

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
	secrets: SecretStore;
};

export type CreateEpicenterOptions = {
	appId: string;
	/** Runtime bindings are supplied by the desktop or browser entrypoint. */
	binding?: EpicenterBinding;
};

export type EpicenterHandle = {
	readonly appId: string;
	openData<TDefinition extends DataDefinition>(
		definition: TDefinition,
	): Promise<Result<LocalData<TDefinition>, AppError>>;
	openSqlite(name: string): Promise<Result<AppSqliteDatabase, AppError>>;
	readonly secrets: SecretStore;
};

const APP_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/;
const DATABASE_NAME = /^[a-z][a-z0-9_-]*$/;
const ACCOUNT_ID = /^[A-Za-z0-9._-]+$/;

/** Create one handle whose every capability is scoped to `appId`. */
export function createEpicenter(
	options: CreateEpicenterOptions,
): EpicenterHandle {
	if (!APP_ID.test(options.appId)) {
		throw new Error(AppError.InvalidAppId({ appId: options.appId }).error.message);
	}
	const browserWindow = typeof window === 'undefined' ? undefined : window;
	const binding =
		options.binding ??
		(browserWindow === undefined
			? createDesktopBinding({ appId: options.appId })
			: createBrowserBinding({ appId: options.appId }));

	return Object.freeze({
		appId: options.appId,
		openData<TDefinition extends DataDefinition>(definition: TDefinition) {
			return binding.openData(definition);
		},
		openSqlite(name: string) {
			if (!DATABASE_NAME.test(name)) {
				return Promise.resolve(AppError.InvalidDatabaseName({ databaseName: name }));
			}
			return binding.openSqlite(name);
		},
		secrets: {
			put(accountId: string, value: string) {
				if (!ACCOUNT_ID.test(accountId)) {
					return Promise.resolve(SecretError.InvalidAccountId({ accountId }));
				}
				return binding.secrets.put(accountId, value);
			},
			get(accountId: string) {
				if (!ACCOUNT_ID.test(accountId)) {
					return Promise.resolve(SecretError.InvalidAccountId({ accountId }));
				}
				return binding.secrets.get(accountId);
			},
			delete(accountId: string) {
				if (!ACCOUNT_ID.test(accountId)) {
					return Promise.resolve(SecretError.InvalidAccountId({ accountId }));
				}
				return binding.secrets.delete(accountId);
			},
		},
	});
}

export function createHttpBinding(options: {
	appId: string;
	baseURL?: string;
	fetch?: typeof globalThis.fetch;
}): EpicenterBinding {
	const request = createHttpRequest(options);
	return {
		openData: async () =>
			AppError.StorageFailed({
				cause: new Error('Desktop data opening is owned by the host binding.'),
			}),
		openSqlite: async (name) =>
			createHttpSqlite(request, options.appId, name),
		secrets: createHttpSecrets(request, options.appId),
	};
}

function createHttpRequest({
	baseURL = globalThis.location?.origin,
	fetch: fetchImplementation = globalThis.fetch,
}: {
	baseURL?: string;
	fetch?: typeof globalThis.fetch;
}) {
	if (!baseURL || !fetchImplementation) {
		throw new Error('An HTTP application binding needs an origin and fetch.');
	}
	return async function request(
		message: AppStorageRequest,
	): Promise<Result<AppStorageResponse, AppError>> {
		try {
				const response = await fetchImplementation(`${baseURL}${APP_STORAGE_PATH}`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(message),
				});
				if (!response.ok) {
					return AppError.ProtocolFailed({ status: response.status });
				}
				const body: unknown = await response.json();
				if (!isStorageResponse(body)) return AppError.InvalidResponse();
				return Ok(body);
		} catch (cause) {
			return AppError.StorageFailed({ cause });
		}
	};
}

function createHttpSqlite(
	request: ReturnType<typeof createHttpRequest>,
	appId: string,
	name: string,
): Promise<Result<AppSqliteDatabase, AppError>> {
	const database = {
		run: (sql: string, parameters?: readonly SqliteValue[]) =>
			mapRequest(request({ kind: 'sqlite-run', appId, name, statement: { sql, parameters } }), 'sqlite-run', (response) => ({ changes: response.changes })),
		all: <TRow extends SqliteRow>(sql: string, parameters?: readonly SqliteValue[]) =>
			mapRequest(request({ kind: 'sqlite-all', appId, name, statement: { sql, parameters } }), 'sqlite-all', (response) => response.rows as TRow[]),
		batch: (statements: readonly { sql: string; parameters?: readonly SqliteValue[] }[]) =>
			mapRequest(request({ kind: 'sqlite-batch', appId, name, statements }), 'sqlite-batch', (response) => ({ changes: [...response.changes] })),
	};
	return Promise.resolve(Ok(database));
}

function createHttpSecrets(
	request: ReturnType<typeof createHttpRequest>,
	appId: string,
): SecretStore {
	return {
		put: async (accountId, value) => {
			const result = await request({ kind: 'secret-put', appId, accountId, value });
			return result.error === null
				? Ok(undefined)
				: SecretError.StorageFailed({ cause: result.error });
		},
		get: async (accountId) => {
			const result = await request({ kind: 'secret-get', appId, accountId });
			if (result.error !== null) return SecretError.StorageFailed({ cause: result.error });
			return result.data.kind === 'secret-get'
				? Ok(result.data.value)
				: SecretError.StorageFailed({ cause: AppError.InvalidResponse().error });
		},
		delete: async (accountId) => {
			const result = await request({ kind: 'secret-delete', appId, accountId });
			return result.error === null
				? Ok(undefined)
				: SecretError.StorageFailed({ cause: result.error });
		},
	};
}

function mapRequest<TKind extends AppStorageResponse['kind'], TValue>(
	result: Promise<Result<AppStorageResponse, AppError>>,
	kind: TKind,
	map: (response: Extract<AppStorageResponse, { kind: TKind }>) => TValue,
): Promise<Result<TValue, AppError>> {
	return result.then((outcome) => {
		if (outcome.error !== null) return outcome;
		if (outcome.data.kind !== kind) return AppError.InvalidResponse();
		return Ok(map(outcome.data as Extract<AppStorageResponse, { kind: TKind }>));
	});
}

function isStorageResponse(value: unknown): value is AppStorageResponse {
	return (
		typeof value === 'object' &&
		value !== null &&
		'kind' in value &&
		['sqlite-run', 'sqlite-all', 'sqlite-batch', 'secret-put', 'secret-get', 'secret-delete'].includes(String(value.kind))
	);
}
