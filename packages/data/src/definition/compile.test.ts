import { expect, test } from 'bun:test';
import { expectOk } from 'wellcrafted/testing';
import { compileData } from './compile.js';
import { plainText } from './content.js';
import { field } from './declaration.js';
import { defineData, defineTable } from './define.js';

const database = defineData({
	id: 'so.epicenter.data',
	kv: { name: field.string() },
	tables: {
		notes: defineTable({
			title: field.string(),
			content: plainText(),
		}),
	},
});

test('trusted TypeScript definitions compile and retain their codecs', () => {
	const result = expectOk(compileData(database));
	expect(result.tables.get('notes')?.content).toBeDefined();
	expect([...(result.tables.get('notes')?.fields.keys() ?? [])]).toEqual([
		'title',
	]);
});

test('compilation is memoized by definition identity', () => {
	expect(compileData(database)).toBe(compileData(database));
});
