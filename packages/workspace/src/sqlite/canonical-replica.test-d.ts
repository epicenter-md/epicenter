import type { RowSyncSqlite } from '@epicenter/row-sync';
import { createCanonicalReplica } from './canonical-replica.js';

declare const sqlite: RowSyncSqlite;
const replica = createCanonicalReplica({
	sqlite,
	transport: {
		async enroll() {
			return {};
		},
		async sync() {
			return {};
		},
		async baselineScan() {
			return {};
		},
	},
	codec: { mergeUpdates: (parts) => parts[0] ?? new Uint8Array() },
});

replica.admit({
	kind: 'create',
	table: 'notes',
	rowId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
	fields: { title: 'typed' },
});

// @ts-expect-error create intents require complete fields
replica.admit({
	kind: 'create',
	table: 'notes',
	rowId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
});
replica.admit({
	kind: 'delete',
	table: 'notes',
	rowId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
	// @ts-expect-error delete intents cannot carry fields
	fields: { set: {}, unset: [] },
});
