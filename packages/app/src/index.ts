/**
 * The one application-owned handle for Epicenter capabilities (ADR-0316,
 * ADR-0339).
 *
 * An application creates `epicenter` once and reaches its data, its relational
 * files, and its secrets through it. It never selects IndexedDB, OPFS, Bun
 * SQLite, a native path, a keychain, or a host IPC mechanism, because none of
 * those names appear on this surface.
 *
 * There is one `createEpicenter` and it serves every build. What varies by
 * runtime is a Bun-owned file and a keychain, so that is what the browser and
 * desktop subpaths export: a binding, which an application selects through its
 * own `#platform/binding` seam and passes here. There is no `typeof window`
 * test and there must not be one: the desktop build runs in a WebView, so a
 * runtime sniff cannot tell it apart from a browser tab. A build that forgot
 * to declare its condition fails to resolve rather than silently running the
 * wrong owner.
 *
 * The store is client-owned in every runtime (ADR-0226, ADR-0227), so it is
 * composed here rather than behind the runtime seam. Nothing else about an
 * epicenter varies, which is why the composition lives in one file per
 * application rather than once per platform leaf.
 *
 * The binding is also what the Bun host's own leaf builds
 * (`apps/epicenter/src/app-binding.ts`), with a storage root and a secrets
 * owner its test swaps. Nothing in `main.ts` composes it yet, so the host's
 * background half (ADR-0323) is a leaf and a test rather than a running
 * process.
 *
 * Runtime differences are typed failures, never branches (ADR-0181). A browser
 * build has no keychain, so its secret leaf answers from tab memory and forgets
 * everything on close; the application handles that because a `Result` obliges
 * it to.
 */

import type { AuthClient } from '@epicenter/auth';
import type { ReplicaData } from '@epicenter/data';
import type { OpenedDatabase, StoreError } from '@epicenter/data/browser';
import type {
	DataDefinition,
	DataDefinitionParseError,
} from '@epicenter/data/definition';
import type { SqliteRow, SqliteValue } from '@epicenter/sqlite';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import { eraseReplicaOf, openReplica } from './client-owned-data.js';
import {
	type DatabaseName,
	isDatabaseName,
	isProtocolAppId,
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
 * is what let the handle stop asking on every call.
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
 * one is a bug rather than a condition: the same reason `createEpicenter`
 * throws on an application id it does not admit. A name derived from a value
 * that arrived at runtime is not this function's business; narrow it with
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
 * What a runtime supplies, and it is not a quarter of what it used to be.
 *
 * `openData` left (ADR-0339). Both window leaves implemented it as the same
 * `openReplica` call and the Bun host refused it outright, because the store is
 * client-owned in every runtime (ADR-0226, ADR-0227): one quarter of this seam
 * was not a seam. What varies by runtime is a Bun-owned file and a keychain,
 * and that is all that is left here.
 */
export type EpicenterBinding = {
	open(name: DatabaseName): Promise<Result<AppSqliteDatabase, AppError>>;
	delete(name: DatabaseName): Promise<Result<void, AppError>>;
	secrets: SecretStore;
};

/**
 * What a `#platform/binding` leaf exports, and what `createEpicenter` takes.
 *
 * A function of `appId` rather than a built binding, so the files and the
 * keychain cannot be scoped to a different application than the store. It is
 * named because it is the seam's contract: every leaf annotates against it, so
 * a leaf that drifts fails to typecheck rather than at a person's runtime.
 */
export type EpicenterBindingFactory = (appId: string) => EpicenterBinding;

/**
 * The store half of the handle: an application's one definition, and the
 * account whose replica it opens.
 *
 * They arrive together or not at all. An authority mints every generation
 * (ADR-0336), so there is no accountless store and no store without sync; an
 * application that passes neither gets a handle with no `data` and no
 * `account`, which is the whole surface Local Mail needs.
 */
export type EpicenterDataOptions<TDefinition extends DataDefinition> = {
	/**
	 * This application's one data definition, which an application has exactly
	 * one of and imports (ADR-0313).
	 */
	definition: TDefinition;
	/**
	 * The account this acts as, which the application constructs and passes in.
	 *
	 * The package does not build one. A desktop leaf needs its own bootstrap
	 * and a browser leaf needs a redirect launcher, and a package that built
	 * both would have to know every auth model an application might use.
	 */
	account: AuthClient;
};

export type CreateEpicenterOptions = {
	/**
	 * What this application owns ON THIS DEVICE: its IndexedDB prefix, its
	 * SQLite files, and its keychain scope.
	 *
	 * The application whose local files, secrets, and replicas this handle
	 * scopes. State it explicitly even when it matches `definition.id`: the
	 * opening application is an independent part of a store address
	 * (ADR-0324), and making it explicit keeps the constructor honest about
	 * the scope it is opening.
	 */
	appId: string;
	/**
	 * The runtime leaf, built for the id this handle resolved.
	 *
	 * A function rather than a value, so the two cannot disagree. A built
	 * binding beside an `appId` is the mismatched pair ADR-0339 is named for:
	 * the handle scoped its store to one application and the binding scoped
	 * the files and the keychain to another, and it compiled. Taking the id
	 * from one place makes that unrepresentable rather than checked.
	 */
	binding: EpicenterBindingFactory;
};

/**
 * One application's Epicenter: five nouns, and verbs under the noun they
 * belong to.
 *
 * `openSqlite` and `deleteSqlite` were two verbs sharing a suffix, which is a
 * noun that had not been written down.
 *
 * `data` is a lazy getter that memoizes. Reading it starts the open, so an
 * application that never reads it pays no Web Lock, no IndexedDB, and no round
 * trip, and reading it twice joins one open. Sync attaches inside, because the
 * account is here.
 *
 * `[TDefinition] extends [never]` fails DOWNWARD: omitting the definition
 * yields the smaller type rather than the larger, so a handle with no store
 * cannot be read as one that has it.
 */
export type Epicenter<TDefinition extends DataDefinition = never> = {
	readonly appId: string;
	readonly sqlite: {
		open(name: DatabaseName): Promise<Result<AppSqliteDatabase, AppError>>;
		/**
		 * Delete one file this application named, and close the owner's handle to
		 * it (ADR-0321).
		 *
		 * There is no `list`, for the same reason `secrets` has none: the
		 * application's own rows are the only thing that knows a name exists. A
		 * name that was never created deletes successfully, because the caller
		 * asked for it to be gone and it is.
		 */
		delete(name: DatabaseName): Promise<Result<void, AppError>>;
	};
	readonly secrets: SecretStore;
} & ([TDefinition] extends [never]
	? // biome-ignore lint/complexity/noBannedTypes: the empty half of the overload IS nothing added.
		{}
	: {
			readonly account: AuthClient;
			/**
			 * This application's store, opened as a replica of `account`, syncing.
			 *
			 * It resolves a `Result`, and the error is the store's own rather than
			 * `AppError.StorageFailed` wrapping it. An application's boot gate
			 * switches on the failure's `name` to choose between a retry and an
			 * erase; wrapping hid that name under `cause`, so every arm became the
			 * fallback and both repairs disappeared.
			 *
			 * A failure is memoized with everything else, so the repair for one is
			 * a document reload rather than a second read. That is what a boot gate
			 * already does: `AlreadyOpen` and `GenerationUnreachable` both repair
			 * with `location.reload()`, and an erase leaves the page. Re-reading
			 * this after a failure joins the same failure.
			 */
			readonly data: Promise<
				Result<ReplicaData<TDefinition>, StoreError | DataDefinitionParseError>
			>;
			/**
			 * Erase this device's copy, whoever it belongs to (ADR-0325).
			 *
			 * `replica` because it erases this device's copy and touches nothing at
			 * the authority, and it is the word a developer reads unsoftened. It
			 * takes every generation, because the refusal it repairs is about the
			 * address rather than about one number.
			 */
			eraseReplica(): Promise<Result<void, StoreError>>;
			/**
			 * End this handle: its socket, its page-hide listener, and the document
			 * holding the Web Lock.
			 *
			 * **Terminal, and idempotent.** It does not forget the open, so this
			 * handle never opens a second store: a read after a close resolves the
			 * same store, closed, and a store that is closed throws on every verb.
			 * Reopening is a new handle, which is what a fresh page is.
			 *
			 * An application does not call this. The page is the lifetime
			 * (ADR-0088), and the two callers that want a lifetime shorter than a
			 * document are a hot reload, which replaces the module that built the
			 * handle and must release its claim before the replacement opens, and a
			 * test.
			 */
			close(): Promise<void>;
		});

export function createEpicenter(options: CreateEpicenterOptions): Epicenter;
export function createEpicenter<const TDefinition extends DataDefinition>(
	options: CreateEpicenterOptions & EpicenterDataOptions<TDefinition>,
): Epicenter<TDefinition>;
/** Create one handle whose every capability is scoped to one application. */
export function createEpicenter<const TDefinition extends DataDefinition>(
	options: CreateEpicenterOptions & Partial<EpicenterDataOptions<TDefinition>>,
): Epicenter<TDefinition> {
	const { definition, account, appId } = options;
	if (!isProtocolAppId(appId)) {
		throw new Error(AppError.InvalidAppId({ appId }).error.message);
	}
	const binding = options.binding(appId);

	const capabilities = {
		appId,
		sqlite: Object.freeze({
			open: (name: DatabaseName) => binding.open(name),
			delete: (name: DatabaseName) => binding.delete(name),
		}),
		secrets: Object.freeze({
			put: (label: SecretLabel, value: string) =>
				binding.secrets.put(label, value),
			get: (label: SecretLabel) => binding.secrets.get(label),
			delete: (label: SecretLabel) => binding.secrets.delete(label),
		}),
	};

	if (definition === undefined && account === undefined) {
		return Object.freeze(capabilities) as Epicenter<TDefinition>;
	}
	if (definition === undefined || account === undefined) {
		throw new Error(
			'The Epicenter definition and account must be provided together.',
		);
	}

	/**
	 * The open, and the store read off it. Two memos set together and never
	 * cleared.
	 *
	 * The pair is memoized rather than the store, so `close` ends the open it
	 * awaited rather than whatever a side slot last pointed at. `exposed` exists
	 * because `data` must be the SAME promise on every read, and the store is one
	 * `.then` away from the pair.
	 */
	let opened:
		| Promise<
				Result<
					OpenedDatabase<TDefinition>,
					StoreError | DataDefinitionParseError
				>
		  >
		| undefined;
	let exposed:
		| Promise<
				Result<ReplicaData<TDefinition>, StoreError | DataDefinitionParseError>
		  >
		| undefined;
	let closing: Promise<void> | undefined;
	/**
	 * Set by `close`, read by the open it may have raced.
	 *
	 * A close before anything was read has nothing to await, and without this a
	 * later read would start an open the handle could never end. An open that
	 * lands after a close closes itself, which is what makes `close` terminal
	 * for the handle rather than for one open.
	 */
	let closed = false;
	return Object.freeze({
		...capabilities,
		account,
		get data() {
			// Memoized here rather than in the opener, because the memo is what
			// makes a second reader join the first open instead of claiming a Web
			// Lock somebody already holds.
			opened ??= openReplica({ appId, definition, account }).then((open) => {
				if (closed && open.error === null) void open.data.close();
				return open;
			});
			exposed ??= opened.then((open) =>
				open.error !== null ? open : Ok(open.data.store),
			);
			return exposed;
		},
		eraseReplica: () => eraseReplicaOf({ appId, definition }),
		close: () =>
			(closing ??= (async () => {
				closed = true;
				if (opened === undefined) return;
				const open = await opened;
				if (open.error === null) await open.data.close();
			})()),
	}) as Epicenter<TDefinition>;
}
