import { DurableObject } from 'cloudflare:workers';

import type { ExchangeResponse } from '@epicenter/data/protocol';
import type { DocumentAddress } from '@epicenter/document-sync';
import type { PrincipalId } from '@epicenter/identity';
import {
	createDurableObjectSqliteAdapter,
	type DurableObjectSqliteStorage,
} from '@epicenter/sqlite/durable-object';
import type { Hono, MiddlewareHandler } from 'hono';

import type { Env } from '../types.js';
import { openEpicenterSyncAuthority } from './authority.js';
import {
	createEpicenterDocumentStore,
	type DocumentAppendOutcome,
	type DocumentReadOutcome,
} from './document-store.js';
import { mountDocumentSyncRoute, mountEpicenterSyncRoute } from './route.js';

function principalName(principalId: PrincipalId): string {
	return encodeURIComponent(principalId).replaceAll('.', '%2E');
}

/**
 * One principal-owned Epicenter authority in Durable Object SQLite. Every
 * entry point is a typed RPC method; there is no fetch handler, internal
 * route, or WebSocket surface.
 */
export class EpicenterAuthority extends DurableObject {
	private readonly scalar;
	private readonly documents;

	constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
		super(ctx, env);
		const database = createDurableObjectSqliteAdapter(
			ctx.storage as unknown as DurableObjectSqliteStorage,
		);
		const readDatabaseSize = () =>
			(ctx.storage as unknown as { sql: { databaseSize: number } }).sql
				.databaseSize;
		this.scalar = openEpicenterSyncAuthority({ database, readDatabaseSize });
		this.documents = createEpicenterDocumentStore(database, {
			readDatabaseSize,
		});
	}

	exchange(request: unknown): ExchangeResponse {
		return this.scalar.exchange(request);
	}

	publishDocument(
		address: DocumentAddress,
		update: Uint8Array,
	): DocumentAppendOutcome {
		return this.documents.appendIfLive(address, new Uint8Array(update));
	}

	pullDocument(
		address: DocumentAddress,
		sinceVersion: number | undefined,
	): DocumentReadOutcome {
		return this.documents.read(address, sinceVersion);
	}

	/** Delete every scalar and document byte owned by this principal authority. */
	async deleteAccount(): Promise<void> {
		await this.ctx.storage.deleteAll();
	}
}

/**
 * The authority's RPC contract as seen through a stub. Declared structurally
 * because the generated `DurableObjectStub<EpicenterAuthority>` mapped type
 * recurses past the compiler's instantiation depth on the exchange union; the
 * class methods above are the one source of these signatures.
 */
type EpicenterAuthorityCalls = {
	exchange(request: unknown): ExchangeResponse | Promise<ExchangeResponse>;
	publishDocument(
		address: DocumentAddress,
		update: Uint8Array,
	): DocumentAppendOutcome | Promise<DocumentAppendOutcome>;
	pullDocument(
		address: DocumentAddress,
		sinceVersion: number | undefined,
	): DocumentReadOutcome | Promise<DocumentReadOutcome>;
};

// Drift guard: the class must keep satisfying the declared stub contract, or
// the structural cast below would silently hide the mismatch.
type AssertImplementsCalls<_T extends EpicenterAuthorityCalls> = never;
type _EpicenterAuthorityContractCheck =
	AssertImplementsCalls<EpicenterAuthority>;

type EpicenterAuthorityNamespace = {
	getByName(name: string): unknown;
};

type DeletableAuthorityNamespace = {
	getByName(name: string): { deleteAccount(): Promise<void> };
};

function stubFor(
	namespace: EpicenterAuthorityNamespace,
	principalId: PrincipalId,
): EpicenterAuthorityCalls {
	return namespace.getByName(
		principalName(principalId),
	) as EpicenterAuthorityCalls;
}

/** Adapt the principal-named authority namespace for hosted account deletion. */
export function createDurableObjectAccountAuthorities(
	namespace: DeletableAuthorityNamespace,
) {
	return {
		authority(principalId: PrincipalId) {
			return {
				deleteAccount: () =>
					namespace.getByName(principalName(principalId)).deleteAccount(),
			};
		},
	};
}

/** Mount the Cloudflare scalar exchange and row-document HTTP sync routes. */
export function mountCloudflareEpicenterSyncApp<E extends Env = Env>(
	app: Hono<E>,
	{
		auth,
		resolveNamespace,
	}: {
		auth: MiddlewareHandler<E>;
		resolveNamespace(env: E['Bindings']): EpicenterAuthorityNamespace;
	},
): void {
	mountEpicenterSyncRoute(app, {
		auth,
		locateAuthority: (principalId, env) => (request) =>
			stubFor(resolveNamespace(env), principalId).exchange(request),
	});
	mountDocumentSyncRoute(app, {
		auth,
		publish: (principalId, address, update, env) =>
			stubFor(resolveNamespace(env), principalId).publishDocument(
				address,
				update,
			),
		pull: (principalId, address, sinceVersion, env) =>
			stubFor(resolveNamespace(env), principalId).pullDocument(
				address,
				sinceVersion,
			),
	});
}
