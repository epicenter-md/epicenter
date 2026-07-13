/**
 * Records Migration Definition Type Tests
 *
 * Locks contextual source/target cell inference, at-rest normalization,
 * target-shaped transform output with focused removed-cell and id refusals,
 * discard coverage, and terminal-chain typing against real SQLite
 * TableDefinition values. Runtime schema validation owns exact output.
 */

import {
	type DateTimeString,
	field,
	type InstantString,
} from '@epicenter/field';
import { Type } from 'typebox';
import type { Brand } from 'wellcrafted/brand';
import { nullable } from '../document/nullable.js';
import { defineTable, defineWorkspace } from './definition.js';
import { historicalSchema } from './historical-schema.js';
import {
	defineRecordsMigration,
	defineRecordsMigrations,
	type RecordsMigrationSourceSnapshot,
	runRecordsMigration,
} from './records-migration.js';

type NoteId = string & Brand<'NoteId'>;
type FolderId = string & Brand<'FolderId'>;

const v1Definition = defineWorkspace({
	id: 'notes',
	tables: {
		notes: defineTable({
			fields: {
				id: field.string<NoteId>(),
				title: field.string(),
				legacyRank: field.number(),
				status: field.select(['open', 'done']),
				updatedAt: field.instant(),
				startsAt: field.datetime(),
				folderId: nullable(field.string<FolderId>()),
				payload: field.json(Type.Object({ value: Type.String() })),
			},
		}),
		drafts: defineTable({
			fields: { id: field.string(), body: field.string() },
		}),
	},
});

const recordsSchemaV1 = historicalSchema<{
	notes: {
		title: string;
		legacyRank: number;
		status: 'open' | 'done';
		updatedAt: InstantString;
		startsAt: DateTimeString;
		folderId: string | null;
		payload: unknown;
	};
	drafts: { body: string };
}>(v1Definition.recordsDescriptor);

const current = defineWorkspace({
	id: 'notes',
	tables: {
		notes: defineTable({
			fields: {
				id: field.string<NoteId>(),
				title: field.string(),
				status: field.select(['open', 'done']),
				updatedAt: field.instant(),
				startsAt: field.datetime(),
				folderId: nullable(field.string<FolderId>()),
				payload: field.json(Type.Object({ value: Type.String() })),
				archivedAt: nullable(field.instant()),
			},
		}),
		folders: defineTable({
			fields: { id: field.string<FolderId>(), name: field.string() },
		}),
	},
});

const valid = defineRecordsMigration({
	from: recordsSchemaV1,
	to: current,
	transform: {
		notes: ({ id, cells }) => {
			const sourceId: string = id;
			const status: 'open' | 'done' = cells.status;
			const instant: InstantString = cells.updatedAt;
			const datetime: DateTimeString = cells.startsAt;
			const folderId: string | null = cells.folderId;
			const payload: unknown = cells.payload;
			void sourceId;
			void status;
			void instant;
			void datetime;
			void folderId;
			void payload;
			return {
				title: cells.title,
				status: cells.status,
				updatedAt: cells.updatedAt,
				startsAt: cells.startsAt,
				folderId: cells.folderId,
				payload: cells.payload,
				archivedAt: null,
			};
		},
	},
	discard: ['drafts'],
});

defineRecordsMigration({
	from: recordsSchemaV1,
	to: current,
	transform: {
		notes: () => null,
	},
	discard: ['drafts'],
});

// @ts-expect-error — a type-visible changed table requires a transform
defineRecordsMigration({
	from: recordsSchemaV1,
	to: current,
	discard: ['drafts'],
});

defineRecordsMigration({
	from: recordsSchemaV1,
	to: current,
	transform: {
		// @ts-expect-error — target cells require archivedAt
		notes: ({ cells }) => ({
			title: cells.title,
			status: cells.status,
			updatedAt: cells.updatedAt,
			startsAt: cells.startsAt,
			folderId: cells.folderId,
			payload: cells.payload,
		}),
	},
	discard: ['drafts'],
});

defineRecordsMigration({
	from: recordsSchemaV1,
	to: current,
	transform: {
		// @ts-expect-error — legacyRank leaked through the source spread
		notes: ({ cells }) => ({ ...cells, archivedAt: null }),
	},
	discard: ['drafts'],
});

defineRecordsMigration({
	from: recordsSchemaV1,
	to: current,
	transform: {
		notes: ({ id, cells }) => ({
			// @ts-expect-error — transforms cannot author id
			id,
			title: cells.title,
			status: cells.status,
			updatedAt: cells.updatedAt,
			startsAt: cells.startsAt,
			folderId: cells.folderId,
			payload: cells.payload,
			archivedAt: null,
		}),
	},
	discard: ['drafts'],
});

defineRecordsMigration({
	from: recordsSchemaV1,
	to: current,
	transform: {
		// @ts-expect-error — arrays cannot split one source row
		notes: () => [],
	},
	discard: ['drafts'],
});

defineRecordsMigration({
	from: recordsSchemaV1,
	to: current,
	transform: {
		// @ts-expect-error — primitive callback output is malformed
		notes: () => 'invalid',
	},
	discard: ['drafts'],
});

defineRecordsMigration({
	from: recordsSchemaV1,
	to: current,
	transform: {
		// @ts-expect-error — target-only tables cannot be transformed
		folders: () => ({ name: 'Inbox' }),
		notes: () => null,
	},
	discard: ['drafts'],
});

defineRecordsMigration({
	from: recordsSchemaV1,
	to: current,
	transform: {
		// @ts-expect-error — unknown transform tables are rejected
		missing: () => ({}),
		notes: () => null,
	},
	discard: ['drafts'],
});

// @ts-expect-error — source-only tables require discard
defineRecordsMigration({
	from: recordsSchemaV1,
	to: current,
	transform: { notes: () => null },
});

defineRecordsMigration({
	from: recordsSchemaV1,
	to: current,
	transform: { notes: () => null },
	// @ts-expect-error — discard accepts only source-only tables
	discard: ['notes'],
});

defineRecordsMigration({
	from: recordsSchemaV1,
	to: current,
	transform: { notes: () => null },
	// @ts-expect-error — discard cannot contain duplicates
	discard: ['drafts', 'drafts'],
});

defineRecordsMigration({
	from: recordsSchemaV1,
	to: current,
	transform: {
		notes: () => null,
		// @ts-expect-error — source-only tables cannot also be transformed
		drafts: () => null,
	},
	discard: ['drafts'],
});

const additive = defineWorkspace({
	id: 'notes',
	tables: {
		notes: v1Definition.tables.notes,
		drafts: v1Definition.tables.drafts,
		folders: defineTable({
			fields: { id: field.string(), name: field.string() },
		}),
	},
});
defineRecordsMigration({ from: recordsSchemaV1, to: additive });

const intermediate = historicalSchema<{
	notes: {
		title: string;
		status: 'open' | 'done';
		updatedAt: InstantString;
		startsAt: DateTimeString;
		folderId: string | null;
		payload: unknown;
		archivedAt: InstantString | null;
	};
	folders: { name: string };
}>(current.recordsDescriptor);
const stepToHistory = defineRecordsMigration({
	from: recordsSchemaV1,
	to: intermediate,
	transform: {
		notes: ({ cells }) => ({
			title: cells.title,
			status: cells.status,
			updatedAt: cells.updatedAt,
			startsAt: cells.startsAt,
			folderId: cells.folderId,
			payload: cells.payload,
			archivedAt: null,
		}),
	},
	discard: ['drafts'],
});
const stepToCurrent = defineRecordsMigration({
	from: intermediate,
	to: current,
});
const mutableSteps: [typeof stepToHistory, typeof stepToCurrent] = [
	stepToHistory,
	stepToCurrent,
];
const chain = defineRecordsMigrations(mutableSteps);
const firstStep = chain[0];
const inferredFirst: typeof stepToHistory = firstStep;
// @ts-expect-error — validated chains are frozen readonly tuples
chain.reverse();

const sourceSnapshot: RecordsMigrationSourceSnapshot = {
	recordsSchemaHash: recordsSchemaV1.recordsSchemaHash,
	async *scan() {
		yield {
			kind: 'row' as const,
			table: 'notes',
			rowId: 'note-1',
			cells: { title: 'One' },
		};
	},
};
const migratedRows: AsyncIterable<{
	table: string;
	rowId: string;
	cells: Record<string, unknown>;
}> = runRecordsMigration({ migrations: chain, source: sourceSnapshot });

runRecordsMigration({
	migrations: chain,
	// @ts-expect-error — a source snapshot must expose a restartable async scan
	source: { recordsSchemaHash: recordsSchemaV1.recordsSchemaHash },
});

// @ts-expect-error — a historical endpoint cannot terminate a validated chain
defineRecordsMigrations([stepToHistory]);

void valid;
void firstStep;
void inferredFirst;
void migratedRows;
