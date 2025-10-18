import {
	createInsertSchema,
	createSelectSchema,
	createUpdateSchema,
} from 'drizzle-arktype';
import {
	pgTable,
	primaryKey,
	text,
	timestamp,
	unique,
} from 'drizzle-orm/pg-core';
import { customAlphabet } from 'nanoid';
import type { EncryptedData } from '../lib/encryption';
import { user } from './auth';

const generateId = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 12);

export const assistantConfig = pgTable(
	'assistant_config',
	{
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		id: text('id')
			.notNull()
			.$defaultFn(() => generateId()),
		name: text('name').notNull(),
		url: text('url').notNull(),
		password: text('password').$type<EncryptedData>(),
		createdAt: timestamp('created_at')
			.$defaultFn(() => /* @__PURE__ */ new Date())
			.notNull(),
		updatedAt: timestamp('updated_at')
			.$defaultFn(() => /* @__PURE__ */ new Date())
			.notNull(),
		lastAccessedAt: timestamp('last_accessed_at')
			.$defaultFn(() => /* @__PURE__ */ new Date())
			.notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.userId, table.id] }),
		unique('assistant_config_user_id_url_unique').on(table.userId, table.url),
	],
);

export const assistantConfigSelectSchema = createSelectSchema(assistantConfig);
export type AssistantConfigSelect = typeof assistantConfigSelectSchema.infer;

export const assistantConfigInsertSchema = createInsertSchema(assistantConfig);
export type AssistantConfigInsert = typeof assistantConfigInsertSchema.infer;

export const assistantConfigUpdateSchema = createUpdateSchema(
	assistantConfig,
).and({ userId: 'string', id: 'string' });
export type AssistantConfigUpdate = typeof assistantConfigUpdateSchema.infer;
