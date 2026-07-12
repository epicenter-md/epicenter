/**
 * DISPOSABLE TYPE PROTOTYPE — realistic usage of the pass-3 API.
 * This file is the falsification target: it must typecheck with usable
 * inferred types, and the `@ts-expect-error` lines must actually error.
 *
 * The `field` stand-ins below mirror @epicenter/field's inference-relevant
 * behavior with plain TypeBox (the demo package does not depend on the real
 * field package). The real API keeps the real builders.
 */

import { type Static, type TSchema, type TUnsafe, Type } from 'typebox';
import {
	defineKv,
	defineTable,
	defineWorkspace,
	openStandaloneWorkspace,
	openWorkspaceReplica,
	planEpochUpgrade,
} from './api.ts';

// ─── field.* stand-ins (brands via Type.Unsafe, like the real builders) ──────

declare const BrandSymbol: unique symbol;
type Brand<T extends string> = { [BrandSymbol]: T };

const field = {
	string: <T extends string = string>() =>
		Type.Unsafe<T>(Type.String()) as TUnsafe<T>,
	reference: <T extends string>(_table: string) =>
		Type.Unsafe<T>(Type.String()) as TUnsafe<T>,
	boolean: () => Type.Boolean(),
	number: () => Type.Number(),
	instant: () => Type.Unsafe<string & Brand<'Instant'>>(Type.String()),
	select: <const V extends readonly string[]>(values: readonly [...V]) =>
		Type.Unsafe<V[number]>(Type.String({ enum: [...values] })),
	json: <S extends TSchema>(inner: S) => Type.Unsafe<Static<S>>(inner),
};
const nullable = <S extends TSchema>(inner: S) =>
	Type.Unsafe<Static<S> | null>(Type.Union([inner, Type.Null()]));

// ─── Branded ids and two related tables ──────────────────────────────────────

type FolderId = string & Brand<'FolderId'>;
type NoteId = string & Brand<'NoteId'>;

const folders = defineTable(
	{
		id: field.string<FolderId>(),
		name: field.string(),
		sortOrder: field.number(),
	},
	{ indexes: [['sortOrder']] },
);

const notes = defineTable(
	{
		id: field.string<NoteId>(),
		folderId: nullable(field.reference<FolderId>('folders')),
		title: field.string(),
		pinned: field.boolean(),
		status: field.select(['draft', 'published']),
		createdAt: field.instant(),
		updatedAt: field.instant(),
	},
	{
		indexes: [['folderId'], ['updatedAt'], ['folderId', 'updatedAt']],
		docs: { body: 'richText', summary: 'plainText' },
	},
);

// ─── KV (schemas must not admit null; clear() returns to the default) ────────

const kv = {
	'sidebar.collapsed': defineKv(Type.Boolean(), () => false),
	'editor.layout': defineKv(
		Type.Object({ width: Type.Number(), split: Type.Boolean() }),
		() => ({ width: 320, split: false }),
	),
};

// ─── Workspace with exact logical schema epochs ──────────────────────────────

const workspace = defineWorkspace({
	id: 'epicenter-notes-example',
	name: 'Notes',
	// Authored semantic id included in the initial exact schema identity.
	epoch: 'epk-notes-01hzy3k8',
	tables: { folders, notes },
	kv,
	migrations: [
		// v2 added the synchronized notes.status field, so it creates a new exact
		// schema epoch. Representation-only changes such as indexes could use
		// apply(tx) without an epoch entry.
		{
			epoch: {
				id: 'epk-notes-01j1addstatus',
				transformCells: (row) =>
					row.table === 'notes' ? { ...row.cells, status: 'draft' } : row.cells,
			},
		},
		// v3 changes title semantics by trimming it, so the authored semantic id
		// changes even though the physical column shape does not. The replica
		// never rewrites the shared database or its outbox in place.
		{
			epoch: {
				id: 'epk-notes-01j2m9qa',
				transformCells: (row) =>
					row.table === 'notes'
						? {
								...row.cells,
								title: String(row.cells.title ?? '').trim(),
							}
						: row.cells,
				// Row ids stay stable, so omitting mapIdentity means identity for
				// both rows and tombstones.
			},
		},
	],
});

// ─── Opening: two doors, not one option ──────────────────────────────────────

async function main() {
	// Local-only: no actor, cursor, or outbox exist.
	const local = await openStandaloneWorkspace(workspace, {
		storage: { kind: 'opfs' },
	});

	// Synchronized replica of the account database, current epoch.
	const ws = await openWorkspaceReplica(workspace, {
		storage: { kind: 'opfs' },
		sync: { baseUrl: 'https://api.epicenter.sh' },
	});

	const noteId = 'n_1' as NoteId;
	const folderId = 'f_1' as FolderId;

	// ── Point reads ──
	const note = await ws.tables.notes.get(noteId);
	if (note) {
		// Inferred row type: branded id, nullable reference, literal union.
		const _id: NoteId = note.id;
		const _folder: FolderId | null = note.folderId;
		const _status: 'draft' | 'published' = note.status;
	}

	// ── Typed list reads (indexed) ──
	const inFolder = await ws.tables.notes.list({
		where: { folderId },
		orderBy: 'updatedAt',
		desc: true,
		limit: 50,
	});
	const _titles: string[] = inFolder.map((n) => n.title);

	// ── Expressive relational query via the SELECT-only PHYSICAL escape hatch ──
	const noteCounts = await ws.sql(
		`SELECT f.id AS folderId, count(n.id) AS noteCount
		 FROM folders f LEFT JOIN notes n ON n.folderId = f.id
		 GROUP BY f.id ORDER BY f.sortOrder`,
		[],
		Type.Object({ folderId: Type.String(), noteCount: Type.Number() }),
	);
	const firstCount = noteCounts[0];
	if (!firstCount) throw new Error('Expected one count row');
	const _count: number = firstCount.noteCount;

	// ── put: write every declared cell (one atomic mutation, not replacement) ──
	await ws.tables.notes.put({
		id: noteId,
		folderId: null,
		title: 'Hello',
		pinned: false,
		status: 'draft',
		createdAt: '2026-07-11T00:00:00.000Z' as string & Brand<'Instant'>,
		updatedAt: '2026-07-11T00:00:00.000Z' as string & Brand<'Instant'>,
	});

	// ── patch: named cells of a live row ──
	await ws.tables.notes.patch(noteId, { pinned: true, status: 'published' });

	// ── remove: terminal deletion, id never reused ──
	await ws.tables.folders.remove(folderId);

	// ── KV set and clear ──
	await ws.kv.set('sidebar.collapsed', true);
	await ws.kv.set('editor.layout', { width: 400, split: true });
	await ws.kv.clear('editor.layout');
	const _layout: { width: number; split: boolean } =
		await ws.kv.get('editor.layout');

	// ── One atomic multi-table + KV transaction (ONE mutation on the wire) ──
	const orphaned = await ws.tables.notes.list({ where: { folderId } });
	await ws.transact((tx) => {
		for (const n of orphaned) tx.tables.notes.patch(n.id, { folderId: null });
		tx.tables.folders.remove(folderId);
		tx.kv.set('sidebar.collapsed', false);
	});

	// ── Child documents: open and dispose ──
	{
		using body = await ws.docs.notes.body(noteId);
		const _fragment = body.yFragment; // Y.XmlFragment for the editor
		using summary = await ws.docs.notes.summary(noteId);
		const _text: string = summary.getText();
	}

	// ── Reactive observation ──
	const stopTable = ws.tables.notes.observe((delta) => {
		void delta.upserted.some((row) => row.id === noteId);
	});
	const stopQuery = ws.observeSql(['folders', 'notes'], () => {
		void ws.sql(
			'SELECT count(*) AS c FROM notes',
			[],
			Type.Object({ c: Type.Number() }),
		);
	});
	stopTable();
	stopQuery();

	// ── Promotion: explicit import into the open replica, never a reopen ──
	const promotion = await ws.planImport({
		kind: 'workspace',
		workspace: local,
	});
	await promotion.apply(); // empty/unambiguous parts auto-apply
	// ...retire `local` only after the imported mutations are accepted.

	// ── Restore / clone adoption: same door, reviewable when both sides moved ──
	const restore = await ws.planImport({
		kind: 'file',
		path: '/backups/notes.db',
	});
	await restore.apply({ prefer: 'destination' });

	// ── Epoch upgrade: the explicit door for a superseded-epoch replica ──
	const upgrade = await planEpochUpgrade(workspace, {
		storage: { kind: 'opfs' },
		sync: { baseUrl: 'https://api.epicenter.sh' },
	});
	await upgrade.apply();

	// ── Logical export: rows and content, never replica identity ──
	const _bytes: Uint8Array = await ws.exportSnapshot();

	await local[Symbol.asyncDispose]();
	await ws[Symbol.asyncDispose]();
}

// ─── Negative space: these MUST be compile errors ────────────────────────────

async function negatives() {
	const ws = await openWorkspaceReplica(workspace, {
		storage: { kind: 'memory' },
		sync: { baseUrl: 'https://api.epicenter.sh' },
	});
	const noteId = 'n_1' as NoteId;
	const folderId = 'f_1' as FolderId;

	// @ts-expect-error a FolderId is not a NoteId (branded ids do not mix)
	ws.tables.notes.get(folderId);

	// @ts-expect-error status must be one of the declared select members
	ws.tables.notes.patch(noteId, { status: 'archived' });

	// @ts-expect-error id is not patchable
	ws.tables.notes.patch(noteId, { id: 'n_2' as NoteId });

	// @ts-expect-error put requires the complete declared row
	ws.tables.notes.put({ id: noteId, title: 'partial' });

	// @ts-expect-error unknown KV key
	ws.kv.get('missing.key');

	// @ts-expect-error KV value must match the declared schema
	ws.kv.set('sidebar.collapsed', 'yes');

	// @ts-expect-error folders declares no child docs
	ws.docs.folders.body;

	// @ts-expect-error openWorkspaceReplica requires a sync connection
	await openWorkspaceReplica(workspace, { storage: { kind: 'memory' } });

	await openStandaloneWorkspace(workspace, {
		storage: { kind: 'memory' },
		// @ts-expect-error a local workspace takes no sync option
		sync: { baseUrl: 'x' },
	});
}

void main;
void negatives;
