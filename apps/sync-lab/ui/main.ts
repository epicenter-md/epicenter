/**
 * THROWAWAY. One page, two devices, one row crossing between them.
 *
 * The store is held in an in-memory SQLite, deliberately. This surface is not
 * claiming durability across a reload; it is claiming that a row written on one
 * device appears on another through a deployed Durable Object, which is the one
 * thing no test in this repository can establish.
 */
import { defineLens } from '@epicenter/lens/lens';
import { createStore } from '@epicenter/data/store';
import { createSyncClient } from '@epicenter/data/sync';
import { createBrowserSqliteAdapter } from '@epicenter/sqlite/browser';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

const lens = defineLens({
	namespace: 'so.epicenter.synclab',
	tables: { notes: { title: 'string', device: 'string', at: 'string' } },
});

const device =
	localStorage.getItem('sync-lab-device') ??
	(() => {
		const minted = `${navigator.platform || 'device'}-${Math.random().toString(36).slice(2, 6)}`;
		localStorage.setItem('sync-lab-device', minted);
		return minted;
	})();

const sqlite3 = await sqlite3InitModule();
const store = createStore({
	database: createBrowserSqliteAdapter(
		new sqlite3.oo1.DB(':memory:') as never,
	),
});
const bound = store.bind(lens);
if (bound.error !== null) throw bound.error;
const db = bound.data;

const client = createSyncClient({ store, idleMs: 1_000 });

const rows = document.querySelector('#rows') as HTMLElement;
const status = document.querySelector('#status') as HTMLElement;
const title = document.querySelector('#title') as HTMLInputElement;
const record = document.querySelector('#record') as HTMLButtonElement;
const paste = document.querySelector('#paste') as HTMLButtonElement;

function render(): void {
	const listed = db.notes.list();
	rows.replaceChildren(
		...(listed.data?.rows ?? [])
			.sort((left, right) => left.at.localeCompare(right.at))
			.map((row) => {
				const item = document.createElement('li');
				item.textContent = `${row.title}  ·  ${row.device}`;
				item.className = row.device === device ? 'mine' : 'theirs';
				return item;
			}),
	);
	const state = client.status();
	status.textContent = [
		`device ${device}`,
		`cursor ${state.cursor}`,
		state.inFlight ? `in flight (${state.owed} B)` : 'idle',
		state.lastError === undefined ? 'no errors' : `ERROR ${state.lastError.message}`,
		state.unresolvedDependencies ? 'UNRESOLVED DEPENDENCIES' : '',
	]
		.filter(Boolean)
		.join('  ·  ');
}

/** Reconnect from the replica's own cursor, which is the only catch-up there is. */
function connect(): void {
	const url = new URL('/sync', location.href);
	url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
	url.searchParams.set('app', 'lab');
	url.searchParams.set('cursor', String(client.cursor()));
	const socket = new WebSocket(url);
	socket.binaryType = 'arraybuffer';

	socket.addEventListener('open', () => {
		client.attach({ send: (bytes) => socket.send(bytes) });
		render();
	});
	socket.addEventListener('message', (event) => {
		if (typeof event.data === 'string') return;
		client.receive(new Uint8Array(event.data as ArrayBuffer));
		render();
	});
	socket.addEventListener('close', () => {
		client.detach();
		render();
		setTimeout(connect, 1_000);
	});
	socket.addEventListener('error', () => socket.close());
}

function write(fields: { title: string }): void {
	const written = db.notes.create({
		title: fields.title,
		device,
		at: new Date().toISOString(),
	});
	if (written.error !== null) {
		status.textContent = `write failed: ${written.error.message}`;
		return;
	}
	// Nudge rather than flush: the idle timer is what turns a burst of
	// transactions into one entry, and it is the whole reason the authority's
	// log is affordable to never compact.
	client.nudge();
	render();
}

record.addEventListener('click', () => {
	write({ title: title.value.trim() || 'untitled' });
	title.value = '';
});

title.addEventListener('keydown', (event) => {
	if (event.key === 'Enter') record.click();
});

paste.addEventListener('click', () => {
	// One transaction well past the 2,097,152-byte storage cap, so the chunking
	// path is exercised by hand on a real device rather than only in a test.
	const written = db.notes.create({
		title: 'a 3 MB paste',
		device,
		at: new Date().toISOString(),
	});
	if (written.error !== null) return;
	const text = db.notes.document(written.data.id)?.get('editor', 'text');
	text?.applyDelta(text.change.insert('x'.repeat(3_000_000)) as never);
	client.nudge();
	render();
});

render();
connect();
