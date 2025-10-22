// Centralized ArkType schemas and inferred types for the Notes feature.
// Single source of truth for request/response shapes.

import { type } from 'arktype';

// Public view of a note returned to the client/UI
export const NoteViewSchema = type({
	id: 'string',
	title: 'string',
	body: 'string | undefined',
	created_at: 'number',
	entity_links: type('string[]'),
});
export type NoteView = typeof NoteViewSchema.infer;

// Entity rows (lightweight shape for pickers and linking)
export const EntityRowSchema = type({
	id: 'string',
	name: 'string | null | undefined',
	type: 'string | null | undefined',
});
export type EntityRow = typeof EntityRowSchema.infer;

// Create note input payload
export const CreateNoteInputSchema = type({
	title: 'string',
	body: 'string',
	'entity_links?': type('string[]'),
});
export type CreateNoteInput = typeof CreateNoteInputSchema.infer;

// I'm not implementing partial updates at the schema level for simplicity
export const UpdateNoteInputSchema = type.and(
	CreateNoteInputSchema,
	type({
		id: 'string',
	}),
);
export type UpdateNoteInput = typeof UpdateNoteInputSchema.infer;

export const IdSchema = type({
	id: 'string',
});
export type IdInput = typeof IdSchema.infer;

// Optional list filter
export const ListNotesInputSchema = type({
	search: 'string | undefined',
});
export type ListNotesInput = typeof ListNotesInputSchema.infer;
