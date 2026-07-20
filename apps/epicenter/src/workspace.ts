import {
	type BoundData,
	defineTable,
	optional,
	type RowFor,
} from '@epicenter/data';
import { field } from '@epicenter/field';

export const conversationsTable = defineTable({
	key: 'so.epicenter.home.conversations',
	fields: {
		title: field.string(),
		model: field.string(),
		createdAt: field.instant(),
		updatedAt: field.instant(),
	},
	document: true,
});

export const honeycrispFoldersTable = defineTable({
	key: 'so.epicenter.honeycrisp.folders',
	fields: {
		name: field.string(),
		icon: optional(field.string()),
		sortOrder: field.number(),
	},
});

export const honeycrispNotesTable = defineTable({
	key: 'so.epicenter.honeycrisp.notes',
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
	document: true,
});

export const homeDefinitions = {
	tables: {
		conversations: conversationsTable,
		folders: honeycrispFoldersTable,
		notes: honeycrispNotesTable,
	},
	values: {},
} as const;

export type Conversation = RowFor<typeof conversationsTable>;
export type HomeData = BoundData<
	typeof homeDefinitions.tables,
	typeof homeDefinitions.values
>;
export type ConversationsData = Pick<HomeData['tables'], 'conversations'>;
export type HoneycrispData = Pick<HomeData['tables'], 'folders' | 'notes'>;
