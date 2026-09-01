import { defineData, defineTable, field, plainText } from '@epicenter/data/definition';

/** Local Mail's synced account registry. The row id is the Epicenter accountId. */
const database = defineData({
	id: 'so.epicenter.local-mail',
	title: 'Local Mail',
	kv: {},
	tables: {
		accounts: defineTable({
			provider: field.select(['gmail']),
			providerAccountId: field.string(),
			email: field.string(),
			connectedAt: field.instant(),
			lastSyncedAt: field.nullable(field.instant()),
			content: plainText(),
		}),
	},
});

export default database;
