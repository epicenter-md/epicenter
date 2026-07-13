import { field } from '@epicenter/field';
import {
	defineKv,
	defineTable,
	defineWorkspace,
} from '@epicenter/workspace/sqlite';

const notes = defineTable({
	fields: {
		id: field.string(),
		title: field.string(),
	},
});

export const workspaceDefinition = defineWorkspace({
	id: 'browser-sqlite-smoke',
	name: 'Browser SQLite smoke',
	tables: { notes },
	kv: {
		theme: defineKv(field.select(['light', 'dark']), () => 'light' as const),
	},
});

export const mismatchedWorkspaceDefinition = defineWorkspace({
	id: 'browser-sqlite-smoke',
	name: 'Browser SQLite smoke mismatch',
	tables: {
		notes: defineTable({
			fields: {
				id: field.string(),
				title: field.string(),
				body: field.string(),
			},
		}),
	},
	kv: {
		theme: defineKv(field.select(['light', 'dark']), () => 'light' as const),
	},
});
