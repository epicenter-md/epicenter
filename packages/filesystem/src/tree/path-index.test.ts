/**
 * FileSystemIndex Tests
 *
 * Verifies path indexing, orphan/cycle correction, and reactive rebuild behavior.
 * These tests ensure path lookup remains deterministic under live mutations and conflict scenarios.
 *
 * Key behaviors:
 * - File rows map to stable, disambiguated filesystem paths.
 * - Reactive updates keep index state consistent after edits and deletes.
 */

import { describe, expect, test } from 'bun:test';
import { createWorkspace } from '@epicenter/workspace';
import { asFileId } from '../ids.js';
import { filesTable } from '../table.js';
import { attachFileSystemIndex } from './path-index.js';

const fid = (s: string) => asFileId(s);

function setup() {
	const workspace = createWorkspace({
		id: 'test',
		tables: { files: filesTable },
		kv: {},
	});
	return { files: workspace.tables.files, ydoc: workspace.ydoc };
}

function makeRow(
	id: string,
	name: string,
	parentId: string | null = null,
	type: 'file' | 'folder' = 'file',
) {
	return {
		id: fid(id),
		name,
		parentId: parentId === null ? null : fid(parentId),
		type,
		size: 0,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		trashedAt: null,
	};
}

describe('attachFileSystemIndex', () => {
	// ═══════════════════════════════════════════════════════════════════════
	// BASIC INDEX BUILDING
	// ═══════════════════════════════════════════════════════════════════════

	test('empty table: no paths or children', () => {
		const { files, ydoc } = setup();
		const index = attachFileSystemIndex(ydoc, files);

		expect(index.allPaths().length).toBe(0);
		expect(index.getChildIds(null)).toEqual([]);

		ydoc.destroy();
	});

	test('indexes a single root file by absolute path', () => {
		const { files, ydoc } = setup();
		files.set(makeRow('f1', 'hello.txt'));
		const index = attachFileSystemIndex(ydoc, files);

		expect(index.getIdByPath('/hello.txt')).toBe(fid('f1'));
		expect(index.getChildIds(null)).toContain(fid('f1'));

		ydoc.destroy();
	});

	test('indexes multiple root files with distinct absolute paths', () => {
		const { files, ydoc } = setup();
		files.set(makeRow('f1', 'a.txt'));
		files.set(makeRow('f2', 'b.txt'));
		files.set(makeRow('f3', 'c.txt'));
		const index = attachFileSystemIndex(ydoc, files);

		expect(index.allPaths().length).toBe(3);
		expect(index.getIdByPath('/a.txt')).toBe(fid('f1'));
		expect(index.getIdByPath('/b.txt')).toBe(fid('f2'));
		expect(index.getIdByPath('/c.txt')).toBe(fid('f3'));
		expect(index.getChildIds(null)).toHaveLength(3);

		ydoc.destroy();
	});

	test('indexes nested directories and files under parent paths', () => {
		const { files, ydoc } = setup();
		files.set(makeRow('d1', 'docs', null, 'folder'));
		files.set(makeRow('f1', 'api.md', 'd1'));
		files.set(makeRow('f2', 'readme.md', 'd1'));
		const index = attachFileSystemIndex(ydoc, files);

		expect(index.getIdByPath('/docs')).toBe(fid('d1'));
		expect(index.getIdByPath('/docs/api.md')).toBe(fid('f1'));
		expect(index.getIdByPath('/docs/readme.md')).toBe(fid('f2'));
		expect(index.getChildIds(fid('d1'))).toEqual(
			expect.arrayContaining([fid('f1'), fid('f2')]),
		);

		ydoc.destroy();
	});

	test('resolves deeply nested file paths through multiple folders', () => {
		const { files, ydoc } = setup();
		files.set(makeRow('d1', 'a', null, 'folder'));
		files.set(makeRow('d2', 'b', 'd1', 'folder'));
		files.set(makeRow('d3', 'c', 'd2', 'folder'));
		files.set(makeRow('f1', 'file.txt', 'd3'));
		const index = attachFileSystemIndex(ydoc, files);

		expect(index.getIdByPath('/a/b/c/file.txt')).toBe(fid('f1'));
		expect(index.getChildIds(fid('d2'))).toEqual([fid('d3')]);
		expect(index.getChildIds(fid('d3'))).toEqual([fid('f1')]);

		ydoc.destroy();
	});

	test('empty folder gets a path but no children entry', () => {
		const { files, ydoc } = setup();
		files.set(makeRow('d1', 'empty', null, 'folder'));
		const index = attachFileSystemIndex(ydoc, files);

		expect(index.getIdByPath('/empty')).toBe(fid('d1'));
		expect(index.getChildIds(fid('d1'))).toEqual([]);

		ydoc.destroy();
	});

	// ═══════════════════════════════════════════════════════════════════════
	// TRASHED FILES
	// ═══════════════════════════════════════════════════════════════════════

	test('trashed files are excluded from paths and children', () => {
		const { files, ydoc } = setup();
		files.set(makeRow('f1', 'active.txt'));
		files.set({ ...makeRow('f2', 'trashed.txt'), trashedAt: Date.now() });
		const index = attachFileSystemIndex(ydoc, files);

		expect(index.getIdByPath('/active.txt')).toBe(fid('f1'));
		expect(index.hasPath('/trashed.txt')).toBe(false);
		expect(index.allPaths().length).toBe(1);

		ydoc.destroy();
	});

	test('children of a trashed folder become orphans and move to root', () => {
		const { files, ydoc } = setup();
		files.set({
			...makeRow('d1', 'docs', null, 'folder'),
			trashedAt: Date.now(),
		});
		files.set(makeRow('f1', 'readme.md', 'd1'));
		const index = attachFileSystemIndex(ydoc, files);

		expect(index.hasPath('/docs')).toBe(false);
		// Child's parent is trashed → orphan → moved to root
		expect(index.getIdByPath('/readme.md')).toBe(fid('f1'));

		ydoc.destroy();
	});

	test('trashing a file frees its name for other files', () => {
		const { files, ydoc } = setup();
		files.set({ ...makeRow('f1', 'report.txt'), trashedAt: Date.now() });
		files.set(makeRow('f2', 'report.txt'));
		const index = attachFileSystemIndex(ydoc, files);

		expect(index.getIdByPath('/report.txt')).toBe(fid('f2'));
		expect(index.allPaths().length).toBe(1);

		ydoc.destroy();
	});

	// ═══════════════════════════════════════════════════════════════════════
	// REACTIVE UPDATES
	// ═══════════════════════════════════════════════════════════════════════

	test('reactive: adding a file updates index', () => {
		const { files, ydoc } = setup();
		const index = attachFileSystemIndex(ydoc, files);

		expect(index.hasPath('/new.txt')).toBe(false);

		files.set(makeRow('f1', 'new.txt'));

		expect(index.getIdByPath('/new.txt')).toBe(fid('f1'));

		ydoc.destroy();
	});

	test('reactive: trashing a file removes it', () => {
		const { files, ydoc } = setup();
		files.set(makeRow('f1', 'hello.txt'));
		const index = attachFileSystemIndex(ydoc, files);

		expect(index.getIdByPath('/hello.txt')).toBe(fid('f1'));

		files.update('f1', { trashedAt: Date.now() });

		expect(index.hasPath('/hello.txt')).toBe(false);

		ydoc.destroy();
	});

	test('reactive: rename updates path', () => {
		const { files, ydoc } = setup();
		files.set(makeRow('f1', 'old.txt'));
		const index = attachFileSystemIndex(ydoc, files);

		files.update('f1', { name: 'new.txt' });

		expect(index.hasPath('/old.txt')).toBe(false);
		expect(index.getIdByPath('/new.txt')).toBe(fid('f1'));

		ydoc.destroy();
	});

	test('reactive: move file to different parent', () => {
		const { files, ydoc } = setup();
		files.set(makeRow('d1', 'src', null, 'folder'));
		files.set(makeRow('d2', 'lib', null, 'folder'));
		files.set(makeRow('f1', 'util.ts', 'd1'));
		const index = attachFileSystemIndex(ydoc, files);

		expect(index.getIdByPath('/src/util.ts')).toBe(fid('f1'));

		files.update('f1', { parentId: fid('d2') });

		expect(index.hasPath('/src/util.ts')).toBe(false);
		expect(index.getIdByPath('/lib/util.ts')).toBe(fid('f1'));
		expect(index.getChildIds(fid('d1'))).toEqual([]);
		expect(index.getChildIds(fid('d2'))).toContain(fid('f1'));

		ydoc.destroy();
	});

	test('reactive: move file to root', () => {
		const { files, ydoc } = setup();
		files.set(makeRow('d1', 'folder', null, 'folder'));
		files.set(makeRow('f1', 'file.txt', 'd1'));
		const index = attachFileSystemIndex(ydoc, files);

		expect(index.getIdByPath('/folder/file.txt')).toBe(fid('f1'));

		files.update('f1', { parentId: null });

		expect(index.hasPath('/folder/file.txt')).toBe(false);
		expect(index.getIdByPath('/file.txt')).toBe(fid('f1'));

		ydoc.destroy();
	});

	test('reactive: deleting a file removes it', () => {
		const { files, ydoc } = setup();
		files.set(makeRow('f1', 'doomed.txt'));
		const index = attachFileSystemIndex(ydoc, files);

		files.delete('f1');

		expect(index.hasPath('/doomed.txt')).toBe(false);
		expect(index.allPaths().length).toBe(0);

		ydoc.destroy();
	});

	test('reactive: renaming a parent folder updates children paths', () => {
		const { files, ydoc } = setup();
		files.set(makeRow('d1', 'old-name', null, 'folder'));
		files.set(makeRow('f1', 'child.txt', 'd1'));
		const index = attachFileSystemIndex(ydoc, files);

		files.update('d1', { name: 'new-name' });

		expect(index.hasPath('/old-name')).toBe(false);
		expect(index.hasPath('/old-name/child.txt')).toBe(false);
		expect(index.getIdByPath('/new-name')).toBe(fid('d1'));
		expect(index.getIdByPath('/new-name/child.txt')).toBe(fid('f1'));

		ydoc.destroy();
	});

	// ═══════════════════════════════════════════════════════════════════════
	// CIRCULAR REFERENCE DETECTION
	// ═══════════════════════════════════════════════════════════════════════

	test('circular ref: self-referencing file is fixed', () => {
		const { files, ydoc } = setup();
		files.set(makeRow('f1', 'self-loop.txt', 'f1'));
		const index = attachFileSystemIndex(ydoc, files);

		expect(files.get('f1').data?.parentId).toBeNull();
		expect(index.getIdByPath('/self-loop.txt')).toBe(fid('f1'));

		ydoc.destroy();
	});

	test('circular ref: two-node cycle (A→B→A) moves latest to root', () => {
		const { files, ydoc } = setup();
		// A.parentId = B, B.parentId = A: cycle
		// B has later updatedAt so B gets moved to root
		// After fix: B.parentId = null, A.parentId = B → tree is root→B→A
		files.set({ ...makeRow('a', 'alpha', 'b', 'folder'), updatedAt: 1000 });
		files.set({ ...makeRow('b', 'beta', 'a', 'folder'), updatedAt: 2000 });
		const index = attachFileSystemIndex(ydoc, files);

		expect(files.get('b').data?.parentId).toBeNull();

		// B is at root, A is child of B
		expect(index.getIdByPath('/beta')).toBe(fid('b'));
		expect(index.getIdByPath('/beta/alpha')).toBe(fid('a'));

		ydoc.destroy();
	});

	test('circular ref: three-node cycle (A→B→C→A) moves latest to root', () => {
		const { files, ydoc } = setup();
		// A.parentId = C, B.parentId = A, C.parentId = B → cycle
		// C has latest updatedAt → C moved to root
		// After fix: C.parentId = null, B.parentId = A, A.parentId = C
		// Tree: root→C→A→B
		files.set({ ...makeRow('a', 'node-a', 'c', 'folder'), updatedAt: 1000 });
		files.set({ ...makeRow('b', 'node-b', 'a', 'folder'), updatedAt: 2000 });
		files.set({ ...makeRow('c', 'node-c', 'b', 'folder'), updatedAt: 3000 });
		const index = attachFileSystemIndex(ydoc, files);

		expect(files.get('c').data?.parentId).toBeNull();

		// All three should be reachable
		expect(index.allPaths().length).toBe(3);

		ydoc.destroy();
	});

	test('circular ref: cycle does not affect non-cycle siblings', () => {
		const { files, ydoc } = setup();
		files.set(makeRow('clean', 'clean.txt'));
		// Cycle: x→y→x
		files.set({ ...makeRow('x', 'x-file', 'y', 'folder'), updatedAt: 1000 });
		files.set({ ...makeRow('y', 'y-file', 'x', 'folder'), updatedAt: 2000 });
		const index = attachFileSystemIndex(ydoc, files);

		expect(index.getIdByPath('/clean.txt')).toBe(fid('clean'));
		expect(index.allPaths().length).toBe(3);

		ydoc.destroy();
	});

	// ═══════════════════════════════════════════════════════════════════════
	// ORPHAN DETECTION
	// ═══════════════════════════════════════════════════════════════════════

	test('orphan: parent does not exist, file moved to root', () => {
		const { files, ydoc } = setup();
		files.set(makeRow('f1', 'orphan.txt', 'nonexistent'));
		const index = attachFileSystemIndex(ydoc, files);

		expect(files.get('f1').data?.parentId).toBeNull();
		expect(index.getIdByPath('/orphan.txt')).toBe(fid('f1'));

		ydoc.destroy();
	});

	test('orphan: parent is trashed, child moved to root', () => {
		const { files, ydoc } = setup();
		files.set({
			...makeRow('d1', 'trashed-folder', null, 'folder'),
			trashedAt: Date.now(),
		});
		files.set(makeRow('f1', 'child.txt', 'd1'));
		const index = attachFileSystemIndex(ydoc, files);

		expect(files.get('f1').data?.parentId).toBeNull();
		expect(index.getIdByPath('/child.txt')).toBe(fid('f1'));

		ydoc.destroy();
	});

	test('orphan: multiple orphans with same missing parent', () => {
		const { files, ydoc } = setup();
		files.set(makeRow('f1', 'orphan-a.txt', 'gone'));
		files.set(makeRow('f2', 'orphan-b.txt', 'gone'));
		const index = attachFileSystemIndex(ydoc, files);

		expect(files.get('f1').data?.parentId).toBeNull();
		expect(files.get('f2').data?.parentId).toBeNull();

		expect(index.getIdByPath('/orphan-a.txt')).toBe(fid('f1'));
		expect(index.getIdByPath('/orphan-b.txt')).toBe(fid('f2'));
		expect(index.getChildIds(null)).toEqual(
			expect.arrayContaining([fid('f1'), fid('f2')]),
		);

		ydoc.destroy();
	});

	test('orphan: chain (grandparent missing) only fixes the direct orphan', () => {
		const { files, ydoc } = setup();
		files.set(makeRow('d1', 'lost-folder', 'vanished', 'folder'));
		files.set(makeRow('f1', 'deep-orphan.txt', 'd1'));
		const index = attachFileSystemIndex(ydoc, files);

		// d1 moved to root (parent doesn't exist)
		expect(files.get('d1').data?.parentId).toBeNull();

		// f1 stays under d1 since d1 is now at root
		expect(index.getIdByPath('/lost-folder')).toBe(fid('d1'));
		expect(index.getIdByPath('/lost-folder/deep-orphan.txt')).toBe(fid('f1'));

		ydoc.destroy();
	});

	// ═══════════════════════════════════════════════════════════════════════
	// CRDT NAME DISAMBIGUATION
	// ═══════════════════════════════════════════════════════════════════════

	test('disambiguation: two files with same name', () => {
		const { files, ydoc } = setup();
		files.set({ ...makeRow('a', 'foo.txt'), createdAt: 1000, updatedAt: 1000 });
		files.set({ ...makeRow('b', 'foo.txt'), createdAt: 2000, updatedAt: 2000 });
		const index = attachFileSystemIndex(ydoc, files);

		expect(index.getIdByPath('/foo.txt')).toBe(fid('a'));
		expect(index.getIdByPath('/foo (1).txt')).toBe(fid('b'));

		ydoc.destroy();
	});

	test('disambiguation: three files with same name', () => {
		const { files, ydoc } = setup();
		files.set({ ...makeRow('a', 'doc.md'), createdAt: 1000 });
		files.set({ ...makeRow('b', 'doc.md'), createdAt: 2000 });
		files.set({ ...makeRow('c', 'doc.md'), createdAt: 3000 });
		const index = attachFileSystemIndex(ydoc, files);

		expect(index.getIdByPath('/doc.md')).toBe(fid('a'));
		expect(index.getIdByPath('/doc (1).md')).toBe(fid('b'));
		expect(index.getIdByPath('/doc (2).md')).toBe(fid('c'));

		ydoc.destroy();
	});

	test('disambiguation: files without extensions', () => {
		const { files, ydoc } = setup();
		files.set({ ...makeRow('a', 'Makefile'), createdAt: 1000 });
		files.set({ ...makeRow('b', 'Makefile'), createdAt: 2000 });
		const index = attachFileSystemIndex(ydoc, files);

		expect(index.getIdByPath('/Makefile')).toBe(fid('a'));
		expect(index.getIdByPath('/Makefile (1)')).toBe(fid('b'));

		ydoc.destroy();
	});

	test('disambiguation: duplicate folder names propagate to children paths', () => {
		const { files, ydoc } = setup();
		files.set({ ...makeRow('d1', 'src', null, 'folder'), createdAt: 1000 });
		files.set({ ...makeRow('d2', 'src', null, 'folder'), createdAt: 2000 });
		files.set(makeRow('f1', 'index.ts', 'd1'));
		files.set(makeRow('f2', 'index.ts', 'd2'));
		const index = attachFileSystemIndex(ydoc, files);

		expect(index.getIdByPath('/src')).toBe(fid('d1'));
		expect(index.getIdByPath('/src (1)')).toBe(fid('d2'));
		expect(index.getIdByPath('/src/index.ts')).toBe(fid('f1'));
		expect(index.getIdByPath('/src (1)/index.ts')).toBe(fid('f2'));

		ydoc.destroy();
	});

	test('disambiguation: same name in different parents is not disambiguated', () => {
		const { files, ydoc } = setup();
		files.set(makeRow('d1', 'a', null, 'folder'));
		files.set(makeRow('d2', 'b', null, 'folder'));
		files.set(makeRow('f1', 'same.txt', 'd1'));
		files.set(makeRow('f2', 'same.txt', 'd2'));
		const index = attachFileSystemIndex(ydoc, files);

		expect(index.getIdByPath('/a/same.txt')).toBe(fid('f1'));
		expect(index.getIdByPath('/b/same.txt')).toBe(fid('f2'));

		ydoc.destroy();
	});

	// ═══════════════════════════════════════════════════════════════════════
	// MAX_DEPTH GUARD
	// ═══════════════════════════════════════════════════════════════════════

	test('path exceeding MAX_DEPTH (50) is excluded', () => {
		const { files, ydoc } = setup();

		// Build 51 folders deep: exceeds MAX_DEPTH
		let parentId: string | null = null;
		for (let i = 0; i < 51; i++) {
			const id = `d${i}`;
			files.set(makeRow(id, `level-${i}`, parentId, 'folder'));
			parentId = id;
		}
		files.set(makeRow('deep-file', 'bottom.txt', parentId));

		const index = attachFileSystemIndex(ydoc, files);

		// Depth 52 file should NOT have a path
		expect(index.allPaths().some((p) => p.endsWith('/bottom.txt'))).toBe(false);
		// Shallow files still work
		expect(index.getIdByPath('/level-0')).toBe(fid('d0'));

		ydoc.destroy();
	});

	test('path at depth 49 (under MAX_DEPTH) is included', () => {
		const { files, ydoc } = setup();

		// 48 folders + 1 file = 49 path parts: safely under MAX_DEPTH
		let parentId: string | null = null;
		for (let i = 0; i < 48; i++) {
			const id = `d${i}`;
			files.set(makeRow(id, `l${i}`, parentId, 'folder'));
			parentId = id;
		}
		files.set(makeRow('leaf', 'file.txt', parentId));

		const index = attachFileSystemIndex(ydoc, files);

		expect(index.allPaths().some((p) => p.endsWith('/file.txt'))).toBe(true);

		ydoc.destroy();
	});

	// ═══════════════════════════════════════════════════════════════════════
	// COMBINED / EDGE CASES
	// ═══════════════════════════════════════════════════════════════════════

	test('batch mutations trigger rebuild', () => {
		const { files, ydoc } = setup();
		const index = attachFileSystemIndex(ydoc, files);

		ydoc.transact(() => {
			files.set(makeRow('d1', 'folder', null, 'folder'));
			files.set(makeRow('f1', 'inside.txt', 'd1'));
			files.set(makeRow('f2', 'root.txt'));
		});

		expect(index.getIdByPath('/folder')).toBe(fid('d1'));
		expect(index.getIdByPath('/folder/inside.txt')).toBe(fid('f1'));
		expect(index.getIdByPath('/root.txt')).toBe(fid('f2'));
		expect(index.allPaths().length).toBe(3);

		ydoc.destroy();
	});

	test('orphan moved to root gets disambiguated with existing root file', () => {
		const { files, ydoc } = setup();
		files.set({ ...makeRow('f1', 'conflict.txt'), createdAt: 1000 });
		files.set({ ...makeRow('f2', 'conflict.txt', 'missing'), createdAt: 2000 });
		const index = attachFileSystemIndex(ydoc, files);

		expect(files.get('f2').data?.parentId).toBeNull();

		// Both reachable with unique paths
		expect(index.allPaths().length).toBe(2);

		ydoc.destroy();
	});

	test('rebuild clears stale entries completely', () => {
		const { files, ydoc } = setup();
		files.set(makeRow('f1', 'first.txt'));
		files.set(makeRow('f2', 'second.txt'));
		const index = attachFileSystemIndex(ydoc, files);

		expect(index.allPaths().length).toBe(2);

		files.delete('f1');
		files.delete('f2');

		expect(index.allPaths().length).toBe(0);
		expect(index.getChildIds(null)).toEqual([]);

		ydoc.destroy();
	});
});
