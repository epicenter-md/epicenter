/**
 * File Tree Tests
 *
 * Validates path resolution and mutation behavior for the FileTree abstraction.
 * These tests ensure higher-level filesystem APIs can rely on stable ID lookups,
 * traversal, and soft-delete semantics.
 *
 * Key behaviors:
 * - Path parsing and lookup operations return expected IDs and filesystem errors.
 * - Create, move, delete, and traversal helpers keep tree state consistent.
 */

import { describe, expect, test } from 'bun:test';
import { createWorkspace } from '@epicenter/workspace';
import type { FileId } from '../ids.js';
import { filesTable } from '../table.js';
import { createFileTree } from './tree.js';

function setup() {
	const ws = createWorkspace({ id: 'test', tables: { files: filesTable } });
	return createFileTree(ws.tables.files);
}

describe('createFileTree', () => {
	describe('resolveId', () => {
		test('root returns null', () => {
			const tree = setup();
			expect(tree.resolveId('/')).toBeNull();
		});

		test('throws ENOENT for nonexistent path', () => {
			const tree = setup();
			expect(() => tree.resolveId('/nope')).toThrow('ENOENT');
		});

		test('returns id for existing file', () => {
			const tree = setup();
			const id = tree.create({
				name: 'test.txt',
				parentId: null,
				type: 'file',
				size: 0,
			});
			expect(tree.resolveId('/test.txt')).toBe(id);
		});
	});

	describe('lookupId', () => {
		test('returns undefined for nonexistent path', () => {
			const tree = setup();
			expect(tree.lookupId('/nope')).toBeUndefined();
		});

		test('returns id for existing file', () => {
			const tree = setup();
			const id = tree.create({
				name: 'test.txt',
				parentId: null,
				type: 'file',
				size: 0,
			});
			expect(tree.lookupId('/test.txt')).toBe(id);
		});
	});

	describe('getRow', () => {
		test('returns row for valid id', () => {
			const tree = setup();
			const id = tree.create({
				name: 'test.txt',
				parentId: null,
				type: 'file',
				size: 42,
			});
			const row = tree.getRow(id, '/test.txt');
			expect(row.name).toBe('test.txt');
			expect(row.type).toBe('file');
			expect(row.size).toBe(42);
			expect(row.trashedAt).toBeNull();
		});

		test('throws ENOENT for invalid id', () => {
			const tree = setup();
			expect(() => tree.getRow('bogus' as FileId, '/bogus')).toThrow('ENOENT');
		});
	});

	describe('parsePath', () => {
		test('parsePath on root-level file returns null parent and file name', () => {
			const tree = setup();
			const result = tree.parsePath('/test.txt');
			expect(result.parentId).toBeNull();
			expect(result.name).toBe('test.txt');
		});

		test('parsePath on nested file returns parent ID and leaf name', () => {
			const tree = setup();
			const dirId = tree.create({
				name: 'docs',
				parentId: null,
				type: 'folder',
				size: 0,
			});
			const result = tree.parsePath('/docs/api.md');
			expect(result.parentId).toBe(dirId);
			expect(result.name).toBe('api.md');
		});

		test('throws ENOENT if parent does not exist', () => {
			const tree = setup();
			expect(() => tree.parsePath('/nope/file.txt')).toThrow('ENOENT');
		});
	});

	describe('assertDirectory', () => {
		test('null id (root) passes', () => {
			const tree = setup();
			expect(() => tree.assertDirectory(null, '/')).not.toThrow();
		});

		test('folder id passes', () => {
			const tree = setup();
			const id = tree.create({
				name: 'dir',
				parentId: null,
				type: 'folder',
				size: 0,
			});
			expect(() => tree.assertDirectory(id, '/dir')).not.toThrow();
		});

		test('file id throws ENOTDIR', () => {
			const tree = setup();
			const id = tree.create({
				name: 'file.txt',
				parentId: null,
				type: 'file',
				size: 0,
			});
			expect(() => tree.assertDirectory(id, '/file.txt')).toThrow('ENOTDIR');
		});
	});

	describe('activeChildren', () => {
		test('returns empty for root with no children', () => {
			const tree = setup();
			expect(tree.activeChildren(null)).toEqual([]);
		});

		test('returns non-trashed children', () => {
			const tree = setup();
			tree.create({
				name: 'a.txt',
				parentId: null,
				type: 'file',
				size: 0,
			});
			tree.create({
				name: 'b.txt',
				parentId: null,
				type: 'file',
				size: 0,
			});
			const children = tree.activeChildren(null);
			expect(children).toHaveLength(2);
			expect(children.map((r) => r.name)).toEqual(['a.txt', 'b.txt']);
		});

		test('excludes soft-deleted children', () => {
			const tree = setup();
			const id = tree.create({
				name: 'a.txt',
				parentId: null,
				type: 'file',
				size: 0,
			});
			tree.create({
				name: 'b.txt',
				parentId: null,
				type: 'file',
				size: 0,
			});
			tree.softDelete(id);
			const children = tree.activeChildren(null);
			expect(children).toHaveLength(1);
			const remainingChild = children[0];
			expect(remainingChild).toBeDefined();
			if (remainingChild) {
				expect(remainingChild.name).toBe('b.txt');
			}
		});
	});

	describe('descendantIds', () => {
		test('returns all active descendants', () => {
			const tree = setup();
			const dirId = tree.create({
				name: 'dir',
				parentId: null,
				type: 'folder',
				size: 0,
			});
			const fileId = tree.create({
				name: 'file.txt',
				parentId: dirId,
				type: 'file',
				size: 0,
			});
			const subDirId = tree.create({
				name: 'sub',
				parentId: dirId,
				type: 'folder',
				size: 0,
			});
			const nestedId = tree.create({
				name: 'nested.txt',
				parentId: subDirId,
				type: 'file',
				size: 0,
			});

			const descendants = tree.descendantIds(dirId);
			expect(descendants).toContain(fileId);
			expect(descendants).toContain(subDirId);
			expect(descendants).toContain(nestedId);
			expect(descendants).toHaveLength(3);
		});

		test('excludes trashed descendants', () => {
			const tree = setup();
			const dirId = tree.create({
				name: 'dir',
				parentId: null,
				type: 'folder',
				size: 0,
			});
			const keepId = tree.create({
				name: 'keep.txt',
				parentId: dirId,
				type: 'file',
				size: 0,
			});
			const trashId = tree.create({
				name: 'trash.txt',
				parentId: dirId,
				type: 'file',
				size: 0,
			});
			tree.softDelete(trashId);

			const descendants = tree.descendantIds(dirId);
			expect(descendants).toContain(keepId);
			expect(descendants).not.toContain(trashId);
		});
	});

	describe('exists', () => {
		test('root always exists', () => {
			const tree = setup();
			expect(tree.exists('/')).toBe(true);
		});

		test('returns false for nonexistent', () => {
			const tree = setup();
			expect(tree.exists('/nope')).toBe(false);
		});

		test('returns true after create', () => {
			const tree = setup();
			tree.create({
				name: 'test.txt',
				parentId: null,
				type: 'file',
				size: 0,
			});
			expect(tree.exists('/test.txt')).toBe(true);
		});
	});

	describe('allPaths', () => {
		test('returns all indexed paths', () => {
			const tree = setup();
			tree.create({
				name: 'a.txt',
				parentId: null,
				type: 'file',
				size: 0,
			});
			const dirId = tree.create({
				name: 'dir',
				parentId: null,
				type: 'folder',
				size: 0,
			});
			tree.create({
				name: 'b.txt',
				parentId: dirId,
				type: 'file',
				size: 0,
			});
			const paths = tree.allPaths();
			expect(paths).toContain('/a.txt');
			expect(paths).toContain('/dir');
			expect(paths).toContain('/dir/b.txt');
		});
	});

	describe('create', () => {
		test('creates file at root', () => {
			const tree = setup();
			const id = tree.create({
				name: 'hello.txt',
				parentId: null,
				type: 'file',
				size: 5,
			});
			expect(id).toBeTruthy();
			expect(tree.exists('/hello.txt')).toBe(true);
			const row = tree.getRow(id, '/hello.txt');
			expect(row.size).toBe(5);
			expect(row.type).toBe('file');
		});

		test('creates folder', () => {
			const tree = setup();
			const id = tree.create({
				name: 'docs',
				parentId: null,
				type: 'folder',
				size: 0,
			});
			const row = tree.getRow(id, '/docs');
			expect(row.type).toBe('folder');
		});

		test('creates nested file', () => {
			const tree = setup();
			const dirId = tree.create({
				name: 'docs',
				parentId: null,
				type: 'folder',
				size: 0,
			});
			const fileId = tree.create({
				name: 'api.md',
				parentId: dirId,
				type: 'file',
				size: 10,
			});
			expect(tree.exists('/docs/api.md')).toBe(true);
			expect(tree.resolveId('/docs/api.md')).toBe(fileId);
		});

		test('rejects invalid names', () => {
			const tree = setup();
			expect(() =>
				tree.create({ name: '', parentId: null, type: 'file', size: 0 }),
			).toThrow();
			expect(() =>
				tree.create({ name: '/', parentId: null, type: 'file', size: 0 }),
			).toThrow();
		});

		test('rejects duplicate names in same parent', () => {
			const tree = setup();
			tree.create({
				name: 'test.txt',
				parentId: null,
				type: 'file',
				size: 0,
			});
			expect(() =>
				tree.create({
					name: 'test.txt',
					parentId: null,
					type: 'file',
					size: 0,
				}),
			).toThrow('EEXIST');
		});
	});

	describe('softDelete', () => {
		test('marks file as trashed', () => {
			const tree = setup();
			const id = tree.create({
				name: 'file.txt',
				parentId: null,
				type: 'file',
				size: 0,
			});
			tree.softDelete(id);
			const row = tree.getRow(id, '/file.txt');
			expect(row.trashedAt).not.toBeNull();
		});
	});

	describe('move', () => {
		test('move updates path when renaming a file in place', () => {
			const tree = setup();
			const id = tree.create({
				name: 'old.txt',
				parentId: null,
				type: 'file',
				size: 0,
			});
			tree.move(id, null, 'new.txt');
			expect(tree.exists('/old.txt')).toBe(false);
			expect(tree.exists('/new.txt')).toBe(true);
		});

		test('moves file to different parent', () => {
			const tree = setup();
			const dirId = tree.create({
				name: 'dir',
				parentId: null,
				type: 'folder',
				size: 0,
			});
			const fileId = tree.create({
				name: 'file.txt',
				parentId: null,
				type: 'file',
				size: 0,
			});
			tree.move(fileId, dirId, 'file.txt');
			expect(tree.exists('/file.txt')).toBe(false);
			expect(tree.exists('/dir/file.txt')).toBe(true);
		});

		test('rejects duplicate name in target parent', () => {
			const tree = setup();
			tree.create({
				name: 'existing.txt',
				parentId: null,
				type: 'file',
				size: 0,
			});
			const id = tree.create({
				name: 'other.txt',
				parentId: null,
				type: 'file',
				size: 0,
			});
			expect(() => tree.move(id, null, 'existing.txt')).toThrow('EEXIST');
		});
	});

	describe('touch', () => {
		test('updates size and updatedAt', () => {
			const tree = setup();
			const id = tree.create({
				name: 'file.txt',
				parentId: null,
				type: 'file',
				size: 0,
			});
			const before = tree.getRow(id, '/file.txt').updatedAt;
			tree.touch(id, 100);
			const row = tree.getRow(id, '/file.txt');
			expect(row.size).toBe(100);
			expect(row.updatedAt).toBeGreaterThanOrEqual(before);
		});
	});

	describe('setMtime', () => {
		test('updates updatedAt to specific time', () => {
			const tree = setup();
			const id = tree.create({
				name: 'file.txt',
				parentId: null,
				type: 'file',
				size: 0,
			});
			const specificTime = new Date('2025-06-15T12:00:00Z');
			tree.setMtime(id, specificTime);
			const row = tree.getRow(id, '/file.txt');
			expect(row.updatedAt).toBe(specificTime.getTime());
		});
	});

	describe('dispose', () => {
		test('can be called without error', () => {
			const tree = setup();
			expect(() => tree.dispose()).not.toThrow();
		});
	});
});
