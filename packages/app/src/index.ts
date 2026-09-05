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
import { Err, Ok, type Result } from 'wellcrafted/result';
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
 * What can end an open without the store having refused anything.
 *
 * Two variants, and neither is the store's business. A close that lands while
 * an open is in flight ends what that open acquired, and the caller awaiting it
 * has to be told: answering `Ok` with a store whose every verb throws is a
 * success over a dead document, and `openWhisperingApp` reads exactly that
 * channel. An opener that REJECTS is the other: `openReplica` contains its own
 * throws, and a promise that breaks that contract must not leave a session
 * wedged in `opening` with no way back.
 */
export const DataSessionError = defineErrors({
	SessionClosed: () => ({
		message: 'This data session was closed while it was opening.',
	}),
	OpenerThrew: ({ cause }: { cause: unknown }) => ({
		message: 'Opening this data session threw instead of resolving.',
		cause,
	}),
});
export type DataSessionError = InferErrors<typeof DataSessionError>;

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
 * What a store can fail to open with: the store's own refusals, and a
 * declaration this release cannot read.
 *
 * Named because four surfaces state it and three of them were writing the
 * union out. It is deliberately not narrowed to "the ones a person sees": a
 * boot node switches on `name` and falls through, so a new refusal reaching an
 * application is a sentence to write rather than a type to widen.
 *
 * `DataSessionError` is in it because an open can end for a reason that is
 * about the session rather than about the store: closed underneath, or an
 * opener that rejected. Neither reaches `state`, which reports `closed` for the
 * first and `failed` for the second, but both reach whoever awaited `open`.
 */
export type DataOpenError =
	| StoreError
	| DataDefinitionParseError
	| DataSessionError;

/**
 * Where one data session is: four states, and the data rides on `ready`.
 *
 * ONE property rather than a `status` beside a `data`, and that is not taste.
 * TypeScript narrows a discriminated union and cannot correlate two
 * properties, so a flat pair would leave `data` optional at every read site
 * and "you cannot read the store before it is open" would stop being a rule
 * the compiler keeps.
 *
 * **`closed` is the whole of "this session holds nothing".** It is where a
 * fresh handle starts and where `close` returns it, because those are the same
 * fact: no lock, no connection, no document. Nothing distinguishes them for
 * any caller, so nothing here does either.
 *
 * **There is no `already-open` state.** An ownership conflict is one of the
 * refusals `open` can answer with, and it arrives as `failed` carrying
 * `StoreError.AlreadyOpen`. Promoting it would put one failure in the state
 * machine and the other six in an error, so a surface would switch on
 * `status` and then switch on `name` anyway; Honeycrisp's boot node already
 * does the second switch, and it does it in one place.
 *
 * **`data` is the typed application data and nothing else.** It carries no
 * `open`, no `close`, no `erase`, and no disposal: those belong to the session
 * that acquired the lock, the socket, and the listener together, and a store
 * that could free one of the three would leave a connection dialling against a
 * document whose every verb throws (ADR-0340).
 */
export type EpicenterState<TDefinition extends DataDefinition> =
	| { readonly status: 'closed' }
	| { readonly status: 'opening' }
	| { readonly status: 'ready'; readonly data: ReplicaData<TDefinition> }
	| { readonly status: 'failed'; readonly error: DataOpenError };

/**
 * One application's Epicenter: five nouns, and verbs under the noun they
 * belong to.
 *
 * `openSqlite` and `deleteSqlite` were two verbs sharing a suffix, which is a
 * noun that had not been written down.
 *
 * **Construction is inert and opening is a verb.** `createEpicenter` claims no
 * Web Lock, touches no IndexedDB, and makes no round trip; `open` does all
 * three, and `state` is how a surface watches it. `data` used to be a lazy
 * getter whose READ started the open, which put substantial asynchronous
 * resource acquisition behind property syntax: an application could not say
 * when it happened, a surface could not retry it, and a `{ ...epicenter }`
 * anywhere claimed a lock. Sync attaches inside `open`, because the account is
 * here.
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
			 * Where this session is, right now. Reading it acquires nothing.
			 *
			 * A snapshot, not a subscription: `onStateChange` is how a caller hears
			 * about the next one, and `@epicenter/svelte` is what turns the pair
			 * into a rune. Reading this from a framework that has neither is a
			 * plain property read that answers `closed` until something opens.
			 */
			readonly state: EpicenterState<TDefinition>;
			/**
			 * Open this application's store as a replica of `account`, syncing.
			 *
			 * **This is the only thing that acquires.** It claims the Web Lock,
			 * opens IndexedDB, hydrates the document, dials sync, and attaches the
			 * flush-on-hide listener. An application calls it once, from its root,
			 * after authentication is ready.
			 *
			 * Deterministic under repetition, and each case is a different answer
			 * rather than the same one three times. While `opening`, every caller
			 * joins the one attempt. While `ready`, it resolves the open store and
			 * acquires nothing. While `failed`, it RETRIES: `AlreadyOpen` is
			 * repaired by the other window closing and `GenerationUnreachable` by
			 * the network returning, and neither of those is a repair a person can
			 * perform if the answer is memoized. While `closed` after a close, it
			 * opens again.
			 *
			 * It resolves a `Result`, and the error is the store's own rather than
			 * `AppError.StorageFailed` wrapping it. An application's boot node
			 * switches on the failure's `name` to choose between a retry and an
			 * erase; wrapping hid that name under `cause`, so every arm became the
			 * fallback and both repairs disappeared.
			 */
			open(): Promise<Result<ReplicaData<TDefinition>, DataOpenError>>;
			/**
			 * Hear about the next state, and stop hearing about it.
			 *
			 * The current state is not replayed: a caller already has it from
			 * `state`, and replaying it would make a subscriber that renders on
			 * every call render once for a transition that did not happen.
			 */
			onStateChange(
				listener: (state: EpicenterState<TDefinition>) => void,
			): () => void;
			/**
			 * Erase this account's copy on this device, and nothing at the
			 * authority.
			 *
			 * `replica` because that is exactly what it deletes, and it is the word
			 * a developer reads unsoftened. It takes every generation this account
			 * holds through this application: erasing only the newest would leave
			 * the number below it to be opened next boot.
			 *
			 * **It closes the session first, so it succeeds from every state.**
			 * Erasing takes the same Web Lock an open holds, and this handle is the
			 * one thing that can let that lock go, so requiring a caller to close
			 * first would be a two-step verb whose first step only this object can
			 * perform. A person invokes this from an account surface while their
			 * data is open, which is the whole live path.
			 *
			 * **A failure rolls the close back.** A session that was serving data,
			 * or acquiring it, and whose erase did not happen is REOPENING when
			 * this resolves: the state is `opening` and settles to `ready` on its
			 * own. What it must never be is `closed`, which is the one state
			 * nothing leaves by itself and no boot node offers a button for. The
			 * close is a means, not the act, and it is not kept when the act fails.
			 *
			 * The caller reports the error through a surface that OUTLIVES the
			 * shell, because the close already unmounted the one that invoked this.
			 * That is why an application's confirmation dialog and toaster are
			 * mounted above its boot node rather than inside it.
			 *
			 * `AlreadyOpen` is still reachable and still means what it says: ANOTHER
			 * window of this application holds the same address, and closing it is
			 * the repair.
			 */
			eraseReplica(): Promise<Result<void, StoreError>>;
			/**
			 * Release everything `open` acquired: the socket, the page-hide
			 * listener, and the document holding the Web Lock.
			 *
			 * Idempotent, and it returns the session to `closed`, which is the same
			 * `closed` a fresh handle starts in. It is not terminal, and that is a
			 * decision rather than a new feature: terminal was a property of the
			 * memoized getter this replaces, and keeping it would need a fifth
			 * state that only a hot reload and a test could ever observe, to refuse
			 * a call neither of them makes.
			 *
			 * A close that lands while an open is in flight ends what that open
			 * acquired and publishes nothing for it, so the session never reports
			 * `ready` for a store nobody can reach.
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
	 * The session, held in locals and nothing else.
	 *
	 * `held` is what `open` acquired: the store AND the closer for all three
	 * things opening took (ADR-0340). `current` is the one in-flight open every
	 * concurrent caller joins, tagged with the epoch it belongs to. `epoch` is
	 * bumped by `close`, so an open that lands after one recognises that the
	 * session it was opening for is gone, ends what it acquired, and publishes
	 * nothing. `closing` is the in-flight close, so a second one joins the first
	 * rather than resolving while the lock is still being let go.
	 *
	 * **Two rules keep the four of them honest.** `current` is cleared by the
	 * attempt that set it, and only AFTER that attempt has finished releasing;
	 * `close` never clears it, because clearing it early lets a second `open`
	 * ask for a Web Lock the first one has not let go of yet and meet a
	 * conflict with no other window in it.
	 */
	let held: OpenedDatabase<TDefinition> | undefined;
	let current:
		| {
				readonly epoch: number;
				readonly attempt: Promise<
					Result<ReplicaData<TDefinition>, DataOpenError>
				>;
		  }
		| undefined;
	let closing: Promise<void> | undefined;
	let epoch = 0;
	let state: EpicenterState<TDefinition> = { status: 'closed' };
	const listeners = new Set<(state: EpicenterState<TDefinition>) => void>();

	function publish(next: EpicenterState<TDefinition>): void {
		state = next;
		// A copy, because a listener is allowed to unsubscribe itself while it
		// is being told.
		for (const listener of [...listeners]) listener(next);
	}

	const open = (): Promise<Result<ReplicaData<TDefinition>, DataOpenError>> => {
		// An open asked for during a close is asking for the session AFTER it.
		// Joining the in-flight attempt would hand it the one the close is
		// ending, which resolves `SessionClosed`; starting a second one now would
		// race the lock the close is still letting go of.
		if (closing !== undefined) return closing.then(open);
		if (current !== undefined) return current.attempt;
		if (held !== undefined) return Promise.resolve(Ok(held.store));
		const mine = epoch;
		const attempt = (async (): Promise<
			Result<ReplicaData<TDefinition>, DataOpenError>
		> => {
			// Contained rather than propagated. `openReplica` resolves a `Result`
			// and contains its own throws, and a promise that breaks that anyway
			// would otherwise leave `current` set forever: every later `open`
			// would return the same rejection and `close` would rethrow it, which
			// is a session with no way out of `opening`.
			const opened = await openReplica({ appId, definition, account }).catch(
				(cause: unknown) => DataSessionError.OpenerThrew({ cause }),
			);
			if (opened.error !== null) {
				current = undefined;
				// A close that raced this has already published `closed`, and a
				// failure that arrives afterwards is about a session nobody is
				// watching any more.
				if (mine === epoch) publish({ status: 'failed', error: opened.error });
				return Err(opened.error);
			}
			if (mine !== epoch) {
				// Closed while this was opening. What it acquired is released here,
				// because the close had nothing to release when it ran, and
				// `current` stays set until the release is done so the next `open`
				// cannot race the lock on its way out.
				await opened.data.close();
				current = undefined;
				return DataSessionError.SessionClosed();
			}
			held = opened.data;
			current = undefined;
			publish({ status: 'ready', data: opened.data.store });
			return Ok(opened.data.store);
		})();
		// Set BEFORE anything is published, so a listener that calls `open` while
		// being told about `opening` joins this attempt rather than starting a
		// second one against the same address.
		current = { epoch: mine, attempt };
		publish({ status: 'opening' });
		return attempt;
	};

	const close = (): Promise<void> =>
		// Memoized while it runs, so a second caller awaits the same release
		// rather than finding `held` already cleared and reporting `closed` over
		// a lock the first one is still letting go of. Cleared afterwards,
		// because a closed session opens again.
		(closing ??= (async () => {
			try {
				epoch += 1;
				// Awaited before anything is released, so a close during an open
				// ends what that open acquires rather than returning while it is
				// still acquiring it. The open's own settle sees the stale epoch,
				// closes itself, and clears `current`, which is why nothing is
				// read off this.
				const inFlight = current;
				if (inFlight !== undefined) await inFlight.attempt;
				const acquired = held;
				held = undefined;
				if (acquired !== undefined) await acquired.close();
				if (state.status !== 'closed') publish({ status: 'closed' });
			} finally {
				closing = undefined;
			}
		})());

	return Object.freeze({
		...capabilities,
		account,
		get state() {
			return state;
		},
		open,
		onStateChange: (listener: (state: EpicenterState<TDefinition>) => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		// Closed first, because erasing takes the Web Lock this session is holding
		// and this handle is the only thing that can release it. `close` is
		// idempotent and returns the session to `closed`, which is where a
		// successful erase leaves it: there is nothing on this device to reopen.
		//
		// **A failed erase rolls the session back.** Closing is not the deletion,
		// it is what the deletion needs, so a session that was serving data before
		// an erase that did not happen has to be serving it again afterwards.
		// Without this the handle publishes `closed` and stops: the surface that
		// invoked this unmounts with it, the failure is reported to nobody, and
		// the person is left on a screen with no data and no button. Reopening is
		// the same call a retry would make, and it takes the lock straight back
		// because nothing else claimed it in between.
		//
		// **Every state but `closed` is rolled back**, rather than `ready` alone.
		// `closed` is the one where declining is right: nothing was serving data,
		// and a test or a hot reload that closed deliberately should stay closed.
		// `opening` and `failed` were both sessions somebody was looking at, and
		// this verb is forwarded at the top level of `fromEpicenter` precisely so
		// it can be called from anywhere, so the guarantee has to be the
		// unconditional one the boot nodes state.
		eraseReplica: async () => {
			const wasOpen = state.status !== 'closed';
			await close();
			const erased = await eraseReplicaOf({ appId, definition, account });
			if (erased.error !== null && wasOpen) void open();
			return erased;
		},
		close,
	}) as Epicenter<TDefinition>;
}
