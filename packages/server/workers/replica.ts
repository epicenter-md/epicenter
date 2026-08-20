import { field } from '@epicenter/data/definition';
/**
 * Test-only: a replica that lives inside `workerd`, driven by the real driver.
 *
 * It is a Durable Object for one reason. A replica is an `AccountStore`, a
 * store's durable record is SQLite here, and the only synchronous SQLite
 * inside `workerd` is a Durable Object's own storage. Everything else here is
 * the deployed
 * client: `createAccountStore`,
 * `createSyncConnection` with the real supersession rule over a real WebSocket
 * and the real routes, so a test can assert on the rows a device actually
 * holds rather than on frames a harness counted.
 *
 * Adoption is modelled the way a page does it (ADR-0231): on a probe-confirmed
 * supersession the replica discards its local rows whole and boots fresh,
 * which is this class's stand-in for the reload a real host performs.
 *
 * Not exported from `index.ts` and not in any `wrangler.jsonc`. Only the test
 * entry mounts it, so nothing deployable grows a class that exists for a test.
 */
import { DurableObject } from 'cloudflare:workers';
import { type AccountStore, defineData } from '@epicenter/data';
import { createAccountStore } from '@epicenter/data/engine';
import {
	createSyncConnection,
	type SyncConnection,
} from '@epicenter/data/sync';
import {
	createDurableObjectSqliteAdapter,
	type DurableObjectSqliteStorage,
} from '@epicenter/sqlite/durable-object';
import { MAIN_SUBPROTOCOL, STORE_SYNC_ROUTE } from '@epicenter/sync';

const probeDefinition = defineData({
	id: 'so.epicenter.storeprobe',
	kv: {},
	tables: { notes: { title: field.string() } },
});

function openNotes(
	sqlite: ReturnType<typeof createDurableObjectSqliteAdapter>,
) {
	return createAccountStore({ definition: probeDefinition, sqlite });
}

export type ReplicaReport = {
	cursor: number;
	/** The document this replica's state is stamped into, if any (ADR-0231). */
	document: string | undefined;
	connected: boolean;
	titles: string[];
	prose: string[];
	lastError: string | undefined;
	/** Structs the engine holds; how a test sees tombstones reclaimed. */
	items: number;
	/** How many times this replica discarded and booted fresh (ADR-0231). */
	adoptions: number;
};

type Env = { SELF: { fetch(request: Request): Promise<Response> } };

export class StoreTestReplica extends DurableObject<Env> {
	private db: ReturnType<typeof openNotes> | undefined;
	private connection: SyncConnection | undefined;
	private store: AccountStore | undefined;
	private bearer = '';
	private origin = '';
	private adoptions = 0;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
	}

	/**
	 * Open this replica as `bearer`, and dial unless told to stay offline.
	 *
	 * `connect: false` is how a test models a device that works offline first:
	 * it writes locally and only `startSync()`s later, which is exactly the
	 * device the stated-loss contract is about.
	 */
	open(
		bearer: string,
		origin: string,
		{ connect = true }: { connect?: boolean } = {},
	): void {
		if (this.store !== undefined) return;
		this.bearer = bearer;
		this.origin = origin;
		const database = createDurableObjectSqliteAdapter(
			this.ctx.storage as unknown as DurableObjectSqliteStorage,
		);
		this.db = openNotes(database);
		this.store = this.db.store;
		if (connect) this.startSync();
	}

	/** Start dialling, with the deployed driver and the real supersession rule. */
	startSync(): void {
		if (this.store === undefined) throw new Error('open first');
		if (this.connection !== undefined) return;
		const bearer = this.bearer;
		const origin = this.origin;
		this.connection = createSyncConnection({
			store: this.store,
			idleMs: 20,
			// Fast enough that a stale dial meets the document announcement within a
			// test's patience; the deployed default is seconds, not correctness.
			backoff: () => 100,
			onSuperseded: () => {
				void this.adoptFresh();
			},
			dial: ({ cursor, document, opened, received, closed }) => {
				const url = STORE_SYNC_ROUTE.url(origin, {
					databaseId: probeDefinition.id,
					cursor,
					...(document === undefined ? {} : { document }),
				});
				// The same handshake a browser performs: the credential rides as a
				// subprotocol because an upgrade cannot set `Authorization`.
				const request = new Request(url.replace(/^ws/, 'http'), {
					headers: {
						Upgrade: 'websocket',
						'sec-websocket-protocol':
							STORE_SYNC_ROUTE.subprotocols(bearer).join(', '),
					},
				});
				let socket: WebSocket | undefined;
				let abandoned = false;
				void this.env.SELF.fetch(request).then((response) => {
					// `null`, not `undefined`, on a refused upgrade in workerd: the
					// property exists on every Response and holds nothing.
					const accepted = (
						response as unknown as { webSocket?: WebSocket | null }
					).webSocket;
					if (accepted === undefined || accepted === null || abandoned) {
						closed();
						return;
					}
					socket = accepted;
					accepted.accept();
					accepted.addEventListener('message', (event) => {
						if (typeof event.data === 'string') return;
						received(new Uint8Array(event.data as ArrayBuffer));
					});
					accepted.addEventListener('close', () => closed());
					accepted.addEventListener('error', () => closed());
					opened({ send: (bytes) => accepted.send(bytes) });
				});
				return () => {
					abandoned = true;
					socket?.close();
				};
			},
		});
		this.connection.start();
	}

	/** Stop dialling, the way a device going offline does. Work keeps queuing. */
	stopSync(): void {
		this.connection?.[Symbol.dispose]();
		this.connection = undefined;
	}

	/**
	 * The reload, replica-shaped: discard the local file whole, boot fresh.
	 *
	 * What a real host does with `discard()` and a page reload. The wipe is
	 * whole (every store relation), never a surgical edit across documents.
	 */
	private async adoptFresh(): Promise<void> {
		this.adoptions += 1;
		this.connection?.[Symbol.dispose]();
		this.connection = undefined;
		await this.store?.[Symbol.asyncDispose]();
		this.store = undefined;
		this.db = undefined;
		const database = createDurableObjectSqliteAdapter(
			this.ctx.storage as unknown as DurableObjectSqliteStorage,
		);
		// `_meta` included: the pledge is a commitment to the document being
		// discarded, and a wipe that leaves it behind boots a "fresh" replica
		// that is retired on sight, forever (a real host deletes the whole
		// file, where this cannot be forgotten).
		for (const relation of ['_updates', '_outbox', '_cursor', '_meta']) {
			database.run(`DELETE FROM ${relation}`);
		}
		this.open(this.bearer, this.origin);
	}

	/** Create a note with prose, the way an application does. */
	async write(title: string, prose: string): Promise<void> {
		if (this.db === undefined) throw new Error('open first');
		const made = this.db.tables.notes.create({ title });
		const opened = await this.db.tables.notes.document.open(made.id);
		if (opened.error !== null) throw opened.error;
		const handle = opened.data;
		if (handle === undefined) throw new Error('the row has no document');
		const body = handle.get('body', 'text');
		body.applyDelta(body.change.insert(prose) as never);
		handle[Symbol.dispose]();
	}

	/** Delete the note holding this title, the way an application does. */
	remove(title: string): void {
		if (this.db === undefined) throw new Error('open first');
		const listed = this.db.tables.notes.list();
		const row = listed.rows.find((candidate) => candidate.title === title);
		if (row === undefined) throw new Error(`no note titled '${title}'`);
		this.db.tables.notes.delete(row.id);
	}

	/**
	 * What this replica actually holds, read back out of its own SQLite.
	 *
	 * Tolerant of the instant between discard and fresh boot, because a test
	 * polls this while an adoption is in flight: the answer is simply "nothing
	 * yet", and the next poll sees the fresh store.
	 */
	async report(): Promise<ReplicaReport> {
		const db = this.db;
		const store = this.store;
		if (db === undefined || store === undefined) {
			return {
				cursor: 0,
				document: undefined,
				connected: false,
				titles: [],
				prose: [],
				lastError: undefined,
				items: 0,
				adoptions: this.adoptions,
			};
		}
		const listed = db.tables.notes.list();
		const status = this.connection?.status();
		const pressure = store.pressure();
		return {
			cursor: status?.cursor ?? 0,
			document: store.sync.get().document,
			connected: status?.connected ?? false,
			titles: listed.rows.map((row) => row.title).sort(),
			prose: (
				await Promise.all(
					listed.rows.map(async (row) => {
						const opened = await db.tables.notes.document.open(row.id);
						const text = JSON.stringify(
							opened?.data?.get('body', 'text')?.toJSON() ?? null,
						);
						opened?.data?.[Symbol.dispose]();
						return text;
					}),
				)
			).sort(),
			lastError: status?.lastError?.name,
			items: pressure.items,
			adoptions: this.adoptions,
		};
	}

	/** The subprotocol a browser would have to see echoed back. */
	static readonly mainSubprotocol = MAIN_SUBPROTOCOL;
}
