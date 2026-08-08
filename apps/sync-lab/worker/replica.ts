/**
 * THROWAWAY, and test-only: a replica that lives inside `workerd`.
 *
 * It is a Durable Object for one reason. A replica is a `Store`, a `Store` is
 * SQLite, and the only synchronous SQLite inside `workerd` is a Durable Object's
 * own storage. Everything else here is the deployed client: `createStore`,
 * `createSyncClient` and a real WebSocket to the authority, so a test can assert
 * on the rows a device actually holds rather than on frames a harness counted.
 *
 * It is deliberately NOT exported from `worker/index.ts` and NOT in
 * `wrangler.jsonc`. Only `worker/test-entry.ts` mounts it, so nothing that
 * deploys grows a class that exists for a test.
 */
import { DurableObject } from 'cloudflare:workers';
import { createStore, type Store } from '@epicenter/data';
import {
	createSyncClient,
	decodeFrame,
	type SyncClient,
} from '@epicenter/data/sync';
import { defineLens } from '@epicenter/lens';
import {
	createDurableObjectSqliteAdapter,
	type DurableObjectSqliteStorage,
} from '@epicenter/sqlite/durable-object';

const lens = defineLens({
	namespace: 'so.epicenter.synclab',
	tables: { notes: { title: 'string' } },
});

/**
 * Bind the lab lens, or fail loudly.
 *
 * A named function rather than an inline call, because `bind` is generic over
 * the lens and this is what carries `notes` and its `title` column into the
 * field type. Reaching for `ReturnType<Store['bind']>` instead loses the
 * instantiation and every row silently becomes `any`.
 */
function bindNotes(store: Store) {
	const bound = store.bind(lens);
	if (bound.error !== null) throw bound.error;
	return bound.data;
}

/**
 * What a test is allowed to see, and all of it crosses RPC as plain data.
 *
 * `titles` is the assertion that matters: it is read out of the replica's own
 * SQLite through the lens, so it can only be satisfied by bytes that arrived,
 * committed and applied. The two `redelivered` arrays are the opposite kind of
 * fact. They are an observation of the WIRE, kept because "a woken authority
 * re-sends rather than skips" is otherwise invisible from a converged replica:
 * a run that re-sent nothing and a run that re-sent and was correctly ignored
 * hold identical rows.
 */
export type ReplicaReport = {
	cursor: number;
	inFlight: boolean;
	needsResync: boolean;
	unresolvedDependencies: boolean;
	/** The error's tag, or undefined. Never a `SyncClientError` value: it carries a `cause`. */
	lastError: string | undefined;
	lastErrorMessage: string | undefined;
	titles: string[];
	/** Entry positions the authority sent again after this replica already held them. */
	redeliveredEntries: number[];
	/** Snapshot positions the authority sent again after this replica already held them. */
	redeliveredSnapshots: number[];
};

type Env = { SYNC: DurableObjectNamespace };

export class SyncLabReplica extends DurableObject<Env> {
	private readonly db: ReturnType<typeof bindNotes>;
	private readonly client: SyncClient;
	private readonly redeliveredEntries = new Set<number>();
	private readonly redeliveredSnapshots = new Set<number>();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		const store = createStore({
			database: createDurableObjectSqliteAdapter(
				ctx.storage as unknown as DurableObjectSqliteStorage,
			),
		});
		this.db = bindNotes(store);
		// Every send in this file is explicit, so the idle timer never fires and a
		// test never waits on a clock it does not control.
		this.client = createSyncClient({ store, idleMs: 60_000 });
	}

	/**
	 * Open a real socket to the authority, from this replica's own cursor.
	 *
	 * Named `openSocket` rather than `connect` because a `DurableObjectStub` is a
	 * `Fetcher`, and `Fetcher.connect` is the built-in TCP socket API. A method
	 * called `connect` is never reached over RPC: the built-in wins, and it fails
	 * with the deeply unhelpful "Specified address is missing port".
	 */
	async openSocket(partition: string): Promise<void> {
		const stub = this.env.SYNC.get(this.env.SYNC.idFromName(partition));
		const response = await stub.fetch(
			`https://sync-lab.invalid/sync?cursor=${this.client.cursor()}`,
			{ headers: { Upgrade: 'websocket' } },
		);
		const socket = response.webSocket;
		if (socket === null)
			throw new Error(`the authority answered ${response.status}`);
		socket.accept();
		// Attached in the same synchronous turn as `accept()`, because catch-up
		// frames were already queued by the authority's `fetch` before it returned.
		socket.addEventListener('message', (event) => {
			if (typeof event.data === 'string') return;
			this.observe(new Uint8Array(event.data));
			this.client.receive(new Uint8Array(event.data));
		});
		socket.addEventListener('close', () => this.client.detach());
		this.client.attach({ send: (bytes) => socket.send(bytes) });
	}

	/**
	 * Note what the authority sent that this replica already had.
	 *
	 * Read BEFORE the frame reaches the client, because the client is what moves
	 * the cursor past it. `seq <= cursor` is the exact condition the client
	 * ignores, so this counts precisely the re-delivery the wake path produces.
	 */
	private observe(bytes: Uint8Array): void {
		const { data: frame, error } = decodeFrame(bytes);
		if (error !== null) return;
		const cursor = this.client.cursor();
		if (frame.kind === 'entry' && frame.seq <= cursor) {
			this.redeliveredEntries.add(frame.seq);
		}
		if (frame.kind === 'snapshot' && frame.position <= cursor) {
			this.redeliveredSnapshots.add(frame.position);
		}
	}

	/** Write one row and send it now. */
	write(title: string): void {
		const written = this.db.notes.create({ title });
		if (written.error !== null) throw written.error;
		this.client.flush();
	}

	/**
	 * Write one row carrying `bytes` of prose, in one transaction.
	 *
	 * The only affordable way to reach the authority's 64 KB snapshot floor from
	 * a test: hundreds of small rows would take hundreds of round trips.
	 */
	writeLarge(title: string, bytes: number): void {
		const written = this.db.notes.create({ title });
		if (written.error !== null) throw written.error;
		const text = this.db.notes.document(written.data.id)?.get('editor', 'text');
		if (text === undefined) throw new Error('the row has no document');
		text.applyDelta(text.change.insert('x'.repeat(bytes)) as never);
		this.client.flush();
	}

	report(): ReplicaReport {
		const status = this.client.status();
		const listed = this.db.notes.list();
		if (listed.error !== null) throw listed.error;
		return {
			cursor: status.cursor,
			inFlight: status.inFlight,
			needsResync: status.needsResync,
			unresolvedDependencies: status.unresolvedDependencies,
			lastError: status.lastError?.name,
			lastErrorMessage: status.lastError?.message,
			titles: listed.data.rows.map((row) => row.title).sort(),
			redeliveredEntries: [...this.redeliveredEntries].sort((a, b) => a - b),
			redeliveredSnapshots: [...this.redeliveredSnapshots].sort(
				(a, b) => a - b,
			),
		};
	}
}
