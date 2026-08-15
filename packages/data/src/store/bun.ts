import { Database } from 'bun:sqlite';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import {
	type ParsedWorkspace,
	parseWorkspace,
	type WorkspaceJson,
	type WorkspaceParseError,
} from '@epicenter/workspace';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import { claimDocument, releaseDocument } from './claims.js';
import { applyHistorySchema, createSqliteDurablePort } from './log.js';
import {
	type AccountStore,
	asData,
	createAccountStore,
	createAccountStoreOverPort,
	type DataOf,
	StoreError,
	type UntypedWorkspaceView,
	type WorkspaceView,
} from './store.js';

export type BunAccountStore = AccountStore & {
	/**
	 * Delete this store's live file whole, disposing the store first.
	 *
	 * ADR-0231's one client-side deletion: a replica whose document was replaced
	 * discards and rejoins at zero. `history.sqlite3` survives on purpose; it
	 * is the owner's shelf, and the shelf is what makes an undone replace a
	 * restore rather than a loss. Terminal for this store; the caller reopens
	 * fresh and the ordinary join is the whole of adoption.
	 */
	discard(): Promise<Result<void, StoreError>>;
};

/**
 * Open the application this workspace names, on Bun.
 *
 * The workspace names the store (ADR-0229), so the folder is
 * `<root>/<workspace.id>` rather than a path a caller picks. The root
 * is where Epicenter lives on this machine (ADR-0201), which is an environment
 * fact rather than a second name for the application.
 *
 * **No application in this repository calls this today.** Honeycrisp opens the
 * browser store in every build including the Tauri one, by the refusal in
 * `apps/honeycrisp/src/lib/runtime.ts`: a host serves bundles and owns no
 * application data (ADR-0226). This stays exported because it is a
 * published entry point of an MIT package and because it is the only opener
 * that proves the log survives a real reopen from a real file, which
 * `store.test.ts` uses. An in-repo caller returning is a decision, not a
 * default.
 */
export async function open<const TWorkspace extends WorkspaceJson>(
	workspace: TWorkspace,
	{
		root,
		keepHistory = true,
	}: {
		/** Where Epicenter keeps application folders on this machine (ADR-0201). */
		root: string;
		/** Whether collapse preserves what it supersedes (ADR-0214). */
		keepHistory?: boolean;
	},
): Promise<
	Result<DataOf<TWorkspace, BunAccountStore>, StoreError | WorkspaceParseError>
> {
	// Parsed before anything is claimed or opened: a declaration may arrive as
	// data, and a refusal here is a boot outcome rather than a programmer
	// error (ADR-0240).
	const { data: parsed, error: parseError } = parseWorkspace(workspace);
	if (parseError !== null) return Err(parseError);

	const { error: claimError } = claimDocument(parsed.id);
	if (claimError !== null) return Err(claimError);

	const opened = await openBunStore({
		directory: join(root, parsed.id),
		workspace: parsed,
		keepHistory,
	});
	if (opened.error !== null) {
		releaseDocument(parsed.id);
		return Err(opened.error);
	}
	const { store, view } = opened.data;
	return Ok(
		asData<TWorkspace, BunAccountStore>(
			store,
			// Through `unknown` deliberately: comparing the untyped view with
			// `WorkspaceView<TWorkspace>` re-enters the per-field arktype
			// instantiation and exceeds the depth limit.
			view as unknown as WorkspaceView<TWorkspace>,
		),
	);
}

/**
 * @param directory The application's own folder. `store.sqlite3` holds the
 * update log; `history.sqlite3` holds what collapse superseded.
 */
async function openBunStore({
	directory,
	workspace,
	keepHistory = true,
}: {
	directory: string;
	workspace: ParsedWorkspace;
	/**
	 * Whether collapse preserves what it supersedes (ADR-0214).
	 *
	 * On by default: one changed field is 43 bytes on the wire, so at a hundred
	 * edits a day history costs about 4 KB a day, which is cheap enough to keep
	 * without anyone deciding to.
	 */
	keepHistory?: boolean;
}): Promise<
	Result<{ store: BunAccountStore; view: UntypedWorkspaceView }, StoreError>
> {
	const { error: directoryError } = await tryAsync({
		try: () => mkdir(directory, { recursive: true }),
		catch: (cause) => StoreError.StorageFailed({ cause }),
	});
	if (directoryError !== null) return Err(directoryError);

	// Everything from the first file handle to a constructed engine can throw:
	// an unopenable file, a corrupt log at `port.load()`, a stored update the
	// hydration replay cannot decode. All of it is "the store could not read
	// its durable record", which is `StorageFailed`'s exact contract, and a
	// thrown escape here would leak the caller's claim and these handles, so
	// the whole construction is contained and cleaned up on refusal.
	let live: Database | undefined;
	let historyDatabase: Database | undefined;
	try {
		live = new Database(join(directory, 'store.sqlite3'));
		historyDatabase = keepHistory
			? new Database(join(directory, 'history.sqlite3'))
			: undefined;
		const history =
			historyDatabase === undefined
				? undefined
				: createBunSqliteAdapter(historyDatabase);
		if (history !== undefined) applyHistorySchema(history);

		const port = createSqliteDurablePort({
			database: createBunSqliteAdapter(live),
			history,
		});
		const opened = live;
		const openedHistory = historyDatabase;
		const { store, view } = createAccountStoreOverPort({
			workspace,
			durable: port,
			loaded: port.load(),
			dispose: () => {
				opened.close();
				openedHistory?.close();
				releaseDocument(workspace.id);
			},
		});
		return composeBunStore({ store, view, directory });
	} catch (cause) {
		live?.close();
		historyDatabase?.close();
		return StoreError.StorageFailed({ cause });
	}
}

function composeBunStore({
	store,
	view,
	directory,
}: {
	store: AccountStore;
	view: UntypedWorkspaceView;
	directory: string;
}): Result<{ store: BunAccountStore; view: UntypedWorkspaceView }, StoreError> {
	return Ok({
		store: Object.freeze({
			...store,
			async discard(): Promise<Result<void, StoreError>> {
				// Dispose first so the file handles are closed before the unlink,
				// then delete the live file and its journals whole. The history
				// file is deliberately not touched: it is the owner's shelf.
				await store[Symbol.asyncDispose]();
				return tryAsync({
					try: async () => {
						for (const suffix of ['', '-wal', '-shm']) {
							await rm(join(directory, `store.sqlite3${suffix}`), {
								force: true,
							});
						}
					},
					catch: (cause) => StoreError.StorageFailed({ cause }),
				});
			},
		}),
		view,
	});
}

/**
 * Open an application that lives only as long as the process. Test support.
 *
 * It takes the workspace for the same reason `open` does, so one entry point
 * has one shape. It claims no address, and that is not an oversight: two
 * memory stores of one workspace id are two independent documents by
 * construction, which is the two-devices case rather than the
 * two-handles-on-one-file case the claim exists to refuse.
 */
export function openMemory<const TWorkspace extends WorkspaceJson>(
	workspace: TWorkspace,
): DataOf<TWorkspace, AccountStore> {
	const live = new Database(':memory:');
	const history = createBunSqliteAdapter(new Database(':memory:'));
	applyHistorySchema(history);
	return createAccountStore({
		workspace,
		database: createBunSqliteAdapter(live),
		history,
		dispose: () => live.close(),
	});
}
