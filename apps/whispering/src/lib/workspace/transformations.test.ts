/**
 * Transformation workspace declaration tests.
 *
 * Verifies the portable parent and step table contracts, including defaults,
 * discriminants, required fields, and the recording history transition.
 *
 * Key behaviors:
 * - New Transformation values default to disabled without provisioning a row
 * - Step kinds and scalar fields are validated at the declaration boundary
 * - Recording final text defaults to null beside the legacy fallback source
 */
import { describe, expect, test } from 'bun:test';
import { parseDatabase } from '@epicenter/database';
import { whisperingDatabase } from './index';

function tableOf(name: string) {
	const { data, error } = parseDatabase(whisperingDatabase);
	if (error !== null) throw error;
	const table = data.tables.get(name);
	if (table === undefined) throw new Error(`no table '${name}'`);
	return table;
}

describe('Transformation storage', () => {
	test('the declaration exposes portable parent and step tables', () => {
		expect(Object.keys(whisperingDatabase.tables)).toEqual([
			'recordings',
			'recipes',
			'transformations',
			'transformationSteps',
		]);
	});

	test('new values default inert without creating a Transformation row', () => {
		expect(tableOf('transformations').defaults).toEqual({
			description: '',
			enabled: false,
		});
		expect(tableOf('transformationSteps').defaults).toEqual({
			find: '',
			replace: '',
			useRegex: false,
		});
	});

	test('valid parent and step rows conform with defaults', () => {
		expect(
			tableOf('transformations').conformance({ name: 'URLs', position: 0 }),
		).toEqual({
			conforming: {
				name: 'URLs',
				description: '',
				enabled: false,
				position: 0,
			},
			issues: [],
		});
		expect(
			tableOf('transformationSteps').conformance({
				transformationId: 'transformation-1',
				position: 0,
				kind: 'spoken_urls',
			}),
		).toEqual({
			conforming: {
				transformationId: 'transformation-1',
				position: 0,
				kind: 'spoken_urls',
				find: '',
				replace: '',
				useRegex: false,
			},
			issues: [],
		});
	});

	test('invalid kinds, scalar types, and absent required fields are reported', () => {
		const parent = tableOf('transformations').conformance({
			description: '',
			enabled: 'yes',
			position: 'first',
		});
		expect(parent.conforming).toEqual({ description: '' });
		expect(parent.issues.map((issue) => issue.field)).toEqual([
			'name',
			'enabled',
			'position',
		]);

		const step = tableOf('transformationSteps').conformance({
			transformationId: 'transformation-1',
			position: 0,
			kind: 'prompt',
		});
		expect(step.conforming).toEqual({
			transformationId: 'transformation-1',
			position: 0,
			find: '',
			replace: '',
			useRegex: false,
		});
		expect(step.issues.map((issue) => issue.field)).toEqual(['kind']);
	});
});

describe('recording history storage', () => {
	test('delivered and legacy polished transcript fields both default to null', () => {
		const defaults = tableOf('recordings').defaults;
		expect(defaults.deliveredTranscript).toBeNull();
		expect(defaults.polishedTranscript).toBeNull();
	});
});
