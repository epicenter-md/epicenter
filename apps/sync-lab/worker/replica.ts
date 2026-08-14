/**
 * THROWAWAY, and test-only: a replica that lives inside `workerd`.
 *
 * It is a Durable Object for one reason. A replica is an `AccountStore`, a store
 * is SQLite, and the only synchronous SQLite inside `workerd` is a Durable
 * Object's own storage; its one database therefore holds the client's durable
 * record AND its projection, which the engine keeps honest by owning the
 * letter-named relations outright. Everything else here is the deployed
 * client: `createAccountStore`,
 * `createSyncClient` and a real WebSocket to the authority, so a test can assert
 * on the rows a device actually holds rather than on frames a harness counted.
 *
 * It is deliberately NOT exported from `worker/index.ts` and NOT in
 * `wrangler.jsonc`. Only `worker/test-entry.ts` mounts it, so nothing that
 * deploys grows a class that exists for a test.
 */
import { DurableObject } from 'cloudflare:workers';
import { createAccountStore } from '@epicenter/data';
import {
	createSyncClient,
	decodeFrame,
	type SyncClient,
} from '@epicenter/data/sync';
import {
	createDurableObjectSqliteAdapter,
	type DurableObjectSqliteStorage,
} from '@epicenter/sqlite/durable-object';
import { defineWorkspace } from '@epicenter/workspace';

const workspace = defineWorkspace({
	namespace: 'so.epicenter.synclab',
	tables: { notes: { title: 'string' } },
});

/**
 * Open the lab workspace over this Durable Object's own SQLite.
 *
 * A named function rather than an inline call so `ReturnType<typeof openNotes>`
 * carries `notes` and its `title` column into the field type.
 */
function openNotes(
	database: ReturnType<typeof createDurableObjectSqliteAdapter>,
) {
	return createAccountStore({ workspace: workspace, database });
}

/**
 * What a test is allowed to see, and all of it crosses RPC as plain data.
 *
 * `titles` is the assertion that matters: it is read out of the replica's own
 * SQLite through the workspace, so it can only be satisfied by bytes that arrived,
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
	private readonly db: ReturnType<typeof openNotes>;
	private readonly client: SyncClient;
	private readonly redeliveredEntries = new Set<number>();
	private readonly redeliveredSnapshots = new Set<number>();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.db = openNotes(
			createDurableObjectSqliteAdapter(
				ctx.storage as unknown as DurableObjectSqliteStorage,
			),
		);
		// Every send in this file is explicit, so the idle timer never fires and a
		// test never waits on a clock it does not control.
		this.client = createSyncClient({ store: this.db.store, idleMs: 60_000 });
	}

	/**
	 * Open a real socket to the authority, from this replica's own cursor.
	 *
	 * First contact runs the identity handshake the deployed driver runs
	 * (ADR-0231): an identity-less dial only bootstraps. The authority names
	 * its document as the first frame and closes without admitting the
	 * connection; the client stamps the name durably, and the membership dial
	 * below goes through the equality door and is served like any other
	 * catch-up.
	 *
	 * Named `openSocket` rather than `connect` because a `DurableObjectStub` is a
	 * `Fetcher`, and `Fetcher.connect` is the built-in TCP socket API. A method
	 * called `connect` is never reached over RPC: the built-in wins, and it fails
	 * with the deeply unhelpful "Specified address is missing port".
	 */
	async openSocket(partition: string): Promise<void> {
		if (this.client.document() === undefined) {
			await this.dialBootstrap(partition);
			if (this.client.document() === undefined) {
				throw new Error('the bootstrap dial named no document');
			}
		}
		const socket = await this.dial(partition);
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

	/** One upgrade at this replica's cursor, declaring its identity if it has one. */
	private async dial(partition: string): Promise<WebSocket> {
		const stub = this.env.SYNC.get(this.env.SYNC.idFromName(partition));
		const document = this.client.document();
		const declared =
			document === undefined ? '' : `&document=${encodeURIComponent(document)}`;
		const response = await stub.fetch(
			`https://sync-lab.invalid/sync?cursor=${this.client.cursor()}${declared}`,
			{ headers: { Upgrade: 'websocket' } },
		);
		const socket = response.webSocket;
		if (socket === null)
			throw new Error(`the authority answered ${response.status}`);
		return socket;
	}

	/**
	 * The first-contact dial: hear the document announcement, wait out the
	 * close the authority answers a pristine replica with, and return. The
	 * client stamps the identity from the frame; nothing else arrives on this
	 * socket, by design.
	 */
	private async dialBootstrap(partition: string): Promise<void> {
		const socket = await this.dial(partition);
		socket.accept();
		await new Promise<void>((resolve) => {
			socket.addEventListener('message', (event) => {
				if (typeof event.data === 'string') return;
				this.client.receive(new Uint8Array(event.data));
				// Close this half too, once the stamp landed. The authority already
				// closed its own; without this echo the server half lingers in the
				// hibernation set and `stat().sockets` counts a corpse.
				if (this.client.document() !== undefined) socket.close(1000, 'stamped');
			});
			socket.addEventListener('close', () => resolve());
			socket.addEventListener('error', () => resolve());
		});
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
		const written = this.db.tables.notes.create({ title });
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
		const written = this.db.tables.notes.create({ title });
		if (written.error !== null) throw written.error;
		const text = this.db.tables.notes
			.document(written.data.id)
			?.get('editor', 'text');
		if (text === undefined) throw new Error('the row has no document');
		text.applyDelta(text.change.insert('x'.repeat(bytes)) as never);
		this.client.flush();
	}

	report(): ReplicaReport {
		const status = this.client.status();
		const listed = this.db.tables.notes.list();
		return {
			cursor: status.cursor,
			inFlight: status.inFlight,
			needsResync: status.needsResync,
			unresolvedDependencies: status.unresolvedDependencies,
			lastError: status.lastError?.name,
			lastErrorMessage: status.lastError?.message,
			titles: listed.rows.map((row) => row.title).sort(),
			redeliveredEntries: [...this.redeliveredEntries].sort((a, b) => a - b),
			redeliveredSnapshots: [...this.redeliveredSnapshots].sort(
				(a, b) => a - b,
			),
		};
	}
}
