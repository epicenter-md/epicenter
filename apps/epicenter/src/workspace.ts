import {
	type BoundData,
	defineLens,
	defineTable,
	optional,
	type RowFor,
} from '@epicenter/data';
import { field } from '@epicenter/field';

export const conversationsTable = defineTable({
	fields: {
		title: field.string(),
		model: field.string(),
		createdAt: field.instant(),
		updatedAt: field.instant(),
	},
});

export const honeycrispFoldersTable = defineTable({
	fields: {
		name: field.string(),
		icon: optional(field.string()),
		sortOrder: field.number(),
	},
});

export const honeycrispNotesTable = defineTable({
	fields: {
		folderId: optional(field.string()),
		title: field.string(),
		preview: field.string(),
		pinned: field.boolean(),
		createdAt: field.instant(),
		updatedAt: field.instant(),
		deletedAt: optional(field.instant()),
		wordCount: optional(field.number()),
	},
});

/**
 * Home's own Lens over the namespace Home owns.
 *
 * A Lens interprets exactly one namespace (ADR-0160), so Home's conversations and
 * the Honeycrisp tables the host mirrors cannot share one Lens. They never were
 * one thing: the split makes visible that the host reads a namespace another
 * application owns.
 */
export const homeLens = defineLens({
	namespace: 'so.epicenter.home',
	tables: { conversations: conversationsTable },
	values: {},
});

/**
 * Home's release-local interpretation of Honeycrisp's namespace.
 *
 * These definitions deliberately duplicate Honeycrisp's own Lens rather than
 * importing it: an interpretation is release-local, and the host must be able to
 * read the namespace without depending on that application's build (ADR-0168).
 */
export const honeycrispMirrorLens = defineLens({
	namespace: 'so.epicenter.honeycrisp',
	tables: { folders: honeycrispFoldersTable, notes: honeycrispNotesTable },
	values: {},
});

export type Conversation = RowFor<typeof conversationsTable>;
export type ConversationsData = BoundData<
	typeof homeLens.tables,
	typeof homeLens.values
>['tables'];
export type HoneycrispData = BoundData<
	typeof honeycrispMirrorLens.tables,
	typeof honeycrispMirrorLens.values
>['tables'];
