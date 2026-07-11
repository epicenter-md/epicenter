/**
 * Demo notes app.
 *
 * Boot mirrors Honeycrisp's contract: signed out = complete anonymous local
 * database, zero network; signed in = principal-owned local database plus
 * sync. Reactivity is invalidation-driven off the db worker's change events
 * (the `fromTable` analogue). Sign-in migration produces a typed, cell-level
 * import plan whose destination is the principal's LOCAL database — the
 * server only ever sees the resulting ordinary ops.
 *
 * URL params: ?profile=A|B  &appver=1|2  &server=http://localhost:8788
 */

import type { JsonCell } from '../../shared/protocol';
import { type BodyHandle, openBody } from './body-doc';
import { createDbClient, type NoteRecord } from './db-client';
import { createSync, type SyncStatus } from './sync';

const params = new URLSearchParams(location.search);
const PROFILE = params.get('profile') ?? 'A';
const APP_VERSION = (Number(params.get('appver') ?? '2') === 1 ? 1 : 2) as
	| 1
	| 2;
const SERVER_URL = params.get('server') ?? 'http://localhost:8788';
// The client's schema major: v1 and v2 builds share major 2 (additive field);
// ?schemamajor=1 simulates a breaking-generation client for the pause proof.
const SCHEMA_MAJOR = Number(params.get('schemamajor') ?? '2');

const sessionKey = `demo-session-${PROFILE}`;
const clientIdKey = `demo-client-${PROFILE}`;

function loadSession(): { principal: string; token: string } | null {
	const raw = localStorage.getItem(sessionKey);
	return raw ? (JSON.parse(raw) as { principal: string; token: string }) : null;
}

const clientId =
	localStorage.getItem(clientIdKey) ??
	`${PROFILE}-${Math.random().toString(36).slice(2, 8)}`;
localStorage.setItem(clientIdKey, clientId);

const db = createDbClient();
let session = loadSession();
let online = true;
let syncStatus: SyncStatus = 'off';
let sync: ReturnType<typeof createSync> | null = null;
let openedBody: { noteId: string; handle: BodyHandle } | null = null;

function dbFile(): string {
	return session
		? `notes-${session.principal}-${PROFILE}.db`
		: `notes-anon-${PROFILE}.db`;
}

async function boot() {
	await db.open({ file: dbFile(), appVersion: APP_VERSION, clientId });
	if (session) startSync();
	renderChrome();
	await renderNotes();
}

function startSync() {
	if (!session) return;
	sync?.stop();
	sync = createSync({
		db,
		serverUrl: SERVER_URL,
		token: session.token,
		clientId,
		schemaMajor: SCHEMA_MAJOR,
		isOnline: () => online,
		onStatus: (status) => {
			syncStatus = status;
			renderChrome();
		},
	});
	sync.start();
}

// ─── Writes (the app's table API) ────────────────────────────────────────────

let noteCounter = 0;
function newNoteId(): string {
	return `n-${clientId}-${Date.now().toString(36)}-${noteCounter++}`;
}

async function createNote(title: string): Promise<string> {
	const id = newNoteId();
	const cells: Record<string, JsonCell> = {
		title,
		pinned: false,
		updatedAt: new Date().toISOString(),
	};
	if (APP_VERSION === 2) cells.subtitle = '';
	await db.write({ kind: 'row-insert', table: 'notes', rowId: id, cells });
	return id;
}

async function patchCell(rowId: string, field: string, value: JsonCell) {
	await db.write({ kind: 'cell', table: 'notes', rowId, field, value });
	await db.write({
		kind: 'cell',
		table: 'notes',
		rowId,
		field: 'updatedAt',
		value: new Date().toISOString(),
	});
}

async function deleteNote(rowId: string) {
	await db.write({ kind: 'row-delete', table: 'notes', rowId });
}

// ─── Sign-in migration (Add / Delete / Keep) ────────────────────────────────

export type ImportPlan = {
	inserts: { rowId: string; cells: Record<string, JsonCell> }[];
	cellImports: {
		rowId: string;
		field: string;
		from: JsonCell;
		to: JsonCell;
	}[];
	docFrames: { docId: string; frames: string[] }[];
};

/** Read everything importable from the anonymous DB (before switching files). */
async function probeAnonymous() {
	await db.open({
		file: `notes-anon-${PROFILE}.db`,
		appVersion: APP_VERSION,
		clientId,
	});
	const rows = await db.exportRows();
	const docs: { docId: string; frames: string[] }[] = [];
	for (const row of rows) {
		const docId = `note-body-${row.id}`;
		const frames = await db.docUpdates(docId);
		if (frames.length > 0) docs.push({ docId, frames });
	}
	return { rows, docs };
}

function rowCells(row: NoteRecord): Record<string, JsonCell> {
	const cells: Record<string, JsonCell> = {};
	for (const [key, value] of Object.entries(row)) {
		if (key === 'id' || key === 'extra' || value === null) continue;
		cells[key] = value as JsonCell;
	}
	for (const [key, value] of Object.entries(
		JSON.parse(row.extra ?? '{}') as Record<string, JsonCell>,
	)) {
		cells[key] = value;
	}
	return cells;
}

/**
 * Typed, cell-level import plan: insert rows the principal DB lacks; for
 * matching IDs, import only cells that differ (anonymous value wins locally;
 * the server then orders it like any other write).
 */
async function planImport(anon: {
	rows: NoteRecord[];
	docs: { docId: string; frames: string[] }[];
}): Promise<ImportPlan> {
	const plan: ImportPlan = { inserts: [], cellImports: [], docFrames: anon.docs };
	for (const row of anon.rows) {
		const existing = await db.getNote(row.id);
		if (!existing) {
			plan.inserts.push({ rowId: row.id, cells: rowCells(row) });
		} else {
			const existingCells = rowCells(existing);
			for (const [field, value] of Object.entries(rowCells(row))) {
				if (existingCells[field] !== value) {
					plan.cellImports.push({
						rowId: row.id,
						field,
						from: existingCells[field] ?? null,
						to: value,
					});
				}
			}
		}
	}
	return plan;
}

async function applyImport(plan: ImportPlan) {
	for (const insert of plan.inserts) {
		await db.write({
			kind: 'row-insert',
			table: 'notes',
			rowId: insert.rowId,
			cells: insert.cells,
		});
	}
	for (const cell of plan.cellImports) {
		await db.write({
			kind: 'cell',
			table: 'notes',
			rowId: cell.rowId,
			field: cell.field,
			value: cell.to,
		});
	}
	for (const doc of plan.docFrames) {
		for (const frame of doc.frames) {
			await db.write({ kind: 'doc', docId: doc.docId, update: frame });
		}
	}
}

async function signIn(
	principal: string,
	choice: 'add' | 'delete' | 'keep',
): Promise<{ plan: ImportPlan | null }> {
	const anon = await probeAnonymous();
	session = { principal, token: principal };
	localStorage.setItem(sessionKey, JSON.stringify(session));

	if (choice === 'delete') {
		await db.wipe(`notes-anon-${PROFILE}.db`);
	}

	// The principal-owned LOCAL database is the migration destination.
	await db.open({ file: dbFile(), appVersion: APP_VERSION, clientId });

	let plan: ImportPlan | null = null;
	if (choice === 'add' && (anon.rows.length > 0 || anon.docs.length > 0)) {
		plan = await planImport(anon);
		await applyImport(plan);
	}
	startSync();
	renderChrome();
	await renderNotes();
	return { plan };
}

async function signOut() {
	sync?.stop();
	sync = null;
	session = null;
	localStorage.removeItem(sessionKey);
	await db.open({ file: dbFile(), appVersion: APP_VERSION, clientId });
	renderChrome();
	await renderNotes();
}

// ─── UI (invalidation-driven, no polling) ────────────────────────────────────

const el = {
	status: document.getElementById('status')!,
	list: document.getElementById('notes')!,
	newTitle: document.getElementById('new-title') as HTMLInputElement,
	body: document.getElementById('body')!,
	bodyText: document.getElementById('body-text')!,
	bodyAppend: document.getElementById('body-append') as HTMLInputElement,
};

function renderChrome() {
	el.status.textContent = [
		`profile ${PROFILE}`,
		`app v${APP_VERSION}`,
		session ? `signed in: ${session.principal}` : 'anonymous',
		online ? 'network on' : 'NETWORK OFF',
		`sync: ${session ? syncStatus : 'n/a (local-only)'}`,
	].join(' · ');
}

async function renderNotes() {
	const notes = await db.listNotes();
	el.list.innerHTML = '';
	for (const note of notes) {
		const item = document.createElement('li');
		item.dataset.id = note.id;
		const extra = JSON.parse(note.extra ?? '{}') as Record<string, unknown>;
		const extraText = Object.keys(extra).length
			? ` [carries unknown: ${JSON.stringify(extra)}]`
			: '';
		item.textContent = `${note.title ?? '(untitled)'}${
			'subtitle' in note && note.subtitle ? ` — ${note.subtitle}` : ''
		}${extraText}`;
		item.onclick = () => void openNoteBody(note.id);
		el.list.append(item);
	}
}

async function openNoteBody(noteId: string) {
	openedBody?.handle.close();
	const handle = await openBody({ db, noteId });
	openedBody = { noteId, handle };
	renderBody();
}

function renderBody() {
	if (!openedBody) return;
	el.body.dataset.noteId = openedBody.noteId;
	el.bodyText.textContent = openedBody.handle.text.toString();
}

let pushTimer: ReturnType<typeof setTimeout> | null = null;
db.onChange((scope) => {
	if (scope === 'notes') void renderNotes();
	if (openedBody && scope === `doc:note-body-${openedBody.noteId}`) {
		void openedBody.handle.applyRemoteFromLog().then(renderBody);
	}
	// Any committed write may have enqueued outbox ops: schedule a sync.
	if (!pushTimer) {
		pushTimer = setTimeout(() => {
			pushTimer = null;
			void sync?.syncNow();
		}, 150);
	}
});

document.getElementById('create')!.onclick = async () => {
	if (el.newTitle.value) await createNote(el.newTitle.value);
	el.newTitle.value = '';
};
document.getElementById('toggle-network')!.onclick = () => {
	online = !online;
	if (online) sync?.start();
	else sync?.stop();
	renderChrome();
};
document.getElementById('append-body')!.onclick = async () => {
	if (!openedBody) return;
	openedBody.handle.insert(
		openedBody.handle.text.length,
		el.bodyAppend.value,
	);
	el.bodyAppend.value = '';
	renderBody();
};
document.getElementById('sign-in')!.onclick = async () => {
	const principal = prompt('principal (e.g. braden)') ?? '';
	if (!principal) return;
	const { notes } = await db.counts();
	const choice =
		notes > 0
			? ((prompt(`${notes} anonymous notes. add / delete / keep?`) ??
					'keep') as 'add' | 'delete' | 'keep')
			: 'keep';
	await signIn(principal, choice);
};
document.getElementById('sign-out')!.onclick = () => void signOut();

// ─── Proof-runner surface ────────────────────────────────────────────────────

declare global {
	interface Window {
		demo: {
			profile: string;
			appVersion: number;
			db: typeof db;
			ready: Promise<void>;
			createNote: typeof createNote;
			patchCell: typeof patchCell;
			deleteNote: typeof deleteNote;
			signIn: typeof signIn;
			signOut: typeof signOut;
			setOnline: (value: boolean) => void;
			syncNow: () => Promise<void>;
			syncStatus: () => string;
			openNoteBody: (id: string) => Promise<void>;
			bodyText: () => string;
			bodyFrameCount: () => number;
			appendBody: (content: string) => void;
			listTitles: () => Promise<Record<string, unknown>[]>;
		};
	}
}

const ready = boot();
window.demo = {
	profile: PROFILE,
	appVersion: APP_VERSION,
	db,
	ready,
	createNote,
	patchCell,
	deleteNote,
	signIn,
	signOut,
	setOnline(value) {
		online = value;
		if (value) sync?.start();
		else sync?.stop();
		renderChrome();
	},
	syncNow: async () => {
		await sync?.syncNow();
	},
	syncStatus: () => (session ? syncStatus : 'off'),
	openNoteBody,
	bodyText: () => openedBody?.handle.text.toString() ?? '',
	bodyFrameCount: () => openedBody?.handle.frameCount ?? -1,
	appendBody: (content) => {
		if (openedBody)
			openedBody.handle.insert(openedBody.handle.text.length, content);
	},
	listTitles: () => db.listNotes(),
};
