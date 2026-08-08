/**
 * What the transport does inside `workerd`, measured rather than assumed.
 *
 * Run against a live worker:
 *
 *   bun --cwd apps/sync-lab wrangler dev        # a terminal of its own
 *   bun run packages/data/evidence/workerd/probe.ts http://127.0.0.1:8787
 *
 * and against a deployment by passing its origin instead. Nothing here runs in
 * `bun test`, because the thing being measured is the runtime.
 *
 * ## Method
 *
 * Every experiment carries a CONTROL THAT MUST FAIL if the test is not live,
 * and the control is reported beside the result. Three experiments on this
 * branch passed for hollow reasons before anyone noticed: a forged baseline
 * that was rejected for the wrong reason, a cursor rule that "worked" in a
 * simulation where nothing was ever delivered, and a memory table measured with
 * six shapes in one process so the allocator's high-water mark landed on the
 * first. Each was caught because a number looked odd, not because an assertion
 * failed.
 */
import { defineLens } from '@epicenter/lens/lens';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { Database } from 'bun:sqlite';

import { createStore, type Store } from '../../src/store/store.js';
import {
	createSyncClient,
	DO_SQLITE_VALUE_CAP,
	type SyncClient,
} from '../../src/sync/index.js';

const origin = process.argv[2] ?? 'http://127.0.0.1:8787';
const application = `probe-${Date.now()}`;

const lens = defineLens({
	namespace: 'so.epicenter.synclab',
	tables: { notes: { title: 'string', device: 'string', at: 'string' } },
});

type Stat = {
	head: number;
	storedBytes: number;
	sockets: number;
	incarnation: string;
};

async function stat(): Promise<Stat> {
	const response = await fetch(`${origin}/stat?app=${application}`);
	return (await response.json()) as Stat;
}

function openReplica(): { store: Store; db: ReturnType<Store['bind']> } {
	const store = createStore({
		database: createBunSqliteAdapter(new Database(':memory:')),
	});
	return { store, db: store.bind(lens) };
}

/** A live socket to the authority, feeding a real client. */
async function connect(client: SyncClient): Promise<WebSocket> {
	const url = new URL('/sync', origin);
	url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
	url.searchParams.set('app', application);
	url.searchParams.set('cursor', String(client.cursor()));
	const socket = new WebSocket(url.toString());
	socket.binaryType = 'arraybuffer';
	socket.addEventListener('message', (event) => {
		if (typeof event.data === 'string') return;
		client.receive(new Uint8Array(event.data as ArrayBuffer));
	});
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener('open', () => resolve());
		socket.addEventListener('error', () => reject(new Error('socket failed')));
	});
	client.attach({ send: (bytes) => socket.send(bytes) });
	return socket;
}

/** Wait until `check` holds, or give up loudly rather than hanging. */
async function until(
	label: string,
	check: () => boolean,
	timeoutMs = 60_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await Bun.sleep(10);
	}
}

function report(label: string, value: unknown): void {
	console.log(`  ${label.padEnd(46)} ${String(value)}`);
}

console.log(`\nworkerd probe against ${origin}, partition ${application}\n`);

// ---------------------------------------------------------------------------

console.log('1. where the value cap actually is, bisected to the byte');
{
	async function stores(size: number): Promise<{ stored: boolean; failure?: string }> {
		const response = await fetch(
			`${origin}/probe/value-cap?app=${application}&sizes=${size}`,
		);
		const [outcome] = (await response.json()) as {
			stored: boolean;
			failure?: string;
		}[];
		return outcome ?? { stored: false, failure: 'no answer' };
	}

	const floor = await stores(1_024);
	const ceiling = await stores(8 * 1024 * 1024);
	// The control that has to hold before any boundary below is worth reading. A
	// probe that stores everything, or nothing, is not reaching Durable Object
	// SQLite at all, and a bisection over it would still print a confident
	// number.
	report(
		'CONTROL 1 KB stores and 8 MB does not',
		floor.stored && !ceiling.stored ? 'held' : 'FAILED',
	);
	if (!floor.stored || ceiling.stored) throw new Error('the value-cap probe is not live');

	let low = 1_024;
	let high = 8 * 1024 * 1024;
	while (high - low > 1) {
		const middle = Math.floor((low + high) / 2);
		if ((await stores(middle)).stored) low = middle;
		else high = middle;
	}
	report('largest value that stores', low.toLocaleString());
	report('smallest value refused', `${high.toLocaleString()}  (${ceiling.failure ?? ''})`);
	report(
		`the documented cap (${DO_SQLITE_VALUE_CAP.toLocaleString()})`,
		low >= DO_SQLITE_VALUE_CAP
			? `fits, with ${(low - DO_SQLITE_VALUE_CAP).toLocaleString()} bytes of headroom`
			: 'DOES NOT FIT: lower CHUNK_BYTES',
	);
}

// ---------------------------------------------------------------------------

console.log('\n2. an update past the cap, through the real socket');
{
	await fetch(`${origin}/probe/reset?app=${application}`);
	const author = openReplica();
	const reader = openReplica();
	if (author.db.error !== null || reader.db.error !== null) throw new Error('bind failed');
	const authorClient = createSyncClient({ store: author.store, idleMs: 20 });
	const readerClient = createSyncClient({ store: reader.store, idleMs: 20 });
	const authorSocket = await connect(authorClient);
	const readerSocket = await connect(readerClient);

	const note = author.db.data.notes.create({
		title: 'a big paste',
		device: 'probe',
		at: new Date().toISOString(),
	});
	if (note.error !== null) throw note.error;
	const text = author.db.data.notes.document(note.data.id)?.get('editor', 'text');
	if (text === undefined) throw new Error('the row has no document');
	// One transaction, well past the cap. There is no seam here for a coalescing
	// bound to cut at, which is why the fix has to be framing at storage.
	text.applyDelta(text.change.insert('x'.repeat(5_000_000)) as never);
	authorClient.flush();

	await until('the reader to receive the paste', () => {
		const arrived = reader.db.data.notes.document(note.data.id)?.get('editor', 'text');
		return (arrived?.length ?? 0) === 5_000_000;
	});

	const after = await stat();
	report('reassembled length on the OTHER replica', 5_000_000);
	report('entries in the log', after.head);
	report('bytes stored', after.storedBytes.toLocaleString());
	report('chunks it must have taken', Math.ceil(after.storedBytes / DO_SQLITE_VALUE_CAP));
	// The control: if the payload had fit in one value, this proves nothing about
	// chunking at all.
	report(
		'CONTROL it really exceeded one value',
		after.storedBytes > DO_SQLITE_VALUE_CAP ? 'held' : 'FAILED',
	);
	report(
		'CONTROL no unresolved dependencies on the reader',
		readerClient.status().unresolvedDependencies ? 'FAILED' : 'held',
	);
	authorSocket.close();
	readerSocket.close();
}

// ---------------------------------------------------------------------------

console.log('\n3. sustained traffic through ONE instance');
{
	await fetch(`${origin}/probe/reset?app=${application}`);
	const messages = Number(process.env.PROBE_MESSAGES ?? '2000');
	const author = openReplica();
	const reader = openReplica();
	if (author.db.error !== null || reader.db.error !== null) throw new Error('bind failed');
	const authorClient = createSyncClient({ store: author.store, idleMs: 5 });
	const readerClient = createSyncClient({ store: reader.store, idleMs: 5 });
	const authorSocket = await connect(authorClient);
	const readerSocket = await connect(readerClient);

	const before = await stat();
	const startedAt = Date.now();
	for (let index = 0; index < messages; index += 1) {
		const written = author.db.data.notes.create({
			title: `note ${index}`,
			device: 'probe',
			at: new Date().toISOString(),
		});
		if (written.error !== null) throw written.error;
		// One send per row, deliberately: this experiment is about the authority
		// under load, so it is run with coalescing turned off in effect.
		authorClient.flush();
		await until(`send ${index} to be acknowledged`, () => !authorClient.status().inFlight);
	}
	const elapsed = Date.now() - startedAt;

	await until('the reader to catch up', () => readerClient.cursor() >= messages);
	const after = await stat();

	report('messages pushed', messages.toLocaleString());
	report('entries in the log', after.head);
	report('wall clock', `${elapsed} ms  (${(elapsed / messages).toFixed(2)} ms each)`);
	report('bytes stored', after.storedBytes.toLocaleString());
	report('bytes per entry', Math.round(after.storedBytes / Math.max(after.head, 1)));
	report(
		'rows on the OTHER replica',
		reader.db.data.notes.ids().data?.length ?? 'READ FAILED',
	);
	// The control that makes "one instance" mean anything. A run that crossed an
	// eviction measured two cold objects and should not be quoted as sustained.
	report(
		'CONTROL one incarnation start to end',
		before.incarnation === after.incarnation
			? `held  (${after.incarnation.slice(0, 8)})`
			: `FAILED  ${before.incarnation.slice(0, 8)} -> ${after.incarnation.slice(0, 8)}`,
	);
	report(
		'CONTROL every position contiguous, none skipped',
		authorClient.status().lastError === undefined &&
			readerClient.status().lastError === undefined
			? 'held'
			: `FAILED  ${authorClient.status().lastError?.message ?? readerClient.status().lastError?.message}`,
	);
	report(
		'CONTROL the reader holds every row, not just a cursor',
		(reader.db.data.notes.ids().data?.length ?? 0) === messages ? 'held' : 'FAILED',
	);
	authorSocket.close();
	readerSocket.close();
}

// ---------------------------------------------------------------------------

console.log('\n4. a refused update is answered, not swallowed');
{
	const url = new URL('/sync', origin);
	url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
	url.searchParams.set('app', application);
	url.searchParams.set('cursor', '999999');
	const socket = new WebSocket(url.toString());
	socket.binaryType = 'arraybuffer';
	let answer: Uint8Array | undefined;
	socket.addEventListener('message', (event) => {
		if (typeof event.data !== 'string') answer = new Uint8Array(event.data as ArrayBuffer);
	});
	await new Promise<void>((resolve) => socket.addEventListener('open', () => resolve()));

	// A push frame carrying six bytes of garbage.
	const frame = new Uint8Array(13 + 6);
	new DataView(frame.buffer).setUint8(0, 1);
	new DataView(frame.buffer).setUint32(1, 7);
	new DataView(frame.buffer).setUint32(5, 0);
	new DataView(frame.buffer).setUint32(9, 1);
	frame.set([1, 2, 3, 4, 5, 6], 13);
	const headBefore = (await stat()).head;
	socket.send(frame);

	await until('an answer to the poison push', () => answer !== undefined, 15_000).catch(
		() => undefined,
	);
	const headAfter = (await stat()).head;
	report('the authority answered', answer === undefined ? 'NOTHING (swallowed)' : 'a frame');
	report('the answer is a refusal', answer?.[0] === 3 ? 'yes' : `no (kind ${answer?.[0]})`);
	report('nothing was stored', headBefore === headAfter ? 'held' : 'FAILED');
	// The control: the socket has to still be open, because the failure this
	// mechanism exists for is a throw that `workerd` swallows WITHOUT closing.
	report(
		'CONTROL the socket is still open',
		socket.readyState === WebSocket.OPEN ? 'held' : `FAILED (state ${socket.readyState})`,
	);
	socket.close();
}

console.log('\ndone\n');
process.exit(0);
