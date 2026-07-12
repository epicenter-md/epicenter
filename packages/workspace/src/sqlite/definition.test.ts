/**
 * SQLite Workspace Definition Tests
 *
 * Verifies the greenfield persisted-schema boundary before any database opens.
 * The boundary accepts only the closed field vocabulary, compiles value checks,
 * validates table options and references, and derives the workspace storage
 * revision from its ordered migration manifest. Declared KV rides along as the
 * preference plane of the eager root document (ADR-0124): it is validated as a
 * plain record but contributes nothing to record schema identity.
 */

import { describe, expect, test } from 'bun:test';
import { field } from '@epicenter/field';
import { type TString, Type } from 'typebox';
import { Value } from 'typebox/value';
import { nullable } from '../document/nullable.js';
import { defineKv, defineTable, defineWorkspace } from './definition.js';

describe('defineTable', () => {
	test('compiles field storage, nullability, indexes, and closed document layouts', () => {
		const notes = defineTable(
			{
				id: field.string(),
				title: field.string({ minLength: 1 }),
				folderId: nullable(field.reference('folders')),
				pinned: field.boolean(),
			},
			{
				indexes: [['folderId', 'pinned']],
				docs: { body: 'richText' },
			},
		);

		expect(notes.compiledColumns.title.storage).toBe('TEXT');
		expect(notes.compiledColumns.title.check('hello')).toBe(true);
		expect(notes.compiledColumns.title.check('')).toBe(false);
		expect(notes.compiledColumns.folderId.isNullable).toBe(true);
		expect(notes.compiledColumns.folderId.referenceTable).toBe('folders');
		expect(notes.options.indexes).toEqual([['folderId', 'pinned']]);
		expect(notes.options.docs).toEqual({ body: 'richText' });
	});

	test('rejects raw TypeBox schemas and invalid table options', () => {
		expect(() =>
			defineTable({
				id: field.string(),
				raw: Type.Object({ x: Type.String() }),
			}),
		).toThrow("Persisted field 'raw' must use field.* or nullable(field.*)");
		expect(() =>
			defineTable(
				{ id: field.string(), title: field.string() },
				{ indexes: [['missing' as 'title']] },
			),
		).toThrow("unknown column 'missing'");
		expect(() =>
			defineTable(
				{ id: field.string(), body: field.string() },
				{ docs: { body: 'plainText' } },
			),
		).toThrow("document 'body' collides with a column");
		expect(() =>
			defineTable(
				{ id: field.string() },
				{ docs: { 'bad.name': 'plainText' } },
			),
		).toThrow('Invalid child document name');
		expect(() =>
			defineTable({ id: field.string(), constructor: field.string() }),
		).toThrow("table column 'constructor' collides with Object.prototype");
	});

	test('requires a non-null string id', () => {
		expect(() => defineTable({ id: field.number() })).toThrow(
			"column 'id' must be a non-null field.string()",
		);
		expect(() => defineTable({ id: nullable(field.string()) })).toThrow(
			"column 'id' must be a non-null field.string()",
		);
	});

	test('compiled checks reject non-JSON and non-finite values', () => {
		const nullablePayload = nullable(field.json(Type.Unknown()));
		const values = defineTable({
			id: field.string(),
			payload: nullablePayload,
			number: field.number(),
		});

		expect(values.compiledColumns.payload.check(new Date())).toBe(false);
		expect(values.compiledColumns.payload.check({ nested: ['ok', 1] })).toBe(
			true,
		);
		expect(values.compiledColumns.payload.check(null)).toBe(true);
		expect(values.compiledColumns.number.check(Number.NaN)).toBe(false);
		expect(values.compiledColumns.number.check(Number.POSITIVE_INFINITY)).toBe(
			false,
		);
	});

	test('rejects implicit null and undeclared row cells', () => {
		const implicitNull = field.json(Type.Unknown()) as unknown as TString;
		expect(() =>
			defineTable({ id: field.string(), payload: implicitNull }),
		).toThrow("field 'payload' admits null");

		const notes = defineTable({ id: field.string(), title: field.string() });
		expect(
			Value.Check(notes.schema, { id: 'note-1', title: 'Hi', extra: true }),
		).toBe(false);
	});
});

describe('defineKv', () => {
	test('carries the schema and a factory default', () => {
		const collapsed = defineKv(field.boolean(), () => false);
		expect(collapsed.schema).toEqual(field.boolean());
		expect(collapsed.defaultValue()).toBe(false);
	});

	test('accepts nullable KV: null is a real stored preference off the record wire', () => {
		const lastFolder = defineKv(nullable(field.string()), () => null);
		expect(lastFolder.defaultValue()).toBeNull();
		const workspace = defineWorkspace({
			id: 'nullable-kv',
			name: 'Nullable KV',
			epoch: 'nullable-kv-v1',
			tables: { rows: defineTable({ id: field.string() }) },
			kv: { lastFolder },
		});
		expect(workspace.kv.lastFolder).toBe(lastFolder);
	});
});

describe('defineWorkspace', () => {
	test('derives storage revision and validates reference targets', () => {
		const folders = defineTable({ id: field.string(), name: field.string() });
		const notes = defineTable({
			id: field.string(),
			folderId: nullable(field.reference('folders')),
		});
		const workspace = defineWorkspace({
			id: 'notes',
			name: 'Notes',
			epoch: 'notes-v1',
			tables: { folders, notes },
			migrations: [{ apply: () => undefined }, { epoch: { id: 'notes-v2' } }],
		});

		expect(workspace.storageRevision).toBe(3);
		expect(workspace.kv).toEqual({});
		expect(() =>
			defineWorkspace({
				id: 'broken',
				name: 'Broken',
				epoch: 'broken-v1',
				tables: {
					notes: defineTable({
						id: field.string(),
						folderId: field.reference('folders'),
					}),
				},
			}),
		).toThrow("references unknown table 'folders'");
	});

	test('schema identity is stable across declaration order and representation changes', () => {
		const first = defineWorkspace({
			id: 'notes',
			name: 'First display name',
			epoch: 'notes-v1',
			tables: {
				notes: defineTable(
					{ id: field.string(), title: field.string() },
					{
						indexes: [['title']],
						docs: { summary: 'plainText', body: 'richText' },
					},
				),
				folders: defineTable({ name: field.string(), id: field.string() }),
			},
			kv: {
				theme: defineKv(
					field.select(['light', 'dark']),
					() => 'light' as const,
				),
				collapsed: defineKv(field.boolean(), () => false),
			},
		});
		const reordered = defineWorkspace({
			id: 'notes',
			name: 'Different display name',
			epoch: 'notes-v1',
			tables: {
				folders: defineTable({ id: field.string(), name: field.string() }),
				notes: defineTable(
					{ title: field.string(), id: field.string() },
					{
						indexes: [],
						docs: { body: 'richText', summary: 'plainText' },
					},
				),
			},
			kv: {
				collapsed: defineKv(field.boolean(), () => false),
				theme: defineKv(
					field.select(['light', 'dark']),
					() => 'light' as const,
				),
			},
			migrations: [{ apply: () => undefined }],
		});

		expect(reordered.storageRevision).toBe(2);
		expect(reordered.schemaIdentity).toBe(first.schemaIdentity);
	});

	test('schema identity changes with logical schema, docs, epoch lineage, or workspace id', () => {
		type IdentityOptions = {
			workspaceId?: string;
			title?: ReturnType<typeof field.string>;
			doc?: 'plainText' | 'richText';
			epochId?: string;
		};
		function identity({
			workspaceId = 'notes',
			title = field.string(),
			doc = 'plainText' as const,
			epochId,
		}: IdentityOptions = {}) {
			return defineWorkspace({
				id: workspaceId,
				name: 'Notes',
				epoch: 'notes-v1',
				tables: {
					notes: defineTable(
						{ id: field.string(), title },
						{ docs: { body: doc } },
					),
				},
				migrations: epochId === undefined ? [] : [{ epoch: { id: epochId } }],
			}).schemaIdentity;
		}

		const baseline = identity();
		expect(identity({ title: field.string({ minLength: 1 }) })).not.toBe(
			baseline,
		);
		expect(identity({ doc: 'richText' })).not.toBe(baseline);
		expect(identity({ epochId: 'notes-v2' })).not.toBe(baseline);
		expect(identity({ workspaceId: 'other' })).not.toBe(baseline);
	});

	test('KV is not record schema identity: definitions differing only in kv share one identity', () => {
		function withKv(kv: Record<string, ReturnType<typeof defineKv>>) {
			return defineWorkspace({
				id: 'notes',
				name: 'Notes',
				epoch: 'notes-v1',
				tables: {
					notes: defineTable({ id: field.string(), title: field.string() }),
				},
				kv,
			}).schemaIdentity;
		}

		const withoutKv = withKv({});
		const withTheme = withKv({
			theme: defineKv(field.select(['light', 'dark']), () => 'light' as const),
		});
		const withChangedTheme = withKv({
			theme: defineKv(field.boolean(), () => false),
		});
		expect(withTheme).toBe(withoutKv);
		expect(withChangedTheme).toBe(withoutKv);
	});

	test('child document identity rejects unsafe workspace and table segments', () => {
		const documented = defineTable(
			{ id: field.string() },
			{ docs: { body: 'plainText' } },
		);
		expect(() =>
			defineWorkspace({
				id: 'Unsafe',
				name: 'Unsafe',
				epoch: 'unsafe-v1',
				tables: { notes: documented },
			}),
		).toThrow('Invalid workspace id');
		expect(() =>
			defineWorkspace({
				id: 'safe',
				name: 'Safe',
				epoch: 'safe-v1',
				tables: { 'bad.table': documented },
			}),
		).toThrow('Invalid child document table name');
	});

	test('rejects schema names that collide with record prototypes', () => {
		const rows = defineTable({ id: field.string() });
		expect(() =>
			defineWorkspace({
				id: 'rows',
				name: 'Rows',
				epoch: 'rows-v1',
				tables: { constructor: rows },
			}),
		).toThrow("workspace table 'constructor' collides with Object.prototype");
		expect(() =>
			defineWorkspace({
				id: 'rows',
				name: 'Rows',
				epoch: 'rows-v1',
				tables: { rows },
				kv: { toString: defineKv(field.string(), () => '') },
			}),
		).toThrow("workspace KV key 'toString' collides with Object.prototype");
		expect(() =>
			defineWorkspace({
				id: 'rows',
				name: 'Rows',
				epoch: 'rows-v1',
				tables: { rows, __proto__: rows },
			}),
		).toThrow('workspace tables must be a plain record');
		expect(() =>
			defineWorkspace({
				id: 'rows',
				name: 'Rows',
				epoch: 'rows-v1',
				tables: { rows, ['__proto__']: rows },
			}),
		).toThrow("workspace table '__proto__' collides with Object.prototype");
	});

	test('rejects inert migrations and duplicate epoch ids', () => {
		const rows = defineTable({ id: field.string() });
		expect(() =>
			defineWorkspace({
				id: 'rows',
				name: 'Rows',
				epoch: 'rows-v1',
				tables: { rows },
				migrations: [{}],
			}),
		).toThrow('migration 1 does no work');
		expect(() =>
			defineWorkspace({
				id: 'rows',
				name: 'Rows',
				epoch: 'rows-v1',
				tables: { rows },
				migrations: [{ epoch: { id: 'rows-v1' } }],
			}),
		).toThrow("epoch id 'rows-v1' is duplicated");
	});
});

test('defineTable refuses shapes the record wire cannot admit', () => {
	const oversizedColumns = Object.fromEntries([
		['id', field.string()],
		...Array.from({ length: 129 }, (_, index) => [
			`column${index}`,
			field.string(),
		]),
	]);
	expect(() =>
		defineTable(oversizedColumns as Parameters<typeof defineTable>[0]),
	).toThrow('cells per operation');
	expect(() =>
		defineTable({
			id: field.string(),
			['x'.repeat(513)]: field.string(),
		}),
	).toThrow('wire identifier ceiling');
});
