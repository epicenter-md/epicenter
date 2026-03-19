/**
 * YjsFileSystem Tests
 *
 * Exercises filesystem-style APIs implemented on top of Yjs-backed file and content state.
 * These tests verify compatibility with common FS operations and storage-mode transitions.
 *
 * Key behaviors:
 * - Path operations (`writeFile`, `mkdir`, `rm`, `mv`, `cp`) match expected filesystem semantics.
 * - Timeline-backed content preserves text, binary, and sheet-mode behavior across edits.
 */

import { describe, expect, test } from 'bun:test';
import { createWorkspace } from '@epicenter/workspace';
import { Bash } from 'just-bash';
import { createTimeline } from './content/timeline.js';
import { createYjsFileSystem, type YjsFileSystem } from './file-system.js';
import { filesTable } from './table.js';

function setup() {
	const ws = createWorkspace({ id: 'test', tables: { files: filesTable } });
	const fs = createYjsFileSystem(ws.tables.files, ws.documents.files.content);
	return { fs, ws };
}

describe('YjsFileSystem', () => {
	describe('exists', () => {
		test('root always exists', async () => {
			const { fs } = setup();
			expect(await fs.exists('/')).toBe(true);
		});

		test('nonexistent path', async () => {
			const { fs } = setup();
			expect(await fs.exists('/nope')).toBe(false);
		});
	});

	describe('writeFile + readFile', () => {
		test('create and read a file', async () => {
			const { fs } = setup();
			await fs.writeFile('/hello.txt', 'Hello World');
			const content = await fs.readFile('/hello.txt');
			expect(content).toBe('Hello World');
		});

		test('overwrite existing file', async () => {
			const { fs } = setup();
			await fs.writeFile('/file.txt', 'first');
			await fs.writeFile('/file.txt', 'second');
			expect(await fs.readFile('/file.txt')).toBe('second');
		});

		test('readFile on nonexistent throws ENOENT', async () => {
			const { fs } = setup();
			await expect(fs.readFile('/nope')).rejects.toThrow('ENOENT');
		});

		test('readFile on directory throws EISDIR', async () => {
			const { fs } = setup();
			await fs.mkdir('/dir');
			await expect(fs.readFile('/dir')).rejects.toThrow('EISDIR');
		});

		test('writeFile on existing directory throws EISDIR', async () => {
			const { fs } = setup();
			await fs.mkdir('/dir');
			await expect(fs.writeFile('/dir', 'content')).rejects.toThrow('EISDIR');
		});
	});

	describe('appendFile', () => {
		test('append to existing file', async () => {
			const { fs } = setup();
			await fs.writeFile('/file.txt', 'Hello');
			await fs.appendFile('/file.txt', ' World');
			expect(await fs.readFile('/file.txt')).toBe('Hello World');
		});

		test('append creates file if not exists', async () => {
			const { fs } = setup();
			await fs.appendFile('/new.txt', 'content');
			expect(await fs.readFile('/new.txt')).toBe('content');
		});

		test('append to directory throws EISDIR', async () => {
			const { fs } = setup();
			await fs.mkdir('/dir');
			await expect(fs.appendFile('/dir', 'data')).rejects.toThrow('EISDIR');
		});

		test('multiple appends accumulate content', async () => {
			const { fs } = setup();
			await fs.writeFile('/log.txt', 'line1\n');
			await fs.appendFile('/log.txt', 'line2\n');
			await fs.appendFile('/log.txt', 'line3\n');
			expect(await fs.readFile('/log.txt')).toBe('line1\nline2\nline3\n');
		});
	});

	describe('stat', () => {
		test('stat root', async () => {
			const { fs } = setup();
			const s = await fs.stat('/');
			expect(s.isDirectory).toBe(true);
			expect(s.isFile).toBe(false);
		});

		test('stat file', async () => {
			const { fs } = setup();
			await fs.writeFile('/hello.txt', 'Hi');
			const s = await fs.stat('/hello.txt');
			expect(s.isFile).toBe(true);
			expect(s.isDirectory).toBe(false);
			expect(s.size).toBe(2);
			expect(s.mode).toBe(0o644);
		});

		test('stat directory', async () => {
			const { fs } = setup();
			await fs.mkdir('/dir');
			const s = await fs.stat('/dir');
			expect(s.isDirectory).toBe(true);
			expect(s.mode).toBe(0o755);
		});

		test('stat nonexistent throws ENOENT', async () => {
			const { fs } = setup();
			await expect(fs.stat('/nope')).rejects.toThrow('ENOENT');
		});
	});

	describe('mkdir', () => {
		test('create directory', async () => {
			const { fs } = setup();
			await fs.mkdir('/docs');
			expect(await fs.exists('/docs')).toBe(true);
			const s = await fs.stat('/docs');
			expect(s.isDirectory).toBe(true);
		});

		test('mkdir -p (recursive)', async () => {
			const { fs } = setup();
			await fs.mkdir('/a/b/c', { recursive: true });
			expect(await fs.exists('/a')).toBe(true);
			expect(await fs.exists('/a/b')).toBe(true);
			expect(await fs.exists('/a/b/c')).toBe(true);
		});

		test('mkdir on existing dir is no-op', async () => {
			const { fs } = setup();
			await fs.mkdir('/dir');
			await fs.mkdir('/dir'); // should not throw
			expect(await fs.exists('/dir')).toBe(true);
		});

		test('mkdir on existing file throws EEXIST', async () => {
			const { fs } = setup();
			await fs.writeFile('/file.txt', 'content');
			await expect(fs.mkdir('/file.txt')).rejects.toThrow('EEXIST');
		});

		test('mkdir -p through existing file throws ENOTDIR', async () => {
			const { fs } = setup();
			await fs.writeFile('/file.txt', 'content');
			await expect(
				fs.mkdir('/file.txt/sub', { recursive: true }),
			).rejects.toThrow('ENOTDIR');
		});

		test('mkdir -p through existing directories is no-op for existing', async () => {
			const { fs } = setup();
			await fs.mkdir('/a', { recursive: true });
			await fs.mkdir('/a/b/c', { recursive: true });
			expect(await fs.exists('/a/b/c')).toBe(true);
		});
	});

	describe('readdir', () => {
		test('readdir root', async () => {
			const { fs } = setup();
			await fs.writeFile('/a.txt', 'a');
			await fs.writeFile('/b.txt', 'b');
			const entries = await fs.readdir('/');
			expect(entries).toEqual(['a.txt', 'b.txt']);
		});

		test('readdir nested', async () => {
			const { fs } = setup();
			await fs.mkdir('/docs');
			await fs.writeFile('/docs/api.md', '# API');
			await fs.writeFile('/docs/readme.md', '# README');
			const entries = await fs.readdir('/docs');
			expect(entries).toEqual(['api.md', 'readme.md']);
		});

		test('readdir on file throws ENOTDIR', async () => {
			const { fs } = setup();
			await fs.writeFile('/file.txt', 'content');
			await expect(fs.readdir('/file.txt')).rejects.toThrow('ENOTDIR');
		});
	});

	describe('rm', () => {
		test('rm file (soft delete)', async () => {
			const { fs } = setup();
			await fs.writeFile('/file.txt', 'content');
			await fs.rm('/file.txt');
			expect(await fs.exists('/file.txt')).toBe(false);
		});

		test('rm -rf directory', async () => {
			const { fs } = setup();
			await fs.mkdir('/dir');
			await fs.writeFile('/dir/file.txt', 'content');
			await fs.rm('/dir', { recursive: true });
			expect(await fs.exists('/dir')).toBe(false);
			expect(await fs.exists('/dir/file.txt')).toBe(false);
		});

		test('rm nonexistent throws ENOENT', async () => {
			const { fs } = setup();
			await expect(fs.rm('/nope')).rejects.toThrow('ENOENT');
		});

		test('rm --force nonexistent is no-op', async () => {
			const { fs } = setup();
			await fs.rm('/nope', { force: true }); // should not throw
		});

		test('rm non-empty dir without recursive throws ENOTEMPTY', async () => {
			const { fs } = setup();
			await fs.mkdir('/dir');
			await fs.writeFile('/dir/file.txt', 'content');
			await expect(fs.rm('/dir')).rejects.toThrow('ENOTEMPTY');
		});
	});

	describe('mv', () => {
		test('rename file', async () => {
			const { fs } = setup();
			await fs.writeFile('/old.txt', 'content');
			await fs.mv('/old.txt', '/new.txt');
			expect(await fs.exists('/old.txt')).toBe(false);
			expect(await fs.exists('/new.txt')).toBe(true);
		});

		test('move file to directory', async () => {
			const { fs } = setup();
			await fs.mkdir('/dir');
			await fs.writeFile('/file.txt', 'content');
			await fs.mv('/file.txt', '/dir/file.txt');
			expect(await fs.exists('/file.txt')).toBe(false);
			expect(await fs.exists('/dir/file.txt')).toBe(true);
			expect(await fs.readFile('/dir/file.txt')).toBe('content');
		});
	});

	describe('cp', () => {
		test('copy file', async () => {
			const { fs } = setup();
			await fs.writeFile('/src.txt', 'content');
			await fs.cp('/src.txt', '/dest.txt');
			expect(await fs.readFile('/dest.txt')).toBe('content');
			expect(await fs.readFile('/src.txt')).toBe('content');
		});

		test('copy directory recursively', async () => {
			const { fs } = setup();
			await fs.mkdir('/src');
			await fs.writeFile('/src/a.txt', 'aaa');
			await fs.writeFile('/src/b.txt', 'bbb');
			await fs.cp('/src', '/dest', { recursive: true });
			expect(await fs.readFile('/dest/a.txt')).toBe('aaa');
			expect(await fs.readFile('/dest/b.txt')).toBe('bbb');
		});
	});

	describe('resolvePath', () => {
		test('resolves relative paths', () => {
			const { fs } = setup();
			expect(fs.resolvePath('/docs', 'api.md')).toBe('/docs/api.md');
			expect(fs.resolvePath('/docs', '../src/index.ts')).toBe('/src/index.ts');
			expect(fs.resolvePath('/docs', '/absolute')).toBe('/absolute');
		});
	});

	describe('getAllPaths', () => {
		test('returns all paths except root', async () => {
			const { fs } = setup();
			await fs.mkdir('/docs');
			await fs.writeFile('/docs/api.md', '# API');
			const paths = fs.getAllPaths();
			expect(paths).toContain('/docs');
			expect(paths).toContain('/docs/api.md');
			expect(paths).not.toContain('/');
		});
	});

	describe('chmod', () => {
		test('no-op but verifies file exists', async () => {
			const { fs } = setup();
			await fs.writeFile('/file.txt', 'content');
			await fs.chmod('/file.txt', 0o755); // should not throw
		});

		test('chmod on nonexistent throws ENOENT', async () => {
			const { fs } = setup();
			await expect(fs.chmod('/nope', 0o755)).rejects.toThrow('ENOENT');
		});
	});

	describe('symlink / link / readlink', () => {
		test('symlink throws ENOSYS', async () => {
			const { fs } = setup();
			await expect(fs.symlink('/target', '/link')).rejects.toThrow('ENOSYS');
		});

		test('link throws ENOSYS', async () => {
			const { fs } = setup();
			await expect(fs.link('/existing', '/new')).rejects.toThrow('ENOSYS');
		});

		test('readlink throws ENOSYS', async () => {
			const { fs } = setup();
			await expect(fs.readlink('/link')).rejects.toThrow('ENOSYS');
		});
	});
});

describe('Uint8Array write support', () => {
	test('writeFile with Uint8Array converts to text and roundtrips', async () => {
		const { fs } = setup();
		const data = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]); // "Hello"
		await fs.writeFile('/file.txt', data);
		const result = await fs.readFileBuffer('/file.txt');
		expect(result).toEqual(data);
		expect(await fs.readFile('/file.txt')).toBe('Hello');
	});

	test('writeFile with Uint8Array then text overwrites', async () => {
		const { fs } = setup();
		const data = new Uint8Array([0x48, 0x69]); // "Hi"
		await fs.writeFile('/file.txt', data);
		await fs.writeFile('/file.txt', 'text content');
		expect(await fs.readFile('/file.txt')).toBe('text content');
	});

	test('cp copies file content as text', async () => {
		const { fs } = setup();
		const data = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]); // "Hello"
		await fs.writeFile('/src.bin', data);
		await fs.cp('/src.bin', '/dest.bin');
		expect(await fs.readFile('/dest.bin')).toBe('Hello');
	});

	test('rm cleans up Uint8Array-written file', async () => {
		const { fs } = setup();
		const data = new Uint8Array([0x48, 0x69]); // "Hi"
		await fs.writeFile('/file.bin', data);
		await fs.rm('/file.bin');
		expect(await fs.exists('/file.bin')).toBe(false);
	});
});

describe('mv preserves content (no conversion)', () => {
	test('mv .txt -> .md preserves content exactly', async () => {
		const { fs } = setup();
		await fs.writeFile('/notes.txt', '---\ntitle: Hello\n---\n# Content\n');
		await fs.mv('/notes.txt', '/notes.md');
		expect(await fs.readFile('/notes.md')).toBe(
			'---\ntitle: Hello\n---\n# Content\n',
		);
	});

	test('mv .md -> .txt preserves content exactly', async () => {
		const { fs } = setup();
		await fs.writeFile('/doc.md', '# Hello World\n');
		await fs.mv('/doc.md', '/doc.txt');
		expect(await fs.readFile('/doc.txt')).toBe('# Hello World\n');
	});
});

async function getTimelineLength(
	fs: YjsFileSystem,
	documents: { open(input: string): Promise<{ ydoc: import('yjs').Doc }> },
	path: string,
): Promise<number> {
	const id = fs.lookupId(path);
	if (!id) throw new Error(`No file at ${path}`);
	const handle = await documents.open(id);
	return handle.length;
}

describe('timeline content storage', () => {


	test('text append (appendFile on text entry)', async () => {
		const { fs, ws } = setup();
		const documents = ws.documents.files.content;
		await fs.writeFile('/log.txt', 'line1\n');
		await fs.appendFile('/log.txt', 'line2\n');
		expect(await fs.readFile('/log.txt')).toBe('line1\nline2\n');
		// Append to text should not grow timeline
		expect(await getTimelineLength(fs, documents, '/log.txt')).toBe(1);
	});


	test('Uint8Array writes are treated as text (no mode switch)', async () => {
		const { fs, ws } = setup();
		const documents = ws.documents.files.content;
		await fs.writeFile('/file.dat', 'text v1');
		expect(await getTimelineLength(fs, documents, '/file.dat')).toBe(1);

		// Uint8Array is decoded to text — same mode, overwrites in-place
		await fs.writeFile('/file.dat', new Uint8Array([0x48, 0x69])); // "Hi"
		expect(await getTimelineLength(fs, documents, '/file.dat')).toBe(1);
		expect(await fs.readFile('/file.dat')).toBe('Hi');
	});

	test('same-mode text overwrite does NOT grow timeline', async () => {
		const { fs, ws } = setup();
		const documents = ws.documents.files.content;
		await fs.writeFile('/file.txt', 'first');
		await fs.writeFile('/file.txt', 'second');
		await fs.writeFile('/file.txt', 'third');
		expect(await fs.readFile('/file.txt')).toBe('third');
		expect(await getTimelineLength(fs, documents, '/file.txt')).toBe(1);
	});


	test('readFileBuffer returns correct bytes for text entry', async () => {
		const { fs } = setup();
		await fs.writeFile('/file.txt', 'hello');
		const buf = await fs.readFileBuffer('/file.txt');
		expect(buf).toEqual(new TextEncoder().encode('hello'));
	});

});

describe('sheet file support', () => {
	test('readFile returns CSV for sheet-mode file', async () => {
		const { fs, ws } = setup();
		const documents = ws.documents.files.content;
		await fs.writeFile('/data.csv', 'placeholder');
		const fileId = fs.lookupId('/data.csv');
		expect(fileId).toBeDefined();
		if (!fileId) throw new Error('Expected /data.csv to exist');
		const handle = await documents.open(fileId);
		handle.batch(() => {
			handle.write('Name,Age\nAlice,30\n');
		handle.asSheet();
		});
		expect(await fs.readFile('/data.csv')).toBe('Name,Age\nAlice,30\n');
	});

	test('writeFile on sheet-mode re-parses CSV in place', async () => {
		const { fs, ws } = setup();
		const documents = ws.documents.files.content;
		await fs.writeFile('/data.csv', 'placeholder');
		const fileId = fs.lookupId('/data.csv');
		expect(fileId).toBeDefined();
		if (!fileId) throw new Error('Expected /data.csv to exist');
		const handle = await documents.open(fileId);
		handle.batch(() => {
			handle.write('A,B\n1,2\n');
		handle.asSheet();
		});
		await fs.writeFile('/data.csv', 'X,Y\n3,4\n');
		expect(await fs.readFile('/data.csv')).toBe('X,Y\n3,4\n');
	});
});

describe('just-bash integration', () => {
	function setupBash() {
		const { fs } = setup();
		return new Bash({ fs, cwd: '/' });
	}

	test('bash echo writes text that cat reads back', async () => {
		const bash = setupBash();
		await bash.exec('echo "hello world" > /greeting.txt');
		const result = await bash.exec('cat /greeting.txt');
		expect(result.stdout.trim()).toBe('hello world');
	});

	test('bash mkdir -p creates directory visible to ls', async () => {
		const bash = setupBash();
		await bash.exec('mkdir -p /docs/nested');
		const result = await bash.exec('ls /docs');
		expect(result.stdout.trim()).toBe('nested');
	});

	test('bash find returns files matching extension pattern', async () => {
		const bash = setupBash();
		await bash.exec('mkdir -p /src');
		await bash.exec('echo "ts" > /src/index.ts');
		await bash.exec('echo "md" > /src/readme.md');
		const result = await bash.exec('find / -name "*.ts"');
		expect(result.stdout.trim()).toContain('/src/index.ts');
	});

	test('bash grep -r returns matching content and file path', async () => {
		const bash = setupBash();
		await bash.exec('echo "TODO: fix this" > /file.txt');
		await bash.exec('echo "all good" > /other.txt');
		const result = await bash.exec('grep -r "TODO" /');
		expect(result.stdout).toContain('TODO');
		expect(result.stdout).toContain('/file.txt');
	});

	test('bash rm -rf removes nested directory tree', async () => {
		const bash = setupBash();
		await bash.exec('mkdir -p /dir/sub');
		await bash.exec('echo "x" > /dir/sub/file.txt');
		await bash.exec('rm -rf /dir');
		const result = await bash.exec('ls /');
		expect(result.stdout.trim()).toBe('');
	});

	test('bash mv renames file and preserves content', async () => {
		const bash = setupBash();
		await bash.exec('echo "content" > /old.txt');
		await bash.exec('mv /old.txt /new.txt');
		const result = await bash.exec('cat /new.txt');
		expect(result.stdout.trim()).toBe('content');
	});

	test('bash cp duplicates file content', async () => {
		const bash = setupBash();
		await bash.exec('echo "content" > /src.txt');
		await bash.exec('cp /src.txt /dest.txt');
		const result = await bash.exec('cat /dest.txt');
		expect(result.stdout.trim()).toBe('content');
	});

	test('bash wc -l reports the expected line count', async () => {
		const bash = setupBash();
		await bash.exec('printf "line1\\nline2\\nline3\\n" > /file.txt');
		const result = await bash.exec('wc -l /file.txt');
		expect(result.stdout.trim()).toContain('3');
	});
});

describe('document integration', () => {
	test('hard row deletion triggers automatic content doc cleanup', async () => {
		const { fs, ws } = setup();
		const documents = ws.documents.files.content;

		// Write a file to create both the row and the content doc
		await fs.writeFile('/test.txt', 'hello world');
		const fileId = fs.lookupId('/test.txt');
		expect(fileId).toBeDefined();
		if (!fileId) throw new Error('Expected /test.txt to exist');

		// Open the content doc — should get a handle
		const handle1 = await documents.open(fileId);
		expect(handle1.ydoc.guid).toBe(fileId);

		// Hard-delete the row directly from the table.
		// The documents manager's table observer should automatically close the content doc.
		ws.tables.files.delete(fileId);

		// Re-opening should create a FRESH Y.Doc (different instance)
		// because the documents manager's row-deletion observer called close()
		const handle2 = await documents.open(fileId);
		expect(handle2.ydoc).not.toBe(handle1.ydoc);
	});
});
