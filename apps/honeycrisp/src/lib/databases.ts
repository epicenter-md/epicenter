import type { AuthClient } from '@epicenter/auth';

/**
 * The principal half of an account address, as the auth client states it.
 *
 * Taken from `AuthClient` rather than from `@epicenter/principal`, so this app
 * depends on the client it already holds rather than on the identity package
 * behind it.
 */
type PrincipalId = Extract<
	AuthClient['state'],
	{ principalId: unknown }
>['principalId'];

import type { ReplicaData } from '@epicenter/data';
import {
	type CheckoutError,
	diff,
	type PushOutcome,
	type PushPlan,
	pull,
	push,
} from '@epicenter/data/artifact/checkout';
import {
	type DatabaseAccount,
	eraseGenerations,
	openDatabase,
	resolveGeneration,
} from '@epicenter/data/browser';
import { persistOnHide } from '@epicenter/data/flush-on-hide';
import type { SyncConnectionStatus } from '@epicenter/data/sync';
import { honeycrispDefinition } from '@epicenter/honeycrisp';
import {
	Err,
	isOk,
	Ok,
	type Result,
	tryAsync,
	trySync,
} from 'wellcrafted/result';
import { reportBackgroundError } from './report.js';
import { attachHoneycrispSync } from './sync.js';

/** The application this opens its store as, self-claimed (ADR-0324, ADR-0334). */
const APP_ID = 'so.epicenter.honeycrisp';

/**
 * A database being opened: one promise to render, and a disposal that waits.
 *
 * Returned synchronously, which is what makes it disposable before it is open.
 * A route registers `disposeOnUnmount(db)` on the first line and awaits
 * `db.ready` in the markup, and navigating away mid-open disposes what
 * finishes opening afterwards without anyone reaching into a promise to do it.
 *
 * `ready` settles at the only moment a route renders differently, and it
 * REJECTS rather than resolving a `Result`. `packages/data` returns `Result`
 * everywhere and should: that type is for a caller that branches on the error
 * or composes it onward. A route does neither. Every failure here is terminal
 * and renders one component, and `{#await}` already has a failure channel, so
 * carrying `Result` past this file bought a second one. The account route
 * rendered its gate from four places, two `isOk` arms and two `:catch` arms,
 * and not one of them looked at the error.
 */
export type OpeningDatabase<TDatabase> = AsyncDisposable & {
	readonly ready: Promise<TDatabase>;
};

/**
 * One handle over two promises: what a route renders, and what disposal owes.
 *
 * They are not the same promise for the account, where a store that opened and
 * never became ready still has to be closed, and the split lives here rather
 * than in a route because it is bookkeeping rather than a rendering decision.
 * Neither promise can go unhandled: `ready` is derived from `opening`, so a
 * failed open is reported through the surface waiting on it, and disposal
 * attaches its own arm only if it is ever called.
 */
function opening<TDatabase>(
	opened: Promise<AsyncDisposable>,
	ready: Promise<TDatabase>,
): OpeningDatabase<TDatabase> {
	return {
		ready,
		async [Symbol.asyncDispose]() {
			const resource = await opened.catch(() => undefined);
			if (resource !== undefined) await resource[Symbol.asyncDispose]();
		},
	};
}

/** What the notebook route renders once its replica is safe to edit. */
export type AccountDatabase = {
	readonly data: ReplicaData<typeof honeycrispDefinition>;
	syncStatus(): SyncConnectionStatus | undefined;
	/**
	 * Fill `~/Epicenter/so.epicenter.honeycrisp/` with these notes and write
	 * the manifest (ADR-0337).
	 *
	 * Bound to this store and this generation, because those are what the
	 * manifest records and neither is a component's to know. It refuses a
	 * folder holding unpushed edits, and `discardEdits` is the person saying
	 * they saw them and want them gone.
	 */
	pull(options?: {
		discardEdits?: boolean;
	}): Promise<Result<{ files: number }, CheckoutError>>;
	/** What a push would do, changing nothing (ADR-0337). */
	diff(): Promise<Result<PushPlan, CheckoutError>>;
	/**
	 * Apply the folder, whole, then re-render (ADR-0338).
	 *
	 * `plan` is what `diff` said and a person approved. A push that finds it is
	 * no longer true refuses rather than applying a list nobody read.
	 */
	push(options: {
		plan: PushPlan;
	}): Promise<Result<PushOutcome, CheckoutError>>;
};

type Opened<TDatabase> = TDatabase & AsyncDisposable;

/**
 * Open one account's retained replica of one generation.
 *
 * Opening and becoming safe to edit used to be two moments, and collapsing
 * them is the change ADR-0292 bought. A fresh
 * replica was unavailable until the authority stamped it with the document it
 * belonged to, so this function carried a readiness promise, a supersession
 * handler, and a discard-and-reload. The generation is the address, a
 * generation is created complete, and a cache hit is bound; what is left is
 * open, attach a socket, and return.
 *
 * The handle is disposable immediately, so navigating away mid-open closes
 * what finishes opening afterwards.
 */
export function openAccountDatabase(options: {
	auth: AuthClient;
	generation: number;
	principalId?: PrincipalId;
}): OpeningDatabase<AccountDatabase> {
	const opened = openAccountReplica(options);
	return opening(opened, opened);
}

async function openAccountReplica({
	auth,
	generation,
	principalId = auth.state.status === 'signed-out'
		? undefined
		: auth.state.principalId,
}: {
	auth: AuthClient;
	generation: number;
	principalId?: PrincipalId;
}): Promise<Opened<AccountDatabase>> {
	// A signed-out auth states no principal, and this hands that fact to the
	// opener rather than throwing a hand-made `Error` with `Unaddressable`
	// written onto its `name`. `canonicalBinding` refuses an account that names
	// no principal before anything is claimed or created, so the refusal a route
	// sees comes from the one place that decides it. Routes gate on signed-out
	// before they get here; this is what makes the gate an optimization rather
	// than the guard.
	const { data, error } = await openDatabase(honeycrispDefinition, {
		appId: APP_ID,
		generation,
		account: honeycrispAccount(auth, principalId ?? ('' as PrincipalId)),
	});
	if (error !== null) throw error;

	const connectionResult = trySync({
		try: () => attachHoneycrispSync({ store: data, auth }),
		catch: (cause) => Err(cause),
	});
	if (!isOk(connectionResult)) {
		await disposeQuietly(data);
		throw connectionResult.error;
	}
	const connection = connectionResult.data;

	// Durable work is what a reconnect offers the authority, so a flush that
	// never happened is work the account never hears about either.
	const stopHideFlush = persistOnHide(() => data.persistence.flush());

	return {
		data,
		syncStatus: () => {
			const status = connection.status();
			return status.denied ? undefined : status;
		},
		// The store states its own address (ADR-0340), so a verb takes the store
		// and nothing else describing it. This used to assemble a
		// `folderArguments` object out of the data and a generation kept beside
		// it, which is the last place a folder could have been addressed at a
		// generation the store is not.
		pull: ({ discardEdits = false } = {}) =>
			pull({ data, definition: honeycrispDefinition, discardEdits }),
		diff: () => diff({ data, definition: honeycrispDefinition }),
		push: ({ plan }) => push({ data, definition: honeycrispDefinition, plan }),
		async [Symbol.asyncDispose]() {
			stopHideFlush();
			connection[Symbol.dispose]();
			await data[Symbol.asyncDispose]();
		},
	};
}

/**
 * The generation this device should open.
 *
 * One call, because the decision is one and it lives in `packages/data`: cache
 * first, then the account's own list, and a mint only when that list comes back
 * empty. This app used to hand-roll it, along with a `new Error` carrying a
 * hand-set `name` so `bootFailure` could recognize the listing failure; the
 * library's own `GenerationUnavailable` is that name, stated once.
 *
 * It REJECTS rather than resolving a `Result`, like every other opener in this
 * file, because the route it serves renders one component either way.
 */
export async function resolveAccountGeneration(
	auth: AuthClient,
	principalId: PrincipalId,
): Promise<number> {
	const resolved = await resolveGeneration(honeycrispDefinition, {
		appId: APP_ID,
		account: honeycrispAccount(auth, principalId),
	});
	if (resolved.error !== null) throw resolved.error;
	return resolved.data.generation;
}

/** The account half of every call in this file, spelled once. */
function honeycrispAccount(
	auth: AuthClient,
	principalId: PrincipalId,
): DatabaseAccount {
	return {
		baseURL: auth.connection.baseURL,
		principalId,
		fetch: (input, init) => auth.fetch(input, init),
	};
}

/**
 * Erase this device's copy of the notes, whoever they belong to (ADR-0325).
 *
 * The one deleting verb this app has outside a note's own dialog, and it exists
 * because opening refuses rather than repairs: a copy created for another
 * account stays exactly where it is until a person says otherwise. Nothing
 * calls this on a schedule, on sign-out, or as a step in a protocol
 * (ADR-0281).
 *
 * It takes every generation, because the refusal is about the address rather
 * than about one number: erasing only the one that was refused would refuse the
 * next number down and ask again.
 */
export async function eraseNotesOnThisDevice(): Promise<void> {
	const { error } = await eraseGenerations({
		appId: APP_ID,
		dataId: honeycrispDefinition.id,
	});
	if (error !== null) throw error;
}

async function disposeQuietly(resource: AsyncDisposable): Promise<void> {
	await tryAsync({
		try: async () => await resource[Symbol.asyncDispose](),
		catch: (cause) => {
			reportBackgroundError(cause);
			return Ok(undefined);
		},
	});
}
