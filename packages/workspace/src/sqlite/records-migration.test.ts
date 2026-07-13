/**
 * Records Migration Definition Tests
 *
 * Verifies module-load validation for canonical endpoint descriptors, total
 * source-table disposition, and non-empty linear chains ending at a current
 * workspace definition. No test executes a row transform.
 *
 * Key behaviors:
 * - Individual steps must change the records schema hash
 * - Canonically identical tables copy by omission; changed tables do not
 * - Source-only tables require exact discard coverage
 * - Definitions own sealed endpoint identity and immutable authored collections
 * - Chains reject gaps, cycles, and historical terminals
 */

import { expect, test } from 'bun:test';
import { field } from '@epicenter/field';
import { defineTable, defineWorkspace } from './definition.js';
import { historicalSchema } from './historical-schema.js';
import {
	defineRecordsMigration,
	defineRecordsMigrations,
} from './records-migration.js';
import { recordsSchemaRef } from './schema-descriptor.js';

function workspaceWithTitleConstraint(minLength?: number) {
	return defineWorkspace({
		id: 'notes',
		tables: {
			notes: defineTable({
				fields: {
					id: field.string(),
					title: field.string(minLength === undefined ? {} : { minLength }),
				},
			}),
		},
	});
}

function history<TRows extends Record<string, Record<string, unknown>>>(
	definition: ReturnType<typeof workspaceWithTitleConstraint>,
) {
	return historicalSchema<TRows>(definition.recordsDescriptor);
}

function defineRuntimeStep(value: unknown) {
	return defineRecordsMigration(value as never);
}

function defineRuntimeChain(value: unknown) {
	return defineRecordsMigrations(value as never);
}

test('identical tables copy by omission within a schema-changing step', () => {
	const before = workspaceWithTitleConstraint(1);
	const source = history<{ notes: { title: string } }>(before);
	const current = defineWorkspace({
		id: 'notes',
		tables: {
			...before.tables,
			folders: defineTable({
				fields: { id: field.string(), name: field.string() },
			}),
		},
	});
	const step = defineRecordsMigration({ from: source, to: current });

	expect(step.from.recordsSchemaHash).not.toBe(current.recordsSchemaHash);
	expect(step.transform).toEqual({});
	expect(step.discard).toEqual([]);
});

test('individual steps reject equal source and target schema hashes', () => {
	const current = workspaceWithTitleConstraint();
	const source = history<{ notes: { title: string } }>(current);

	expect(() => defineRecordsMigration({ from: source, to: current })).toThrow(
		'Records migration must change the records schema hash',
	);
});

test('constraint-only table changes require a transform at module load', () => {
	const before = workspaceWithTitleConstraint(1);
	const after = workspaceWithTitleConstraint(2);
	const source = history<{ notes: { title: string } }>(before);

	expect(() => defineRecordsMigration({ from: source, to: after })).toThrow(
		"table 'notes' changed canonically and requires a transform",
	);
	expect(() =>
		defineRecordsMigration({
			from: source,
			to: after,
			transform: { notes: ({ cells }) => cells },
		}),
	).not.toThrow();
});

test('canonically identical tables refuse authored transforms', () => {
	const before = workspaceWithTitleConstraint();
	const source = history<{ notes: { title: string } }>(before);
	const current = defineWorkspace({
		id: 'notes',
		tables: {
			...before.tables,
			folders: defineTable({
				fields: { id: field.string(), name: field.string() },
			}),
		},
	});

	expect(() =>
		defineRuntimeStep({
			from: source,
			to: current,
			transform: { notes: ({ cells }: { cells: unknown }) => cells },
		}),
	).toThrow("table 'notes' is canonically identical and copies automatically");
});

test('source-only tables require exact discard and target-only tables begin empty', () => {
	const sourceDefinition = defineWorkspace({
		id: 'notes',
		tables: {
			notes: defineTable({
				fields: { id: field.string(), title: field.string() },
			}),
			drafts: defineTable({
				fields: { id: field.string(), body: field.string() },
			}),
		},
	});
	const source = historicalSchema<{
		notes: { title: string };
		drafts: { body: string };
	}>(sourceDefinition.recordsDescriptor);
	const target = defineWorkspace({
		id: 'notes',
		tables: {
			notes: defineTable({
				fields: { id: field.string(), title: field.string() },
			}),
			folders: defineTable({
				fields: { id: field.string(), name: field.string() },
			}),
		},
	});

	expect(() => defineRuntimeStep({ from: source, to: target })).toThrow(
		"source-only table 'drafts' must be explicitly discarded",
	);
	expect(() =>
		defineRecordsMigration({ from: source, to: target, discard: ['drafts'] }),
	).not.toThrow();
	expect(() =>
		defineRuntimeStep({
			from: source,
			to: target,
			discard: ['drafts', 'drafts'],
		}),
	).toThrow("discard contains duplicate table 'drafts'");
	expect(() =>
		defineRuntimeStep({ from: source, to: target, discard: ['notes'] }),
	).toThrow("discard table 'notes' is not source-only");
	expect(() =>
		defineRuntimeStep({
			from: source,
			to: target,
			transform: { drafts: () => ({ body: 'moved' }) },
			discard: ['drafts'],
		}),
	).toThrow("table 'drafts' cannot be both transformed and discarded");
	expect(() =>
		defineRuntimeStep({
			from: source,
			to: target,
			transform: { folders: () => ({ name: 'Inbox' }) },
			discard: ['drafts'],
		}),
	).toThrow("transform table 'folders' exists only in the target");
});

test('entirely additive step requires no transform or discard', () => {
	const before = workspaceWithTitleConstraint();
	const source = history<{ notes: { title: string } }>(before);
	const after = defineWorkspace({
		id: 'notes',
		tables: {
			...before.tables,
			folders: defineTable({
				fields: { id: field.string(), name: field.string() },
			}),
		},
	});

	expect(() =>
		defineRecordsMigration({ from: source, to: after }),
	).not.toThrow();
});

test('dynamic transforms reject invalid keys and values', () => {
	const before = workspaceWithTitleConstraint();
	const source = history<{ notes: { title: string } }>(before);
	const current = defineWorkspace({
		id: 'notes',
		tables: {
			...before.tables,
			folders: defineTable({
				fields: { id: field.string(), name: field.string() },
			}),
		},
	});

	expect(() =>
		defineRuntimeStep({
			from: source,
			to: current,
			transform: { missing: () => ({}) },
		}),
	).toThrow("transform references unknown table 'missing'");
	expect(() =>
		defineRuntimeStep({
			from: source,
			to: current,
			transform: { notes: 'not a function' },
		}),
	).toThrow("transform for table 'notes' must be a function");
	expect(() =>
		defineRuntimeStep({ from: source, to: current, transform: null }),
	).toThrow('transform must be a plain record');
	expect(() =>
		defineRuntimeStep({ from: source, to: current, discard: null }),
	).toThrow('discard must be an array of table names');
});

test('malformed, noncanonical, and hash-mismatched endpoints fail before disposition', () => {
	const current = workspaceWithTitleConstraint();
	const source = history<{ notes: { title: string } }>(current);
	const malformed = {
		...source,
		recordsDescriptor: 'not json',
	};
	const noncanonical = {
		...source,
		recordsDescriptor:
			'{ "format": "epicenter.record-schema/1", "tables": [] }',
	};
	const mismatched = { ...source, recordsSchemaHash: 'sha256:wrong' };
	const targetMismatched = {
		...current,
		recordsSchemaHash: 'sha256:wrong',
	};

	expect(() => defineRuntimeStep({ from: malformed, to: current })).toThrow(
		'source descriptor is not valid JSON',
	);
	expect(() => defineRuntimeStep({ from: source, to: noncanonical })).toThrow(
		'target descriptor is not in canonical form',
	);
	expect(() => defineRuntimeStep({ from: mismatched, to: current })).toThrow(
		'source hash does not match its descriptor',
	);
	expect(() =>
		defineRuntimeStep({ from: source, to: targetMismatched }),
	).toThrow('target hash does not match its descriptor');
});

test('valid adjacent chain ends at current workspace and freezes owned state', () => {
	const v1Definition = workspaceWithTitleConstraint();
	const v2Definition = defineWorkspace({
		id: 'notes',
		tables: {
			notes: defineTable({
				fields: {
					id: field.string(),
					title: field.string(),
					archived: field.boolean(),
				},
			}),
		},
	});
	const current = defineWorkspace({
		id: 'notes',
		tables: {
			notes: defineTable({
				fields: {
					id: field.string(),
					title: field.string(),
					archived: field.boolean(),
					pinned: field.boolean(),
				},
			}),
		},
	});
	const v1 = historicalSchema<{ notes: { title: string } }>(
		v1Definition.recordsDescriptor,
	);
	const v2 = historicalSchema<{
		notes: { title: string; archived: boolean };
	}>(v2Definition.recordsDescriptor);
	const originalTransform = ({ cells }: { cells: { title: string } }) => ({
		...cells,
		archived: false,
	});
	const authoredTransform = { notes: originalTransform };
	const step1 = defineRecordsMigration({
		from: v1,
		to: v2,
		transform: authoredTransform,
	});
	const step2 = defineRecordsMigration({
		from: v2,
		to: current,
		transform: {
			notes: ({ cells }) => ({ ...cells, pinned: false }),
		},
	});
	const authoredSteps: [typeof step1, typeof step2] = [step1, step2];
	const chain = defineRecordsMigrations(authoredSteps);
	authoredTransform.notes = () => ({ title: 'mutated', archived: true });
	authoredSteps.reverse();

	expect([...chain]).toEqual([step1, step2]);
	expect(step1.transform.notes).toBe(originalTransform);
	expect(Object.isFrozen(step1)).toBe(true);
	expect(Object.isFrozen(step1.transform)).toBe(true);
	expect(Object.isFrozen(chain)).toBe(true);
});

test('defined migrations seal the exact endpoint identities they validate', () => {
	const before = workspaceWithTitleConstraint(1);
	const current = workspaceWithTitleConstraint(2);
	const source = history<{ notes: { title: string } }>(before);
	const step = defineRecordsMigration({
		from: source,
		to: current,
		transform: { notes: ({ cells }) => cells },
	});
	const sourceDescriptor = source.recordsDescriptor;
	const sourceHash = source.recordsSchemaHash;
	const targetDescriptor = current.recordsDescriptor;
	const targetHash = current.recordsSchemaHash;

	expect(step.from).toBe(source);
	expect(step.to).toBe(current);
	expect(Reflect.set(source, 'recordsDescriptor', targetDescriptor)).toBe(
		false,
	);
	expect(Reflect.set(source, 'recordsSchemaHash', targetHash)).toBe(false);
	expect(Reflect.set(source[recordsSchemaRef], 'kind', 'current')).toBe(false);
	expect(Reflect.set(source, recordsSchemaRef, { kind: 'current' })).toBe(
		false,
	);
	expect(Reflect.set(current, 'recordsDescriptor', sourceDescriptor)).toBe(
		false,
	);
	expect(Reflect.set(current, 'recordsSchemaHash', sourceHash)).toBe(false);
	expect(Reflect.set(current[recordsSchemaRef], 'kind', 'historical')).toBe(
		false,
	);
	expect(Reflect.set(current, recordsSchemaRef, { kind: 'historical' })).toBe(
		false,
	);

	expect(source.recordsDescriptor).toBe(sourceDescriptor);
	expect(source.recordsSchemaHash).toBe(sourceHash);
	expect(source[recordsSchemaRef].kind).toBe('historical');
	expect(current.recordsDescriptor).toBe(targetDescriptor);
	expect(current.recordsSchemaHash).toBe(targetHash);
	expect(current[recordsSchemaRef].kind).toBe('current');
	expect(() => defineRecordsMigrations([step])).not.toThrow();
});

test('chains reject gaps, wrong order, cycles, and historical terminals', () => {
	const aDefinition = workspaceWithTitleConstraint();
	const bDefinition = workspaceWithTitleConstraint(1);
	const current = workspaceWithTitleConstraint(2);
	const a = history<{ notes: { title: string } }>(aDefinition);
	const b = history<{ notes: { title: string } }>(bDefinition);
	const historicalCurrent = history<{ notes: { title: string } }>(current);
	const ab = defineRecordsMigration({
		from: a,
		to: b,
		transform: { notes: ({ cells }) => cells },
	});
	const bCurrent = defineRecordsMigration({
		from: b,
		to: current,
		transform: { notes: ({ cells }) => cells },
	});
	const aCurrent = defineRecordsMigration({
		from: a,
		to: current,
		transform: { notes: ({ cells }) => cells },
	});
	const aToCurrentB = defineRecordsMigration({
		from: a,
		to: bDefinition,
		transform: { notes: ({ cells }) => cells },
	});
	const currentBToHistoricalCurrent = defineRecordsMigration({
		from: bDefinition,
		to: historicalCurrent,
		transform: { notes: ({ cells }) => cells },
	});
	const ba = defineRecordsMigration({
		from: b,
		to: a,
		transform: { notes: ({ cells }) => cells },
	});
	const duplicateAb = defineRecordsMigration({
		from: a,
		to: b,
		transform: { notes: ({ cells }) => cells },
	});
	const bHistoricalCurrent = defineRecordsMigration({
		from: b,
		to: historicalCurrent,
		transform: { notes: ({ cells }) => cells },
	});

	expect(() => defineRuntimeChain([])).toThrow(
		'must contain at least one step',
	);
	expect(() => defineRuntimeChain([null])).toThrow(
		'was not created by defineRecordsMigration',
	);
	expect(() => defineRuntimeChain([ab, aCurrent])).toThrow('discontinuous');
	expect(() => defineRuntimeChain([ab, ba])).toThrow('repeats schema hash');
	expect(() => defineRuntimeChain([ab, duplicateAb])).toThrow('duplicate step');
	expect(() => defineRuntimeChain([ab, bHistoricalCurrent])).toThrow(
		'must terminate at a current workspace definition',
	);
	expect(() => defineRuntimeChain([aToCurrentB, bCurrent])).toThrow(
		'targets a current workspace definition before the terminal step',
	);
	expect(() => defineRuntimeChain([currentBToHistoricalCurrent])).toThrow(
		'starts from a current workspace definition',
	);
});

test('terminal current identity is nominal rather than a descriptor duck type', () => {
	const current = workspaceWithTitleConstraint(2);
	const sourceDefinition = workspaceWithTitleConstraint(1);
	const source = history<{ notes: { title: string } }>(sourceDefinition);
	const fakeCurrent = {
		...current,
		[recordsSchemaRef]: { kind: 'historical' as const },
	};
	const step = defineRuntimeStep({
		from: source,
		to: fakeCurrent,
		transform: { notes: ({ cells }: { cells: { title: string } }) => cells },
	});

	expect(() => defineRuntimeChain([step])).toThrow(
		'must terminate at a current workspace definition',
	);
});
