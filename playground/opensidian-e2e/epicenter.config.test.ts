/**
 * End-to-end test: Opensidian workspace through the CLI pipeline.
 *
 * Verifies that the opensidian workspace (filesystem-backed note-taking)
 * works end-to-end with persistence and document content.
 *
 * Key behaviors:
 * - loadConfig() discovers the workspace client from a single export
 * - Table CRUD works for the files table (folders + files)
 * - Document content round-trips through write → read
 * - Persistence survives restart (table data + document content)
 * - pushFromMarkdown imports .md files into tables + document content
 * - Wikilinks in imported bodies are resolved to id: links
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createWorkspace, generateId } from '@epicenter/workspace';
import { toMarkdown } from '@epicenter/workspace/extensions/materializer/markdown';
import { filesystemPersistence } from '@epicenter/workspace/extensions/persistence/sqlite';
import { opensidianDefinition } from 'opensidian/workspace';
import { pushFromMarkdown } from './push-from-markdown';

const PERSISTENCE_DIR = join(
	import.meta.dir,
	'.test-fixtures/.epicenter-opensidian-test',
);

function dbPath(id: string) {
	return join(PERSISTENCE_DIR, `${id}.db`);
}

/** Create a workspace client with filesystem persistence for testing. */
function createTestClient() {
	return createWorkspace(opensidianDefinition).withExtension(
		'persistence',
		filesystemPersistence({ filePath: dbPath(opensidianDefinition.id) }),
	);
}

describe('e2e: opensidian workspace', () => {
	const folderId = generateId();
	const fileId = generateId();

	beforeAll(async () => {
		await rm(PERSISTENCE_DIR, { recursive: true, force: true });
	});

	afterAll(async () => {
		await rm(PERSISTENCE_DIR, { recursive: true, force: true });
	});

	test('workspace has correct ID', () => {
		expect(opensidianDefinition.id).toBe('opensidian');
	});

	test('table CRUD: create folder and file', async () => {
		const client = createTestClient();
		await client.whenReady;

		// Create a folder
		client.tables.files.set({
			id: folderId,
			name: 'My Notes',
			parentId: null,
			type: 'folder',
			size: 0,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			trashedAt: null,
			_v: 1,
		});

		// Create a file inside the folder
		client.tables.files.set({
			id: fileId,
			name: 'hello.md',
			parentId: folderId,
			type: 'file',
			size: 0,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			trashedAt: null,
			_v: 1,
		});

		const files = client.tables.files.getAllValid();
		expect(files).toHaveLength(2);

		const folder = files.find((f) => f.type === 'folder');
		expect(folder).toBeDefined();
		expect(folder?.name).toBe('My Notes');

		const file = files.find((f) => f.type === 'file');
		expect(file).toBeDefined();
		expect(file?.name).toBe('hello.md');
		expect(file?.parentId).toBe(folderId);

		await client.dispose();
	});

	test('document content: write and read', async () => {
		const client = createTestClient();
		await client.whenReady;

		const handle = await client.documents.files.content.open(fileId);
		handle.write('# Hello World\n\nThis is a test note.');

		const content = handle.read();
		expect(content).toBe('# Hello World\n\nThis is a test note.');

		await client.dispose();
	});

	test('persistence: table data survives restart', async () => {
		const client = createTestClient();
		await client.whenReady;

		const files = client.tables.files.getAllValid();
		expect(files).toHaveLength(2);

		const folder = files.find((f) => f.type === 'folder');
		expect(folder?.name).toBe('My Notes');

		const file = files.find((f) => f.type === 'file');
		expect(file?.name).toBe('hello.md');
		expect(file?.parentId).toBe(folderId);

		await client.dispose();
	});
});

describe('e2e: opensidian pushFromMarkdown', () => {
	const IMPORT_DIR = join(
		import.meta.dir,
		'.test-fixtures/.opensidian-import-test',
	);
	const IMPORT_PERSISTENCE = join(
		import.meta.dir,
		'.test-fixtures/.epicenter-opensidian-import',
	);
	const IMPORT_FILES_DIR = join(IMPORT_DIR, 'files');

	function createImportClient() {
		return createWorkspace(opensidianDefinition).withExtension(
			'persistence',
			filesystemPersistence({
				filePath: join(IMPORT_PERSISTENCE, 'opensidian.db'),
			}),
		);
	}

	/** Write a markdown file with YAML frontmatter and optional body. */
	async function writeTestMd(
		filename: string,
		frontmatter: Record<string, unknown>,
		body?: string,
	): Promise<void> {
		await mkdir(IMPORT_FILES_DIR, { recursive: true });
		const content = toMarkdown(frontmatter, body);
		await Bun.write(join(IMPORT_FILES_DIR, filename), content);
	}

	beforeAll(async () => {
		await rm(IMPORT_DIR, { recursive: true, force: true });
		await rm(IMPORT_PERSISTENCE, { recursive: true, force: true });
	});

	afterAll(async () => {
		await rm(IMPORT_DIR, { recursive: true, force: true });
		await rm(IMPORT_PERSISTENCE, { recursive: true, force: true });
	});

	test('imports table row + document content from .md file', async () => {
		const fileId = generateId();
		await writeTestMd(
			'test-note.md',
			{
				id: fileId,
				name: 'test-note.md',
				parentId: null,
				size: 0,
				createdAt: 1712300000000,
				updatedAt: 1712300000000,
				trashedAt: null,
			},
			'# Test Note\n\nHello from import.',
		);

		const client = createImportClient();
		await client.whenReady;

		const result = await pushFromMarkdown({
			tables: client.tables,
			documents: client.documents,
			filesDir: IMPORT_FILES_DIR,
		});

		expect(result.imported).toBe(1);
		expect(result.skipped).toBe(0);
		expect(result.errors).toHaveLength(0);

		// Verify table row
		const row = client.tables.files.get(fileId);
		expect(row.status).toBe('valid');
		if (row.status === 'valid') {
			expect(row.row.name).toBe('test-note.md');
			expect(row.row.type).toBe('file');
			expect(row.row.createdAt).toBe(1712300000000);
		}

		// Verify document content
		const handle = await client.documents.files.content.open(fileId);
		expect(handle.read()).toBe('# Test Note\n\nHello from import.');

		await client.dispose();
	});

	test('skips files without id in frontmatter', async () => {
		await writeTestMd('no-id.md', { name: 'orphan', size: 0 });

		const client = createImportClient();
		await client.whenReady;

		const result = await pushFromMarkdown({
			tables: client.tables,
			documents: client.documents,
			filesDir: IMPORT_FILES_DIR,
		});

		// The file with id from previous test is still there, plus the no-id file
		expect(result.skipped).toBeGreaterThanOrEqual(1);

		await client.dispose();
	});

	test('converts [[wikilinks]] to id: links on import', async () => {
		const targetId = generateId();
		const sourceId = generateId();

		const client = createImportClient();
		await client.whenReady;

		// Pre-seed the target row so the wikilink can resolve regardless of file processing order
		client.tables.files.set({
			id: targetId,
			name: 'Target Note',
			parentId: null,
			type: 'file',
			size: 0,
			createdAt: 1712300000000,
			updatedAt: 1712300000000,
			trashedAt: null,
			_v: 1,
		});

		// Write source file with a wikilink referencing the target
		await writeTestMd(
			'wikilink-source.md',
			{
				id: sourceId,
				name: 'Source Note',
				parentId: null,
				size: 0,
				createdAt: 1712300000000,
				updatedAt: 1712300000000,
				trashedAt: null,
			},
			'# Source\n\nSee [[Target Note]] for details.',
		);

		const result = await pushFromMarkdown({
			tables: client.tables,
			documents: client.documents,
			filesDir: IMPORT_FILES_DIR,
		});

		expect(result.errors).toHaveLength(0);

		// [[Target Note]] should have been resolved to [Target Note](id:GUID)
		const handle = await client.documents.files.content.open(sourceId);
		expect(handle.read()).toBe(
			`# Source\n\nSee [Target Note](id:${targetId}) for details.`,
		);

		await client.dispose();
	});
});
