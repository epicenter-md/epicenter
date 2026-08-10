/**
 * Test-only: a replica that lives inside `workerd`, driven by the real driver.
 *
 * It is a Durable Object for one reason. A replica is a `Store`, a `Store` is
 * SQLite, and the only synchronous SQLite inside `workerd` is a Durable Object's
 * own storage. Everything else here is the deployed client: `createStore` and
 * `createSyncConnection` over a real WebSocket to the real route, so a test can
 * assert on the rows a device actually holds rather than on frames a harness
 * counted.
 *
 * Not exported from `index.ts` and not in any `wrangler.jsonc`. Only the test
 * entry mounts it, so nothing deployable grows a class that exists for a test.
 */
import { DurableObject } from 'cloudflare:workers';
import { createStore, defineLens, type Store } from '@epicenter/data';
import {
	createSyncConnection,
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
};

type Env = { SELF: { fetch(request: Request): Promise<Response> } };

export class StoreTestReplica extends DurableObject<Env> {
	private db: ReturnType<typeof bindNotes> | undefined;
	private connection: SyncConnection | undefined;
	private store: Store | undefined;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
	}

	/** Open this replica and dial the authority as `bearer`. */
	open(bearer: string, origin: string): void {
		if (this.store !== undefined) return;
		const database = createDurableObjectSqliteAdapter(
			this.ctx.storage as unknown as DurableObjectSqliteStorage,
		);
		this.store = createStore({ database });
		this.db = bindNotes(this.store);
		this.connection = createSyncConnection({
			store: this.store,
			idleMs: 20,
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

	/** This replica's whole state, re-encoded: the argument a replace posts. */
	encodeState(): Uint8Array {
		if (this.store === undefined) throw new Error('open first');
		return this.store.encodeStateSince();
	}

	/** What this replica actually holds, read back out of its own SQLite. */
	report(): ReplicaReport {
		if (this.db === undefined || this.connection === undefined) {
			throw new Error('open first');
		}
		const listed = this.db.tables.notes.list();
		if (listed.error !== null) throw listed.error;
		const status = this.connection.status();
		return {
			cursor: status.cursor,
			connected: status.connected,
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
			lastError: status.lastError?.name,
		};
	}

	/** The subprotocol a browser would have to see echoed back. */
	static readonly mainSubprotocol = MAIN_SUBPROTOCOL;
}
