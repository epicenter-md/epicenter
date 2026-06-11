/**
 * Naming Tests
 *
 * Covers filename validation, duplicate-name checks, and deterministic disambiguation rules.
 * These tests guard filesystem naming constraints that are shared across tree and index operations.
 *
 * Key behaviors:
 * - Invalid path-like names are rejected with filesystem-style errors.
 * - Duplicate names are disambiguated in stable creation order.
 */

import { describe, expect, test } from 'bun:test';
import { createWorkspace } from '@epicenter/workspace';
import { asFileId } from '../ids.js';
import { filesTable } from '../table.js';
import { assertUniqueName, disambiguateNames, validateName } from './naming.js';

const fid = (s: string) => asFileId(s);

function setup() {
	const workspace = createWorkspace({
		id: 'test',
		tables: { files: filesTable },
		kv: {},
	});
	return { files: workspace.tables.files };
}

function makeRow(
	id: string,
	name: string,
	parentId: string | null = null,
	createdAt = Date.now(),
) {
	return {
		id: fid(id),
		name,
		parentId: parentId === null ? null : fid(parentId),
		type: 'file' as const,
		size: 0,
		createdAt,
		updatedAt: createdAt,
		trashedAt: null,
	};
}

describe('validateName', () => {
	test('accepts normal filenames', () => {
		expect(() => validateName('hello.txt')).not.toThrow();
		expect(() => validateName('My File (1).md')).not.toThrow();
		expect(() => validateName('.gitignore')).not.toThrow();
		expect(() => validateName('Makefile')).not.toThrow();
		expect(() => validateName('archive.tar.gz')).not.toThrow();
	});

	test('rejects forward slash', () => {
		expect(() => validateName('foo/bar')).toThrow('EINVAL');
	});

	test('rejects backslash', () => {
		expect(() => validateName('foo\\bar')).toThrow('EINVAL');
	});

	test('rejects null byte', () => {
		expect(() => validateName('foo\0bar')).toThrow('EINVAL');
	});

	test('rejects empty string', () => {
		expect(() => validateName('')).toThrow('EINVAL');
	});

	test('rejects dot', () => {
		expect(() => validateName('.')).toThrow('EINVAL');
	});

	test('rejects double dot', () => {
		expect(() => validateName('..')).toThrow('EINVAL');
	});
});

describe('assertUniqueName', () => {
	test('allows unique name', () => {
		const { files } = setup();
		files.set(makeRow('a', 'hello.txt'));

		expect(() =>
			assertUniqueName(files, [fid('a')], 'world.txt'),
		).not.toThrow();
	});

	test('throws EEXIST on duplicate', () => {
		const { files } = setup();
		files.set(makeRow('a', 'hello.txt'));

		expect(() => assertUniqueName(files, [fid('a')], 'hello.txt')).toThrow(
			'EEXIST',
		);
	});

	test('ignores trashed files', () => {
		const { files } = setup();
		files.set({ ...makeRow('a', 'hello.txt'), trashedAt: Date.now() });

		expect(() =>
			assertUniqueName(files, [fid('a')], 'hello.txt'),
		).not.toThrow();
	});

	test('excludes self on rename', () => {
		const { files } = setup();
		files.set(makeRow('a', 'hello.txt'));

		expect(() =>
			assertUniqueName(files, [fid('a')], 'hello.txt', fid('a')),
		).not.toThrow();
	});
});

describe('disambiguateNames', () => {
	test('no duplicates: returns original names', () => {
		const rows = [
			makeRow('a', 'foo.txt', null, 1000),
			makeRow('b', 'bar.txt', null, 2000),
		];
		const result = disambiguateNames(rows);
		expect(result.get('a')).toBe('foo.txt');
		expect(result.get('b')).toBe('bar.txt');
	});

	test('duplicates: earliest keeps clean name, later gets suffix', () => {
		const rows = [
			makeRow('a', 'foo.txt', null, 1000),
			makeRow('b', 'foo.txt', null, 2000),
		];
		const result = disambiguateNames(rows);
		expect(result.get('a')).toBe('foo.txt');
		expect(result.get('b')).toBe('foo (1).txt');
	});

	test('three duplicates get incrementing suffixes by creation order', () => {
		const rows = [
			makeRow('c', 'file.md', null, 3000),
			makeRow('a', 'file.md', null, 1000),
			makeRow('b', 'file.md', null, 2000),
		];
		const result = disambiguateNames(rows);
		// Sorted by createdAt: a (1000), b (2000), c (3000)
		expect(result.get('a')).toBe('file.md');
		expect(result.get('b')).toBe('file (1).md');
		expect(result.get('c')).toBe('file (2).md');
	});

	test('extensionless file disambiguation', () => {
		const rows = [
			makeRow('a', 'Makefile', null, 1000),
			makeRow('b', 'Makefile', null, 2000),
		];
		const result = disambiguateNames(rows);
		expect(result.get('a')).toBe('Makefile');
		expect(result.get('b')).toBe('Makefile (1)');
	});
});
