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
 * There is no adoption step and nothing to supersede. A replica is addressed at
 * one generation, a generation is created complete and never mutated in place,
 * so the address is the identity (ADR-0292): the class opens, dials, and
 * catches up, exactly as a page does.
 *
 * Not exported from `index.ts` and not in any `wrangler.jsonc`. Only the test
 * entry mounts it, so nothing deployable grows a class that exists for a test.
 */
import { DurableObject } from 'cloudflare:workers';
import { type AccountStore, defineData, defineTable } from '@epicenter/data';
import { field } from '@epicenter/data/definition';
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
import { Ok } from 'wellcrafted/result';

/**
 * The one generation this probe ever opens.
 *
 * A generation is an address (ADR-0292), so a probe needs one the way it needs
 * a dataId. It never changes here: moving to a newer generation is opening a
 * different object, and what these tests exercise is the transport into one.
 */
const PROBE_GENERATION = 1;

const probeDefinition = defineData({
	id: 'so.epicenter.storeprobe',
	kv: {},
	tables: {
		notes: defineTable({
			fields: { title: field.string(), body: field.type() },
			file: {
				serialize: (row) => ({
					data: { title: row.title },
					content: row.body.toString(),
				}),
				deserialize: (file, types) => {
					if (file.content !== '') types.body.insert(0, [file.content]);
					return Ok({ title: String(file.data.title ?? '') });
				},
			},
		}),
	},
});

function openNotes(
	sqlite: ReturnType<typeof createDurableObjectSqliteAdapter>,
) {
	return createAccountStore({ definition: probeDefinition, sqlite });
}

export type ReplicaReport = {
	cursor: number;

	connected: boolean;
	titles: string[];
	prose: string[];
	lastError: string | undefined;
	/** Structs the engine holds; how a test sees tombstones reclaimed. */
	items: number;
};

type Env = { SELF: { fetch(request: Request): Promise<Response> } };

export class StoreTestReplica extends DurableObject<Env> {
	private db: ReturnType<typeof openNotes> | undefined;
	private connection: SyncConnection | undefined;
	private store: AccountStore | undefined;
	private bearer = '';
	private origin = '';

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
			// Fast enough for a test's patience; the deployed default is seconds,
			// not correctness.
			backoff: () => 100,
			dial: ({ cursor, opened, received, closed }) => {
				const url = STORE_SYNC_ROUTE.url(origin, {
					dataId: probeDefinition.id,
					generation: PROBE_GENERATION,
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

	/** Create a note with prose, the way an application does. */
	write(title: string, prose: string): void {
		if (this.db === undefined) throw new Error('open first');
		const made = this.db.tables.notes.create({ title });
		const body = this.db.tables.notes.content(made.id)?.types.body;
		if (body === undefined) throw new Error('the row has no body');
		body.applyDelta(body.change.insert(prose) as never);
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
	 * Tolerant of being asked before the store is open, because a test polls
	 * this while a boot is in flight: the answer is simply "nothing yet", and
	 * the next poll sees the opened store.
	 */
	async report(): Promise<ReplicaReport> {
		const db = this.db;
		const store = this.store;
		if (db === undefined || store === undefined) {
			return {
				cursor: 0,
				connected: false,
				titles: [],
				prose: [],
				lastError: undefined,
				items: 0,
			};
		}
		const listed = db.tables.notes.list();
		const status = this.connection?.status();
		const pressure = store.pressure();
		return {
			cursor: status?.cursor ?? 0,
			connected: status?.connected ?? false,
			titles: listed.rows.map((row) => row.title).sort(),
			prose: listed.rows
				.map((row) =>
					JSON.stringify(
						db.tables.notes.content(row.id)?.types.body.toJSON() ?? null,
					),
				)
				.sort(),
			lastError: status?.lastError?.name,
			items: pressure.items,
		};
	}

	/** The subprotocol a browser would have to see echoed back. */
	static readonly mainSubprotocol = MAIN_SUBPROTOCOL;
}
