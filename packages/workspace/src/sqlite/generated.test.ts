/**
 * Generated Historical Schema Boundary Tests
 *
 * Verifies that generated modules have one explicit constructor subpath while
 * the ordinary application barrel exposes only declarative migration APIs.
 *
 * Key behaviors:
 * - Historical endpoints are complete immutable values
 * - Generated modules import the explicit generated-artifact constructor subpath
 * - The application barrel excludes replacement execution plumbing
 */

import { describe, expect, test } from 'bun:test';
import { field } from '@epicenter/field';
import { historicalSchema } from '@epicenter/workspace/sqlite/generated';
import * as sqlite from './index.js';

const EMPTY_DESCRIPTOR = '{"format":"epicenter.record-schema/1","tables":[]}';

describe('generated historical schema boundary', () => {
	test('historicalSchema returns a fully frozen endpoint', () => {
		const endpoint = historicalSchema(EMPTY_DESCRIPTOR);

		expect(Object.isFrozen(endpoint)).toBe(true);
		expect(() => Object.assign(endpoint, { extra: true })).toThrow();
	});

	test('renderer imports historicalSchema from the generated-artifact subpath', () => {
		const definition = sqlite.defineWorkspace({
			id: 'notes',
			tables: {
				notes: sqlite.defineTable({
					fields: { id: field.string(), title: field.string() },
				}),
			},
		});

		const moduleText = sqlite.renderHistoricalSchemaModule({
			definition,
			exportName: 'recordsSchemaV1',
		});
		expect(moduleText).toContain(
			"import { historicalSchema } from '@epicenter/workspace/sqlite/generated';",
		);
		expect(moduleText).not.toContain(
			"import { historicalSchema } from '@epicenter/workspace/sqlite';",
		);
	});

	test('application barrel excludes replacement execution plumbing', () => {
		expect(Object.hasOwn(sqlite, 'historicalSchema')).toBe(false);
		expect(Object.hasOwn(sqlite, 'runRecordsMigration')).toBe(false);
		expect(Object.hasOwn(sqlite, 'RecordsMigrationSourceBlockedError')).toBe(
			false,
		);
		expect(Object.hasOwn(sqlite, 'RecordsMigrationTargetValidationError')).toBe(
			false,
		);
		expect(typeof sqlite.defineRecordsMigration).toBe('function');
		expect(typeof sqlite.defineRecordsMigrations).toBe('function');
	});
});
