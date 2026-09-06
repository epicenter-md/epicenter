/**
 * What one application owns ON THIS DEVICE: its SQLite files and its secrets
 * (ADR-0321, ADR-0310).
 *
 * Neither is account data. A SQLite file is a device cache an application
 * opens before anyone signs in, and a keychain entry is how an account is
 * reached at all, so neither has a principal to be scoped by and neither
 * belongs to the replica. That is why this is its own package rather than a
 * namespace on the data session: `@epicenter/app` opens one person's replica
 * and does not vary by runtime, while this varies by runtime and knows no
 * person.
 *
 * An application never selects OPFS, Bun SQLite, a native path, a keychain, or
 * a host IPC mechanism, because none of those names appear on this surface. It
 * selects a runtime through its own `#platform/*` seam and calls one of the two
 * constructors. There is no `typeof window` test and there must not be one: the
 * desktop build runs in a WebView, so a runtime sniff cannot tell it apart from
 * a browser tab. A build that forgot to declare its condition fails to resolve
 * rather than silently running the wrong owner.
 *
 * Runtime differences are typed failures, never branches (ADR-0181). A browser
 * build has no keychain, so its secret leaf answers from tab memory and forgets
 * everything on close; the application handles that because a `Result` obliges
 * it to.
 */

import type { SqliteRow, SqliteValue } from '@epicenter/sqlite';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';
import {
	type DatabaseName,
	isDatabaseName,
	isSecretLabel,
	type SecretLabel,
} from './protocol.js';

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
	InvalidSecretLabel: ({ label }: { label: string }) => ({
		message: `The secret label '${label}' is not valid.`,
		label,
	}),
	StorageFailed: ({ cause }: { cause: unknown }) => ({
		message: 'The secret owner failed.',
		cause,
	}),
});
export type SecretError = InferErrors<typeof SecretError>;

/**
 * The two names an application mints, and the guards that narrow them.
 *
 * Re-exported here rather than left on `/protocol`, because that subpath is
 * the desktop owner's wire and an application is not writing one. The guards
 * narrow: a name that passed one is a `DatabaseName` or a `SecretLabel`, which
 * is what lets the store stop asking on every call.
 */
export {
	type DatabaseName,
	isDatabaseName,
	isSecretLabel,
	type SecretLabel,
} from './protocol.js';

/**
 * Mint one SQLite file name, refusing what this platform cannot file.
 *
 * It throws, because a name reaching this is a constant in a build and a wrong
 * one is a bug rather than a condition. A name derived from a value that
 * arrived at runtime is not this function's business; narrow it with
 * `isDatabaseName` where it is born, so the refusal can say what the person
 * did rather than what the grammar is.
 */
export function databaseName(value: string): DatabaseName {
	if (!isDatabaseName(value)) {
		throw new Error(
			AppError.InvalidDatabaseName({ databaseName: value }).error.message,
		);
	}
	return value;
}

/** Mint one secret label, on the same terms as {@link databaseName}. */
export function secretLabel(value: string): SecretLabel {
	if (!isSecretLabel(value)) {
		throw new Error(
			SecretError.InvalidSecretLabel({ label: value }).error.message,
		);
	}
	return value;
}

/**
 * All `run`, `all`, and `batch` (ADR-0312). A transaction never crosses this
 * boundary, so `batch` is how several statements become one, and there is no
 * `close`: the owner holds the handle for the life of the application, and the
 * only thing that ends that life is `sqlite.delete` (ADR-0321).
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
	put(label: SecretLabel, value: string): Promise<Result<void, SecretError>>;
	get(label: SecretLabel): Promise<Result<string | null, SecretError>>;
	delete(label: SecretLabel): Promise<Result<void, SecretError>>;
};

/**
 * One application's device-owned storage: named SQLite files, and secrets.
 *
 * Both runtime constructors answer this, so an application annotates against
 * it once and its two platform leaves cannot drift. `appId` is on it because
 * the value scopes every file name and every keychain entry underneath, and a
 * caller that wants to log which application it is holding should not have to
 * keep the string beside the object.
 *
 * There is no `list` on either half, for the same reason: the application's own
 * rows are the only thing that knows a name exists. A name that was never
 * created deletes successfully, because the caller asked for it to be gone and
 * it is.
 */
export type AppStorage = {
	readonly appId: string;
	readonly sqlite: {
		open(name: DatabaseName): Promise<Result<AppSqliteDatabase, AppError>>;
		/** Delete one file this application named, closing the owner's handle (ADR-0321). */
		delete(name: DatabaseName): Promise<Result<void, AppError>>;
	};
	readonly secrets: SecretStore;
};
