/**
 * Test-only: a replica that lives inside `workerd`, driven by the real driver.
 *
 * It is a Durable Object for one reason. A replica is a `Store`, a `Store` is
 * SQLite, and the only synchronous SQLite inside `workerd` is a Durable Object's
 * own storage. Everything else here is the deployed client: `createStore`,
 * `createSyncConnection` with the real supersession rule, and `compactStore`
 * over a real WebSocket and the real routes, so a test can assert on the rows
 * a device actually holds rather than on frames a harness counted.
 *
 * Adoption is modelled the way a page does it (ADR-0231): on a probe-confirmed
 * supersession the replica discards its local rows whole and boots fresh,
 * which is this class's stand-in for the reload a real host performs.
 *
 * Not exported from `index.ts` and not in any `wrangler.jsonc`. Only the test
 * entry mounts it, so nothing deployable grows a class that exists for a test.
 */
import { DurableObject } from 'cloudflare:workers';
import { createStore, defineLens, type Store } from '@epicenter/data';
import {
	compactStore,
	createSyncConnection,
	readBoundary,
	type StoreTransport,
	type SyncConnection,
} from '@epicenter/data/sync';
import {
	createDurableObjectSqliteAdapter,
	type DurableObjectSqliteStorage,
} from '@epicenter/sqlite/durable-object';
import { MAIN_SUBPROTOCOL, STORE_SYNC_ROUTE } from '@epicenter/sync';

const lens = defineLens({
	namespace: 'so.epicenter.storeprobe',
	tables: { notes: { title: 'string' } },
});

function bindNotes(store: Store) {
	const bound = store.bind(lens);
	if (bound.error !== null) throw bound.error;
	return bound.data;
}

export type ReplicaReport = {
	cursor: number;
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
	private db: ReturnType<typeof bindNotes> | undefined;
	private connection: SyncConnection | undefined;
	private store: Store | undefined;
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
		this.store = createStore({ database });
		this.db = bindNotes(this.store);
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
			// Fast enough that a refused dial reaches the probe within a test's
			// patience; the deployed default is seconds, not a correctness knob.
			backoff: () => 100,
			probeBoundary: async () => {
				const read = await readBoundary(this.transport());
				return read.data ?? undefined;
			},
			onSuperseded: () => {
				void this.adoptFresh();
			},
			dial: ({ cursor, opened, received, closed }) => {
				const url = STORE_SYNC_ROUTE.url(origin, {
					namespace: lens.namespace,
					cursor,
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

	/** The authenticated door, for the probe and the compact POST alike. */
	private transport(): StoreTransport {
		const bearer = this.bearer;
		return {
			baseURL: this.origin,
			namespace: lens.namespace,
			fetch: (input, init) =>
				this.env.SELF.fetch(
					new Request(input, {
						...init,
						headers: { authorization: `Bearer ${bearer}` },
					}),
				),
		};
	}

	/**
	 * The reload, replica-shaped: discard the local file whole, boot fresh.
	 *
	 * What a real host does with `discard()` and a page reload. The wipe is
	 * whole (every store relation), never a surgical edit across editions.
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
		for (const relation of ['_updates', '_outbox', '_cursor']) {
			database.run(`DELETE FROM ${relation}`);
		}
		this.open(this.bearer, this.origin);
	}

	/**
	 * The one product action, end to end: rebirth, publish, adopt.
	 *
	 * Returns the published boundary, or throws the typed refusal's name so a
	 * test can assert on it. On success this replica adopts through the same
	 * discard-and-boot every superseded replica runs.
	 */
	async compact(): Promise<{ boundary: number }> {
		if (this.store === undefined) throw new Error('open first');
		const published = await compactStore({
			store: this.store,
			transport: this.transport(),
		});
		if (published.error !== null) {
			throw new Error(`${published.error.name}: ${published.error.message}`);
		}
		await this.adoptFresh();
		return published.data;
	}

	/** Create a note with prose, the way an application does. */
	write(title: string, prose: string): void {
		if (this.db === undefined) throw new Error('open first');
		const made = this.db.tables.notes.create({ title }, { document: ['body'] });
		if (made.error !== null) throw made.error;
		const body = this.db.tables.notes
			.document(made.data.id)
			?.get('body', 'text');
		if (body === undefined) throw new Error('the row has no document');
		body.applyDelta(body.change.insert(prose) as never);
	}

	/** Delete the note holding this title, the way an application does. */
	remove(title: string): void {
		if (this.db === undefined) throw new Error('open first');
		const listed = this.db.tables.notes.list();
		if (listed.error !== null) throw listed.error;
		const row = listed.data.rows.find((candidate) => candidate.title === title);
		if (row === undefined) throw new Error(`no note titled '${title}'`);
		const removed = this.db.tables.notes.delete(row.id);
		if (removed.error !== null) throw removed.error;
	}

	/** This replica's whole state, re-encoded: the argument a replace posts. */
	encodeState(): Uint8Array {
		if (this.store === undefined) throw new Error('open first');
		return this.store.encodeStateSince();
	}

	/**
	 * What this replica actually holds, read back out of its own SQLite.
	 *
	 * Tolerant of the instant between discard and fresh boot, because a test
	 * polls this while an adoption is in flight: the answer is simply "nothing
	 * yet", and the next poll sees the fresh store.
	 */
	report(): ReplicaReport {
		if (this.db === undefined || this.store === undefined) {
			return {
				cursor: 0,
				connected: false,
				titles: [],
				prose: [],
				lastError: undefined,
				items: 0,
				adoptions: this.adoptions,
			};
		}
		const listed = this.db.tables.notes.list();
		if (listed.error !== null) throw listed.error;
		const status = this.connection?.status();
		const pressure = this.store.pressure();
		return {
			cursor: status?.cursor ?? 0,
			connected: status?.connected ?? false,
			titles: listed.data.rows.map((row) => row.title).sort(),
			prose: listed.data.rows
				.map((row) =>
					JSON.stringify(
						this.db?.tables.notes
							.document(row.id)
							?.get('body', 'text')
							?.toJSON() ?? null,
					),
				)
				.sort(),
			lastError: status?.lastError?.name,
			items: pressure.error !== null ? -1 : pressure.data.items,
			adoptions: this.adoptions,
		};
	}

	/** The subprotocol a browser would have to see echoed back. */
	static readonly mainSubprotocol = MAIN_SUBPROTOCOL;
}
