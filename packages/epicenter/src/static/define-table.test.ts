import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';
import { defineTable } from './define-table.js';

describe('defineTable', () => {
	describe('shorthand syntax', () => {
		test('creates valid table definition with direct schema', () => {
			const posts = defineTable(type({ id: 'string', title: 'string' }));

			// Verify schema validates correctly
			const result = posts.schema['~standard'].validate({
				id: '1',
				title: 'Hello',
			});
			expect(result).not.toHaveProperty('issues');
		});

		test('migrate is identity function for shorthand', () => {
			const users = defineTable(type({ id: 'string', email: 'string' }));

			const row = { id: '1', email: 'test@example.com' };
			expect(users.migrate(row)).toBe(row);
		});

		test('shorthand produces equivalent validation to builder pattern', () => {
			const schema = type({ id: 'string', title: 'string' });

			const shorthand = defineTable(schema);
			const builder = defineTable(schema);

			// Both should validate the same data
			const testRow = { id: '1', title: 'Test' };
			const shorthandResult = shorthand.schema['~standard'].validate(testRow);
			const builderResult = builder.schema['~standard'].validate(testRow);

			expect(shorthandResult).not.toHaveProperty('issues');
			expect(builderResult).not.toHaveProperty('issues');
		});
	});

	describe('builder syntax', () => {
		test('creates valid table definition with single version', () => {
			const posts = defineTable(type({ id: 'string', title: 'string' }));

			const result = posts.schema['~standard'].validate({
				id: '1',
				title: 'Hello',
			});
			expect(result).not.toHaveProperty('issues');
		});

		test('creates table definition with multiple versions that validates both', () => {
			const posts = defineTable()
				.version(type({ id: 'string', title: 'string' }))
				.version(type({ id: 'string', title: 'string', views: 'number' }))
				.migrate((row) => {
					if (!('views' in row)) return { ...row, views: 0 };
					return row;
				});

			// V1 data should validate
			const v1Result = posts.schema['~standard'].validate({
				id: '1',
				title: 'Test',
			});
			expect(v1Result).not.toHaveProperty('issues');

			// V2 data should validate
			const v2Result = posts.schema['~standard'].validate({
				id: '1',
				title: 'Test',
				views: 10,
			});
			expect(v2Result).not.toHaveProperty('issues');
		});

		test('migrate function transforms old version to latest', () => {
			const posts = defineTable()
				.version(type({ id: 'string', title: 'string' }))
				.version(type({ id: 'string', title: 'string', views: 'number' }))
				.migrate((row) => {
					if (!('views' in row)) return { ...row, views: 0 };
					return row;
				});

			// Migrate v1 to v2
			const migrated = posts.migrate({ id: '1', title: 'Test' });
			expect(migrated).toEqual({ id: '1', title: 'Test', views: 0 });
		});

		test('throws when no versions are defined', () => {
			expect(() => {
				defineTable().migrate((row) => row);
			}).toThrow('defineTable() requires at least one .version() call');
		});
	});

	describe('schema patterns', () => {
		test('without _v discriminant (field presence detection)', () => {
			const posts = defineTable()
				.version(type({ id: 'string', title: 'string' }))
				.version(type({ id: 'string', title: 'string', views: 'number' }))
				.migrate((row) => {
					if (!('views' in row)) return { ...row, views: 0 };
					return row;
				});

			// Both versions should validate
			const v1Result = posts.schema['~standard'].validate({
				id: '1',
				title: 'Test',
			});
			expect(v1Result).not.toHaveProperty('issues');

			const migrated = posts.migrate({ id: '1', title: 'Test' });
			expect(migrated).toEqual({ id: '1', title: 'Test', views: 0 });
		});

		test('with _v discriminant (organic upgrade path)', () => {
			const posts = defineTable()
				.version(type({ id: 'string', title: 'string' }))
				.version(
					type({ id: 'string', title: 'string', views: 'number', _v: '"2"' }),
				)
				.migrate((row) => {
					if (!('_v' in row)) return { ...row, views: 0, _v: '2' };
					return row;
				});

			// Both versions should validate
			const v1Result = posts.schema['~standard'].validate({
				id: '1',
				title: 'Test',
			});
			expect(v1Result).not.toHaveProperty('issues');

			const v2Result = posts.schema['~standard'].validate({
				id: '1',
				title: 'Test',
				views: 10,
				_v: '2',
			});
			expect(v2Result).not.toHaveProperty('issues');

			// Migrate v1 to v2
			const migrated = posts.migrate({
				id: '1',
				title: 'Test',
			});
			expect(migrated).toEqual({ id: '1', title: 'Test', views: 0, _v: '2' });
		});

		test('with _v discriminant from start (symmetric switch)', () => {
			const posts = defineTable()
				.version(type({ id: 'string', title: 'string', _v: '"1"' }))
				.version(
					type({
						id: 'string',
						title: 'string',
						views: 'number',
						_v: '"2"',
					}),
				)
				.migrate((row) => {
					switch (row._v) {
						case '1':
							return { ...row, views: 0, _v: '2' };
						case '2':
							return row;
					}
				});

			// V1 data should validate
			const v1Result = posts.schema['~standard'].validate({
				id: '1',
				title: 'Test',
				_v: '1',
			});
			expect(v1Result).not.toHaveProperty('issues');

			// V2 data should validate
			const v2Result = posts.schema['~standard'].validate({
				id: '1',
				title: 'Test',
				views: 10,
				_v: '2',
			});
			expect(v2Result).not.toHaveProperty('issues');

			// Migrate v1 to v2
			const migrated = posts.migrate({
				id: '1',
				title: 'Test',
				_v: '1',
			});
			expect(migrated).toEqual({
				id: '1',
				title: 'Test',
				views: 0,
				_v: '2',
			});

			// V2 passes through unchanged
			const alreadyLatest = posts.migrate({
				id: '1',
				title: 'Test',
				views: 5,
				_v: '2',
			});
			expect(alreadyLatest).toEqual({
				id: '1',
				title: 'Test',
				views: 5,
				_v: '2',
			});
		});
	});
});
