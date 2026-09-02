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
import { attachMirror } from '@epicenter/data/artifact/mirror';
import {
	createGeneration,
	GENERATIONS_ROUTE,
	newestGeneration,
	openDatabase,
	type ReplicaDocument,
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
import { mirrorLog, reportBackgroundError } from './report.js';
import { attachHoneycrispSync } from './sync.js';

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
};

type Opened<TDatabase> = TDatabase & AsyncDisposable;

/**
 * Open one account's retained replica of one generation.
 *
 * The same shape as the local opener now, and that is the change ADR-0292
 * bought. Opening and becoming safe to edit used to be two moments: a fresh
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
	if (principalId === undefined) {
		const error = new Error('Account access requires a signed-in principal');
		error.name = 'Unaddressable';
		throw error;
	}

	const { data, error } = await openDatabase(honeycrispDefinition, {
		generation,
		account: {
			baseURL: auth.connection.baseURL,
			principalId,
			fetch: (input, init) => auth.fetch(input, init),
		},
	});
	if (error !== null) throw error;

	const connectionResult = trySync({
		try: () => attachHoneycrispSync({ store: data, generation, auth }),
		catch: (cause) => Err(cause),
	});
	if (!isOk(connectionResult)) {
		await disposeQuietly(data);
		throw connectionResult.error;
	}
	const connection = connectionResult.data;

	// The folder follows the account replica as well as the device database
	// (ADR-0271). Attached after sync, so a replica that catches up renders what
	// arrived rather than the state it opened with.
	const mirror = attachMirror({
		data,
		definition: honeycrispDefinition,
		folder: 'account',
		log: mirrorLog,
	});

	// Same window as the local database, and it matters here too: durable work
	// is what a reconnect offers the authority, so a flush that never happened
	// is work the account never hears about either.
	const stopHideFlush = persistOnHide(() => data.persistence.flush());

	return {
		data,
		syncStatus: () => {
			const status = connection.status();
			return status.denied ? undefined : status;
		},
		async [Symbol.asyncDispose]() {
			stopHideFlush();
			connection[Symbol.dispose]();
			await mirror[Symbol.asyncDispose]();
			await data[Symbol.asyncDispose]();
		},
	};
}

/**
 * The account generation this device should open.
 *
 * Cache first, then the account's own list: a device that already holds a copy
 * uses it without waiting for a server, and one that holds none asks which
 * exist. Unlike the local resolver this never CREATES one, because an account
 * generation is the account's and a device arriving second must not invent a
 * history for it.
 */
export async function resolveAccountGeneration(
	auth: AuthClient,
	principalId: PrincipalId,
): Promise<number> {
	const newest = await newestGeneration(honeycrispDefinition.id, {
		baseURL: auth.connection.baseURL,
		principalId,
	});
	if (newest !== undefined) return newest;

	const listed = await auth.fetch(
		GENERATIONS_ROUTE.collection(
			auth.connection.baseURL,
			honeycrispDefinition.id,
		),
	);
	if (!listed.ok) {
		const error = new Error(
			`The account could not be asked which generations exist (${listed.status})`,
		);
		error.name = 'GenerationUnavailable';
		throw error;
	}
	const { generations } = (await listed.json()) as { generations: number[] };
	const latest = generations.at(-1);
	if (latest !== undefined) return latest;
	// An EMPTY list is a first run, not a refusal, and the distinction is the
	// listing itself: a failed one already threw above. What a device must not
	// do is invent a generation because it could not SEE what the account has.
	const created = await createGeneration(honeycrispDefinition, {
		account: {
			baseURL: auth.connection.baseURL,
			principalId,
			fetch: (input: Request | string | URL, init?: RequestInit) =>
				auth.fetch(input, init),
		},
	});
	if (created.error !== null) throw created.error;
	return created.data.generation;
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
