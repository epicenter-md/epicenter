import { error, redirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { form, query } from '$app/server';
import {
	CreateNoteInputSchema,
	IdSchema,
	type NoteView,
	NoteViewSchema,
	UpdateNoteInputSchema,
} from '$lib/schemas/notes';
import { getVault } from '$lib/server/vaultService';

function parseStringArrayJson(text: unknown): string[] {
	if (text == null) return [];
	if (typeof text === 'string') {
		const v = JSON.parse(text);
		return Array.isArray(v) ? v.map(String) : [];
	}
	if (Array.isArray(text)) return text.map(String);
	return [];
}

function asEpochMs(v: unknown): number {
	if (v instanceof Date) return v.getTime();
	if (typeof v === 'number') return v;
	const n = Number(v);
	return Number.isFinite(n) ? n : Date.now();
}

/**
 * Query: return latest notes as an array of NoteView (parsed entity_links).
 */
export const getNotes = query(async (): Promise<NoteView[]> => {
	const { db, tables } = getVault().getQueryInterface();

	const notesTable = tables.example_notes.example_notes_items;

	const rows = await db.select().from(notesTable);

	const notes = rows
		.map(
			(r) =>
				NoteViewSchema({
					id: r.id,
					title: (r.title ?? '').toString(),
					body: r.body == null ? undefined : r.body.toString(),
					created_at: asEpochMs(r.created_at),
					entity_links: parseStringArrayJson(r.entity_links),
				}) as NoteView,
		)
		.sort((a, b) => b.created_at - a.created_at);

	return notes;
});

/**
 * Form: create a new note directly via Drizzle insert.
 */
export const createNote = form(CreateNoteInputSchema, async (input) => {
	const { title, body, entity_links } = input;
	const trimmed = title.trim();
	if (trimmed.length === 0) throw new Error('title is required');

	const { db, tables } = getVault().getQueryInterface();
	const notesTable = tables.example_notes.example_notes_items;

	const id = globalThis.crypto?.randomUUID();

	await db.insert(notesTable).values({
		id,
		title: trimmed,
		body: body,
		// tags: [], // This isn't working, not sure if I need to make sure schema is synced
		// Store entity_links as canonical JSON string (TEXT) to match schema/default "[]"
		entity_links: JSON.stringify(entity_links),
		created_at: new Date(),
		public_id: null,
	});

	return redirect(303, `/notes/${id}`);
});

/**
 * Fetch a single note by id. Returns a NoteView or
 */
export const getNoteById = query(IdSchema, async ({ id }) => {
	const vault = getVault();
	const { db, tables } = vault.getQueryInterface();
	const notesTable = tables.example_notes.example_notes_items;

	const rows = await db.select().from(notesTable).where(eq(notesTable.id, id));
	const row = rows?.[0];
	if (!row) return error(404, 'note not found');

	return NoteViewSchema({
		id: row.id,
		title: (row.title ?? '').toString(),
		body: row.body == null ? undefined : row.body.toString(),
		created_at: asEpochMs(row.created_at),
		entity_links: parseStringArrayJson(row.entity_links),
	}) as NoteView;
});

/**
 * Update a note by id. Supports partial updates: title, body, entity_links
 */
export const updateNote = form(
	UpdateNoteInputSchema,
	async ({ id, title, body, entity_links }) => {
		const { db, tables } = getVault().getQueryInterface();
		const notesTable = tables.example_notes.example_notes_items;

		const updates: Record<string, unknown> = {};
		if (typeof title === 'string') updates.title = title;
		if (typeof body === 'string') updates.body = body;
		if (Array.isArray(entity_links))
			updates.entity_links = JSON.stringify(entity_links);

		if (Object.keys(updates).length === 0) return { ok: true };

		await db.update(notesTable).set(updates).where(eq(notesTable.id, id));

		return { ok: true };
	},
);

/**
 * Delete a note by id.
 */
export const deleteNote = form(IdSchema, async ({ id }) => {
	const { db, tables } = getVault().getQueryInterface();
	const notesTable = tables.example_notes?.example_notes_items;
	if (!notesTable) throw new Error('notes table missing');

	await db.delete(notesTable).where(eq(notesTable.id, id));

	return redirect(303, '/notes');
});
