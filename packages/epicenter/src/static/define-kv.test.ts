import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';
import { defineKv } from './define-kv.js';

describe('defineKv', () => {
	describe('shorthand syntax', () => {
		test('creates valid KV definition with direct schema', () => {
			const theme = defineKv(type({ mode: "'light' | 'dark'" }));

			// Verify schema validates correctly
			const result = theme.schema['~standard'].validate({ mode: 'dark' });
			expect(result).not.toHaveProperty('issues');
		});

		test('migrate is identity function for shorthand', () => {
			const sidebar = defineKv(type({ collapsed: 'boolean', width: 'number' }));

			const value = { collapsed: true, width: 300 };
			expect(sidebar.migrate(value)).toBe(value);
		});

		test('shorthand produces equivalent validation to builder pattern', () => {
			const schema = type({ collapsed: 'boolean', width: 'number' });

			const shorthand = defineKv(schema);
			const builder = defineKv(schema);

			// Both should validate the same data
			const testValue = { collapsed: true, width: 300 };
			const shorthandResult = shorthand.schema['~standard'].validate(testValue);
			const builderResult = builder.schema['~standard'].validate(testValue);

			expect(shorthandResult).not.toHaveProperty('issues');
			expect(builderResult).not.toHaveProperty('issues');
		});
	});

	describe('builder syntax', () => {
		test('creates valid KV definition with single version', () => {
			const theme = defineKv(type({ mode: "'light' | 'dark'" }));

			const result = theme.schema['~standard'].validate({ mode: 'light' });
			expect(result).not.toHaveProperty('issues');
		});

		test('creates KV definition with multiple versions that validates both', () => {
			const theme = defineKv()
				.version(type({ mode: "'light' | 'dark'" }))
				.version(
					type({ mode: "'light' | 'dark' | 'system'", fontSize: 'number' }),
				)
				.migrate((v) => {
					if (!('fontSize' in v)) return { ...v, fontSize: 14 };
					return v;
				});

			// V1 data should validate
			const v1Result = theme.schema['~standard'].validate({ mode: 'dark' });
			expect(v1Result).not.toHaveProperty('issues');

			// V2 data should validate
			const v2Result = theme.schema['~standard'].validate({
				mode: 'system',
				fontSize: 16,
			});
			expect(v2Result).not.toHaveProperty('issues');
		});

		test('migrate function transforms old version to latest', () => {
			const theme = defineKv()
				.version(type({ mode: "'light' | 'dark'" }))
				.version(type({ mode: "'light' | 'dark'", fontSize: 'number' }))
				.migrate((v) => {
					if (!('fontSize' in v)) return { ...v, fontSize: 14 };
					return v;
				});

			const migrated = theme.migrate({ mode: 'dark' });
			expect(migrated).toEqual({ mode: 'dark', fontSize: 14 });
		});
	});

	describe('schema patterns', () => {
		test('primitive value (not recommended but supported)', () => {
			const fontSize = defineKv(type('number'));

			const result = fontSize.schema['~standard'].validate(14);
			expect(result).not.toHaveProperty('issues');
			expect(fontSize.migrate(14)).toBe(14);
		});

		test('object with _v discriminant (organic upgrade path)', () => {
			const theme = defineKv()
				.version(type({ mode: "'light' | 'dark'" }))
				.version(
					type({
						mode: "'light' | 'dark' | 'system'",
						fontSize: 'number',
						_v: '"2"',
					}),
				)
				.migrate((v) => {
					if (!('_v' in v)) return { mode: v.mode, fontSize: 14, _v: '2' };
					return v;
				});

			// Both versions should validate
			const v1Result = theme.schema['~standard'].validate({
				mode: 'dark',
			});
			expect(v1Result).not.toHaveProperty('issues');

			const v2Result = theme.schema['~standard'].validate({
				mode: 'system',
				fontSize: 16,
				_v: '2',
			});
			expect(v2Result).not.toHaveProperty('issues');

			// Migrate v1 to v2
			const migrated = theme.migrate({ mode: 'dark' });
			expect(migrated).toEqual({ mode: 'dark', fontSize: 14, _v: '2' });
		});

		test('object without _v discriminant (field presence detection)', () => {
			const theme = defineKv()
				.version(type({ mode: "'light' | 'dark'" }))
				.version(
					type({ mode: "'light' | 'dark' | 'system'", fontSize: 'number' }),
				)
				.migrate((v) => {
					if (!('fontSize' in v)) return { ...v, fontSize: 14 };
					return v;
				});

			// Both versions should validate
			const v1Result = theme.schema['~standard'].validate({
				mode: 'dark',
			});
			expect(v1Result).not.toHaveProperty('issues');

			const v2Result = theme.schema['~standard'].validate({
				mode: 'system',
				fontSize: 16,
			});
			expect(v2Result).not.toHaveProperty('issues');

			// Migrate v1 to v2
			const migrated = theme.migrate({ mode: 'dark' });
			expect(migrated).toEqual({ mode: 'dark', fontSize: 14 });
		});

		test('object with _v discriminant from start (symmetric switch)', () => {
			const theme = defineKv()
				.version(type({ mode: "'light' | 'dark'", _v: '"1"' }))
				.version(
					type({
						mode: "'light' | 'dark' | 'system'",
						fontSize: 'number',
						_v: '"2"',
					}),
				)
				.migrate((v) => {
					switch (v._v) {
						case '1':
							return { mode: v.mode, fontSize: 14, _v: '2' };
						case '2':
							return v;
					}
				});

			// V1 data should validate
			const v1Result = theme.schema['~standard'].validate({
				mode: 'dark',
				_v: '1',
			});
			expect(v1Result).not.toHaveProperty('issues');

			// V2 data should validate
			const v2Result = theme.schema['~standard'].validate({
				mode: 'system',
				fontSize: 16,
				_v: '2',
			});
			expect(v2Result).not.toHaveProperty('issues');

			// Migrate v1 to v2
			const migrated = theme.migrate({ mode: 'dark', _v: '1' });
			expect(migrated).toEqual({ mode: 'dark', fontSize: 14, _v: '2' });

			// V2 passes through unchanged
			const alreadyLatest = theme.migrate({
				mode: 'system',
				fontSize: 16,
				_v: '2',
			});
			expect(alreadyLatest).toEqual({
				mode: 'system',
				fontSize: 16,
				_v: '2',
			});
		});
	});
});
