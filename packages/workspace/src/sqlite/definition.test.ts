/**
 * SQLite Workspace Definition Tests
 *
 * Verifies the terminal persisted-schema boundary before any database opens.
 * The boundary accepts only the closed field vocabulary, compiles value
 * checks, validates table options and references, derives the canonical
 * schema descriptor plus `recordsSchemaHash`, derives the stable `<id>.kv`
 * preference-document guid (ADR-0124). Declared KV is validated as a plain
 * record but contributes nothing to record schema identity. Definitions own
 * immutable snapshots of every mutable authoring record and schema.
 */

import { describe, expect, test } from 'bun:test';
import { field } from '@epicenter/field';
import { type TObject, type TString, Type } from 'typebox';
import { Value } from 'typebox/value';
import { nullable } from '../document/nullable.js';
import { sha256Hex } from '../shared/sha256.js';
import { defineKv, defineTable, defineWorkspace } from './definition.js';
import { document } from './document-format.js';
import { historicalSchema } from './historical-schema.js';
import { renderHistoricalSchemaModule } from './render-historical-schema.js';

describe('defineTable', () => {
	test('compiles fields and accepts closed document capabilities', () => {
		const notes = defineTable({
			fields: {
				id: field.string(),
				title: field.string({ minLength: 1 }),
				folderId: nullable(field.reference('folders')),
				pinned: field.boolean(),
			},
			documents: { body: document.xmlFragment },
		});

		expect(notes.compiledColumns.title.storage).toBe('TEXT');
		expect(notes.compiledColumns.title.check('hello')).toBe(true);
		expect(notes.compiledColumns.title.check('')).toBe(false);
		expect(notes.compiledColumns.folderId.isNullable).toBe(true);
		expect(notes.compiledColumns.folderId.referenceTable).toBe('folders');
		expect(notes.documents.body).toBe(document.xmlFragment);
	});

	test('keeps field and document names in separate namespaces', () => {
		const notes = defineTable({
			fields: { id: field.string(), body: field.string() },
			documents: { body: document.plainText },
		});

		expect(notes.compiledColumns.body.kind).toBe('string');
		expect(notes.documents.body).toBe(document.plainText);
	});

	test('rejects raw TypeBox schemas and invalid table options', () => {
		expect(() =>
			defineTable({
				fields: {
					id: field.string(),
					raw: Type.Object({ x: Type.String() }),
				},
			}),
		).toThrow("Persisted field 'raw' must use field.* or nullable(field.*)");
		expect(() =>
			defineTable({
				fields: { id: field.string() },
				documents: { 'bad.name': document.plainText },
			}),
		).toThrow('Invalid child document name');
		expect(() =>
			defineTable({
				fields: { id: field.string(), constructor: field.string() },
			}),
		).toThrow("table column 'constructor' collides with Object.prototype");
	});

	test('requires a non-null string id', () => {
		expect(() => defineTable({ fields: { id: field.number() } })).toThrow(
			"column 'id' must be a non-null field.string()",
		);
		expect(() =>
			defineTable({ fields: { id: nullable(field.string()) } }),
		).toThrow("column 'id' must be a non-null field.string()");
	});

	test('compiled checks reject non-JSON and non-finite values', () => {
		const nullablePayload = nullable(field.json(Type.Unknown()));
		const values = defineTable({
			fields: {
				id: field.string(),
				payload: nullablePayload,
				number: field.number(),
			},
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
			defineTable({ fields: { id: field.string(), payload: implicitNull } }),
		).toThrow("field 'payload' admits null");

		const notes = defineTable({
			fields: { id: field.string(), title: field.string() },
		});
		expect(
			Value.Check(notes.schema, { id: 'note-1', title: 'Hi', extra: true }),
		).toBe(false);
	});

	test('owns immutable field and document snapshots', () => {
		const title = field.string({ minLength: 2 });
		const fields = { id: field.string(), title };
		const documents = { body: document.plainText };
		const notes = defineTable({ fields, documents });
		const workspace = defineWorkspace({ id: 'notes', tables: { notes } });
		const descriptor = workspace.recordsDescriptor;
		const hash = workspace.recordsSchemaHash;

		Object.assign(title, { minLength: 100 });
		Object.assign(fields, { title: field.number() });
		Object.assign(documents, { body: document.xmlFragment });

		expect(notes.fields.title).not.toBe(title);
		expect(notes.compiledColumns.title.check('ok')).toBe(true);
		expect(notes.compiledColumns.title.check(42)).toBe(false);
		expect(Value.Check(notes.schema, { id: 'note-1', title: 'ok' })).toBe(true);
		expect(notes.documents.body).toBe(document.plainText);
		expect(workspace.recordsDescriptor).toBe(descriptor);
		expect(workspace.recordsSchemaHash).toBe(hash);
		expect(Object.isFrozen(notes)).toBe(true);
		expect(Object.isFrozen(notes.fields)).toBe(true);
		expect(Object.isFrozen(notes.fields.title)).toBe(true);
		expect(Object.isFrozen(notes.documents)).toBe(true);
		expect(Object.isFrozen(notes.compiledColumns)).toBe(true);
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
			tables: { rows: defineTable({ fields: { id: field.string() } }) },
			kv: { lastFolder },
		});
		expect(workspace.kv.lastFolder).toBe(lastFolder);
	});
});

describe('defineWorkspace', () => {
	test('derives the kv document guid, defaults the display name, and validates references', () => {
		const folders = defineTable({
			fields: { id: field.string(), name: field.string() },
		});
		const notes = defineTable({
			fields: {
				id: field.string(),
				folderId: nullable(field.reference('folders')),
			},
		});
		const workspace = defineWorkspace({
			id: 'notes',
			tables: { folders, notes },
		});

		expect(workspace.name).toBe('notes');
		expect(workspace.kvDocumentGuid).toBe('notes.kv');
		expect(workspace.kv).toEqual({});
		expect(
			defineWorkspace({
				id: 'notes',
				name: 'Notes',
				tables: { notes: folders },
			}).name,
		).toBe('Notes');
		expect(() =>
			defineWorkspace({
				id: 'broken',
				tables: {
					notes: defineTable({
						fields: {
							id: field.string(),
							folderId: field.reference('folders'),
						},
					}),
				},
			}),
		).toThrow("references unknown table 'folders'");
	});

	test('recordsSchemaHash is a labelled digest of the canonical descriptor bytes', () => {
		const workspace = defineWorkspace({
			id: 'notes',
			tables: {
				notes: defineTable({
					fields: { id: field.string(), title: field.string() },
				}),
			},
		});
		expect(workspace.recordsSchemaHash).toBe(
			`sha256:${sha256Hex(workspace.recordsDescriptor)}`,
		);
		const descriptor: unknown = JSON.parse(workspace.recordsDescriptor);
		expect(descriptor).toMatchObject({ format: 'epicenter.record-schema/1' });
	});

	test('recordsSchemaHash is stable across declaration order, display name, kv, and documents', () => {
		const first = defineWorkspace({
			id: 'notes',
			name: 'First display name',
			tables: {
				notes: defineTable({
					fields: {
						id: field.string(),
						title: field.string(),
						updatedAt: field.instant(),
					},
					documents: {
						summary: document.plainText,
						body: document.xmlFragment,
					},
				}),
				folders: defineTable({
					fields: { name: field.string(), id: field.string() },
				}),
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
			tables: {
				folders: defineTable({
					fields: { id: field.string(), name: field.string() },
				}),
				notes: defineTable({
					fields: {
						title: field.string(),
						updatedAt: field.instant(),
						id: field.string(),
					},
					documents: {
						body: document.xmlFragment,
						summary: document.plainText,
					},
				}),
			},
			kv: {},
		});

		expect(reordered.recordsSchemaHash).toBe(first.recordsSchemaHash);
		expect(reordered.recordsDescriptor).toBe(first.recordsDescriptor);
	});

	test('annotation edits are free: title, description, and default do not change recordsSchemaHash', () => {
		function hashWithTitle(title: string | undefined) {
			return defineWorkspace({
				id: 'notes',
				tables: {
					notes: defineTable({
						fields: {
							id: field.string(),
							status: field.select(['open', 'done'], {
								...(title === undefined ? {} : { title }),
								description: `described as ${title ?? 'nothing'}`,
							}),
						},
					}),
				},
			}).recordsSchemaHash;
		}
		expect(hashWithTitle('Status')).toBe(hashWithTitle(undefined));
		expect(hashWithTitle('Renamed label')).toBe(hashWithTitle(undefined));
	});

	test('field.json root annotations are stripped; nested annotations stay identity', () => {
		function hashWithPayload(payload: TObject) {
			return defineWorkspace({
				id: 'notes',
				tables: {
					notes: defineTable({
						fields: {
							id: field.string(),
							payload: field.json(payload),
						},
					}),
				},
			}).recordsSchemaHash;
		}

		// The payload spreads onto the column root, so a root default or title
		// is a stripped editor hint: no accepted value changes, no succession.
		const baseline = hashWithPayload(Type.Object({ level: Type.Number() }));
		expect(
			hashWithPayload(
				Type.Object({ level: Type.Number() }, { title: 'Payload' }),
			),
		).toBe(baseline);

		// A nested annotation survives (stated cost of non-recursive stripping),
		// and a nested structural change is identity as it must be.
		expect(
			hashWithPayload(
				Type.Object({ level: Type.Number({ description: 'depth' }) }),
			),
		).not.toBe(baseline);
		expect(hashWithPayload(Type.Object({ level: Type.String() }))).not.toBe(
			baseline,
		);
	});

	test('recordsSchemaHash changes with record fields, not documents or workspace id', () => {
		type IdentityOptions = {
			workspaceId?: string;
			title?: ReturnType<typeof field.string>;
			doc?: typeof document.plainText | typeof document.xmlFragment;
		};
		function identity({
			workspaceId = 'notes',
			title = field.string(),
			doc = document.plainText,
		}: IdentityOptions = {}) {
			return defineWorkspace({
				id: workspaceId,
				tables: {
					notes: defineTable({
						fields: { id: field.string(), title },
						documents: { body: doc },
					}),
				},
			}).recordsSchemaHash;
		}

		const baseline = identity();
		expect(identity({ title: field.string({ minLength: 1 }) })).not.toBe(
			baseline,
		);
		expect(identity({ doc: document.xmlFragment })).toBe(baseline);
		// Family routing owns workspace binding; two workspaces with one logical
		// schema share one hash by design.
		expect(identity({ workspaceId: 'other' })).toBe(baseline);
	});

	test('KV is not record schema identity: definitions differing only in kv share one hash', () => {
		function withKv(kv: Record<string, ReturnType<typeof defineKv>>) {
			return defineWorkspace({
				id: 'notes',
				tables: {
					notes: defineTable({
						fields: { id: field.string(), title: field.string() },
					}),
				},
				kv,
			}).recordsSchemaHash;
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

	test('document identity rejects unsafe workspace and table segments', () => {
		const documented = defineTable({
			fields: { id: field.string() },
			documents: { body: document.plainText },
		});
		expect(() =>
			defineWorkspace({
				id: 'Unsafe',
				tables: { notes: documented },
			}),
		).toThrow('Invalid workspace id');
		expect(() =>
			defineWorkspace({
				id: 'safe',
				tables: { 'bad.table': documented },
			}),
		).toThrow('Invalid child document table name');
	});

	test('rejects schema names that collide with record prototypes', () => {
		const rows = defineTable({ fields: { id: field.string() } });
		expect(() =>
			defineWorkspace({
				id: 'rows',
				tables: { constructor: rows },
			}),
		).toThrow("workspace table 'constructor' collides with Object.prototype");
		expect(() =>
			defineWorkspace({
				id: 'rows',
				tables: { rows },
				kv: { toString: defineKv(field.string(), () => '') },
			}),
		).toThrow("workspace KV key 'toString' collides with Object.prototype");
		expect(() =>
			defineWorkspace({
				id: 'rows',
				tables: { rows, __proto__: rows },
			}),
		).toThrow('workspace tables must be a plain record');
		expect(() =>
			defineWorkspace({
				id: 'rows',
				tables: { rows, ['__proto__']: rows },
			}),
		).toThrow("workspace table '__proto__' collides with Object.prototype");
	});

	test('owns immutable table and KV declaration maps', () => {
		const notes = defineTable({ fields: { id: field.string() } });
		const theme = defineKv(field.string(), () => 'light');
		const tables: Record<string, typeof notes> = { notes };
		const kv: Record<string, typeof theme> = { theme };
		const workspace = defineWorkspace({ id: 'notes', tables, kv });
		const descriptor = workspace.recordsDescriptor;
		const hash = workspace.recordsSchemaHash;

		tables.archive = notes;
		kv.locale = theme;
		delete tables.notes;
		delete kv.theme;

		expect(Object.keys(workspace.tables)).toEqual(['notes']);
		expect(Object.keys(workspace.kv)).toEqual(['theme']);
		expect(workspace.recordsDescriptor).toBe(descriptor);
		expect(workspace.recordsSchemaHash).toBe(hash);
		expect(Object.isFrozen(workspace)).toBe(true);
		expect(Object.isFrozen(workspace.tables)).toBe(true);
		expect(Object.isFrozen(workspace.kv)).toBe(true);
	});

	test('refuses table and KV lookalikes without factory provenance', () => {
		const notes = defineTable({ fields: { id: field.string() } });
		const theme = defineKv(field.string(), () => 'light');

		expect(() =>
			defineWorkspace({
				id: 'forged-table',
				tables: { notes: { ...notes } },
			}),
		).toThrow("Workspace table 'notes' must use defineTable()");
		expect(() =>
			defineWorkspace({
				id: 'forged-kv',
				tables: { notes },
				kv: { theme: { ...theme } },
			}),
		).toThrow("Workspace KV key 'theme' must use defineKv()");
	});
});

describe('renderHistoricalSchemaModule', () => {
	test('emits an inert module whose literals round-trip through historicalSchema', () => {
		const definition = defineWorkspace({
			id: 'notes',
			tables: {
				notes: defineTable({
					fields: {
						id: field.string(),
						title: field.string(),
						status: field.select(['open', 'done']),
						updatedAt: field.instant(),
						payload: nullable(field.json(Type.Unknown())),
					},
					documents: { body: document.xmlFragment },
				}),
			},
		});

		const moduleText = renderHistoricalSchemaModule({
			definition,
			exportName: 'recordsSchemaV1',
		});
		expect(moduleText).toContain(JSON.stringify(definition.recordsDescriptor));
		expect(moduleText).not.toContain('recordsSchemaHash:');
		expect(moduleText).toContain('"open" | "done"');
		expect(moduleText).toContain('updatedAt: InstantString;');
		expect(moduleText).toContain('payload: unknown | null;');
		expect(moduleText).not.toContain('id:');
		expect(moduleText).not.toContain('defineTable');

		expect(() =>
			renderHistoricalSchemaModule({ definition, exportName: 'bad name' }),
		).toThrow('is not a valid identifier');
	});

	test('historical schema derives its hash from its sole descriptor', () => {
		const descriptor = '{"format":"epicenter.record-schema/1","tables":[]}';
		const historical = historicalSchema(descriptor);
		expect(historical.recordsDescriptor).toBe(descriptor);
		expect(historical.recordsSchemaHash).toBe(
			`sha256:${sha256Hex(descriptor)}`,
		);
	});

	test('historical schema refuses malformed and noncanonical descriptor strings', () => {
		expect(() => historicalSchema('not json')).toThrow('not valid JSON');
		expect(() =>
			historicalSchema(
				'{ "format": "epicenter.record-schema/1", "tables": [] }',
			),
		).toThrow('not in canonical form');
		expect(() =>
			historicalSchema(
				'{"format":"epicenter.record-schema/1","tables":[{"fields":[],"name":"notes"},{"fields":[],"name":"notes"}]}',
			),
		).toThrow('malformed table');
	});

	test('generated descriptors are byte-stable for one logical schema', () => {
		const render = (name: string) =>
			renderHistoricalSchemaModule({
				definition: defineWorkspace({
					id: 'notes',
					name,
					tables: {
						notes: defineTable({
							fields: { id: field.string(), title: field.string() },
						}),
					},
				}),
				exportName: 'recordsSchemaV1',
			});
		expect(render('One label')).toBe(render('Another label'));
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
		defineTable({ fields: oversizedColumns } as Parameters<
			typeof defineTable
		>[0]),
	).toThrow('cells per operation');
	expect(() =>
		defineTable({
			fields: {
				id: field.string(),
				['x'.repeat(513)]: field.string(),
			},
		}),
	).toThrow('wire identifier ceiling');
});
