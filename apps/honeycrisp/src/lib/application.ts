import type { AuthClient } from '@epicenter/auth';
import type { Store, StoreError } from '@epicenter/data';
import { open as openBrowser } from '@epicenter/data/browser';
import {
	type RebuildError,
	rebuildWorkspace,
	type SyncConnection,
	type SyncConnectionStatus,
} from '@epicenter/data/sync';
import { type HoneycrispData, honeycrispLens } from '@epicenter/honeycrisp';
import type { Result } from 'wellcrafted/result';
import { createHoneycrispState } from '../routes/state/index.js';
import { reportBackgroundError } from './report.js';
import { attachHoneycrispSync } from './sync.js';

export type OpenHoneycrispOptions = {
	/**
	 * This build's auth, when it has one.
	 *
	 * Passed in rather than imported, and it is the one thing that still is.
	 * `#platform/auth`'s Tauri leaf consumes a one-shot global the host preloads
	 * (`window.__EPICENTER_HONEYCRISP_AUTH_BOOTSTRAP__`) at module scope and
	 * throws when it is absent, so importing it here would run that under test
	 * and during prerender. The caller is a mounted client route, where it is
	 * safe.
	 *
	 * Its state chooses which durable document this generation edits and whose
	 * it is (ADR-0233), and being signed in is the whole of the sharing model:
	 * the route stamps the principal from the bearer and addresses one Durable
	 * Object by it, so every device on one account converges without anything
	 * being paired or invited. The same principal id names this device's local
	 * replica of that account, which is why signing out can keep it.
	 */
	auth?: AuthClient;
	signal?: AbortSignal;
};

export type HoneycrispApplication = {
	/** The synchronous view of this store through Honeycrisp's Lens. */
	readonly db: HoneycrispData;
	readonly state: ReturnType<typeof createHoneycrispState>;
	/** How much of this document is dead weight, for whatever wants to show it. */
	pressure(): Store['pressure'] extends () => infer TResult ? TResult : never;
	/**
	 * What sync is doing, or undefined when sync is not part of this app
	 * generation: a device-document generation (signed out, or a build with
	 * no auth at all), or a bound account replica whose dials were permanently
	 * denied and now works offline. Both render the same way, which is not
	 * at all.
	 */
	syncStatus(): SyncConnectionStatus | undefined;
	/**
	 * Rebuild this workspace (ADR-0231), or undefined in a device-document
	 * generation, where there is no workspace to rebuild.
	 *
	 * The one product action over the one wire verb. On success this device
	 * discards its local workspace store whole and reloads; the fresh boot
	 * re-downloads the document it just published, through the same join every
	 * device runs. The confirmation a surface shows before calling this
	 * carries the one warnable loss: a device holding offline changes it never
	 * synced will lose them.
	 *
	 * The argument says the caller has shown that warning and received a
	 * deliberate answer. This application layer cannot render the
	 * confirmation, but requiring the named acknowledgement keeps a future
	 * call site from treating rebuild as ordinary maintenance.
	 */
	rebuild?(confirmation: {
		acknowledgedWorkspaceChangesMayBeLost: true;
	}): Promise<Result<{ document: string }, RebuildError | StoreError>>;
	[Symbol.asyncDispose](): Promise<void>;
};

/**
 * Open one Honeycrisp, hydrated and ready to read synchronously.
 *
 * The only asynchronous thing left in this application. Opening a store is real
 * I/O: a directory or an OPFS pool, a WASM compile, and the replay of a durable
 * log. Everything after it is a property access on a document already in memory,
 * which is why nothing below this line returns a promise.
 *
 * Which document opens is auth's answer at boot (ADR-0233): signed out is the
 * device document, and a known principal is that account's own replica, at an
 * address no other account shares. A page lifetime is
 * one auth generation (ADR-0232), so the choice never changes while this
 * application lives; signing in, out, or into a second account reloads into a
 * different document, and none of them ever reads another's storage. Signing
 * out closes an account replica and keeps it, so signing back in finds the
 * same account's work, offline edits included.
 *
 * A device generation resolves at once and never dials: a device document
 * has no sync to wait for. An account generation resolves only with a
 * workspace that is safe to edit (ADR-0231). A store already bound to an
 * authority document resolves at once and syncs or works offline as ever. An
 * unbound store is UNAVAILABLE: this promise stays pending, behind the
 * layout's boot gate, until the first bootstrap binds it. If the dial is
 * permanently denied first, it REJECTS with the honest answer instead: a
 * signed-in workspace whose credential is refused is unavailable, never
 * quietly the device document. There is no moment where a signed-in,
 * never-downloaded workspace takes edits that a later bootstrap would have
 * to discard.
 */
export async function openHoneycrispApplication({
	auth,
	signal,
}: OpenHoneycrispOptions = {}): Promise<HoneycrispApplication> {
	signal?.throwIfAborted();
	// The one decision point between the documents. A signed-out generation, or
	// a build with no auth at all, edits the device document; a generation with
	// a principal edits that principal's account replica. `workspace` carries
	// the auth alongside the account so everything sync-shaped below can only
	// exist where a workspace document is the one that opened.
	const workspace =
		auth !== undefined && auth.state.status !== 'signed-out'
			? { auth, principalId: auth.state.principalId }
			: undefined;
	// The lens names the application and this names the document and its owner
	// (ADR-0233), so there is nothing else to inject: no path, no database name,
	// and no second call to bind. An auth state carrying no usable principal id
	// is refused here as `Unaddressable` rather than guessing an address: a
	// signed-in generation with no account is unavailable, and never quietly the
	// device document.
	const { data: db, error } = await openBrowser(
		honeycrispLens,
		workspace === undefined
			? { owner: 'device' }
			: { owner: 'account', principalId: workspace.principalId },
	);
	if (error !== null) throw error;
	let sync: SyncConnection | undefined;
	let state: ReturnType<typeof createHoneycrispState> | undefined;
	try {
		signal?.throwIfAborted();
		state = createHoneycrispState({ db });
		/**
		 * The one adoption path (ADR-0231): discard the workspace store whole and
		 * reload. Runs after a confirmed supersession, and after this device's
		 * own successful rebuild; the fresh boot's ordinary join delivers the
		 * current document into an empty replica. What it can reach is one
		 * address: this generation's own account replica. The device document
		 * and every other account's replica are databases this generation never
		 * opened and cannot name.
		 */
		const adoptCurrentDocument = async (): Promise<void> => {
			const discarded = await db.store.discard();
			if (discarded.error !== null) reportBackgroundError(discarded.error);
			location.reload();
		};
		let denied = false;
		let noticeDenied: (() => void) | undefined;
		sync =
			workspace === undefined
				? undefined
				: attachHoneycrispSync({
						store: db.store,
						auth: workspace.auth,
						onSuperseded: () => void adoptCurrentDocument(),
						onDenied: () => {
							denied = true;
							noticeDenied?.();
						},
					});
		/**
		 * The bound gate (ADR-0231). A signed-in workspace becomes editable in
		 * exactly one way: being bound to an authority document. Until then this
		 * promise stays pending and the layout shows its boot gate, so an
		 * unbound editable workspace cannot render. A permanent denial while
		 * unbound rejects instead (ADR-0233): the credential this generation
		 * holds can never bootstrap, and only an auth change can repair that,
		 * which starts the next generation. A supersession during the wait
		 * discards and reloads, so this promise simply never resolves in that
		 * generation.
		 */
		const bound = (): boolean =>
			db.store.sync.documentIdentity().data !== undefined;
		if (sync !== undefined && !bound()) {
			await new Promise<void>((resolve, reject) => {
				function cleanup(): void {
					stopCommitted();
					noticeDenied = undefined;
					signal?.removeEventListener('abort', onAbort);
				}
				function finish(): void {
					cleanup();
					resolve();
				}
				function unavailable(): void {
					cleanup();
					reject(
						new Error(
							'This workspace is signed in, but its credential was refused before the first download. Sign in again to load it.',
						),
					);
				}
				function onAbort(): void {
					cleanup();
					reject(signal?.reason);
				}
				// The stamp is a commit, so `onCommitted` is the notification that
				// the workspace became bound; denial arrives through the callback
				// wired above, which may already have fired.
				const stopCommitted = db.store.onCommitted(() => {
					if (bound()) finish();
				});
				noticeDenied = unavailable;
				signal?.addEventListener('abort', onAbort, { once: true });
				if (bound()) finish();
				else if (denied) unavailable();
			});
		}
		let disposed = false;
		const ready = state;
		return Object.freeze({
			db,
			state: ready,
			pressure: () => db.store.pressure(),
			syncStatus: () => {
				const status = sync?.status();
				return status === undefined || status.denied ? undefined : status;
			},
			rebuild:
				workspace === undefined
					? undefined
					: async ({ acknowledgedWorkspaceChangesMayBeLost }) => {
							if (!acknowledgedWorkspaceChangesMayBeLost) {
								throw new Error(
									'workspace rebuild requires explicit confirmation',
								);
							}
							const published = await rebuildWorkspace({
								store: db.store,
								transport: {
									fetch: (input, init) => workspace.auth.fetch(input, init),
									baseURL: workspace.auth.deployment.baseURL,
									namespace: honeycrispLens.namespace,
								},
							});
							if (published.error !== null) return published;
							// Authority first, then local, then reload: the same order and
							// the same adoption every superseded replica runs.
							sync?.[Symbol.dispose]();
							await adoptCurrentDocument();
							return published;
						},
			async [Symbol.asyncDispose]() {
				if (disposed) return;
				disposed = true;
				sync?.[Symbol.dispose]();
				ready[Symbol.dispose]();
				await db[Symbol.asyncDispose]();
			},
		}) as HoneycrispApplication;
	} catch (cause) {
		// The gate can throw (an aborted boot, a denied unbound workspace) after
		// sync and state exist, so the failure path lets go of everything the
		// try acquired.
		sync?.[Symbol.dispose]();
		state?.[Symbol.dispose]();
		await db[Symbol.asyncDispose]().catch(() => undefined);
		throw cause;
	}
}
