import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ParseInputOptions, parseJsonInput } from './parse-input.js';

describe('parseJsonInput', () => {
	let tempDir: string;

	beforeAll(() => {
		tempDir = mkdtempSync(join(tmpdir(), 'parse-input-test-'));
	});

	afterAll(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it('parses inline JSON', () => {
		const options: ParseInputOptions = {
			positional: '{"id":"1","name":"test"}',
		};

		const result = parseJsonInput<{ id: string; name: string }>(options);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.data).toEqual({ id: '1', name: 'test' });
		}
	});

	it('reads @file shorthand', () => {
		const filePath = join(tempDir, 'test.json');
		writeFileSync(filePath, '{"id":"2","value":42}');

		const options: ParseInputOptions = {
			positional: `@${filePath}`,
		};

		const result = parseJsonInput<{ id: string; value: number }>(options);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.data).toEqual({ id: '2', value: 42 });
		}
	});

	it('reads --file flag', () => {
		const filePath = join(tempDir, 'file-flag.json');
		writeFileSync(filePath, '{"source":"file-flag"}');

		const options: ParseInputOptions = {
			file: filePath,
		};

		const result = parseJsonInput<{ source: string }>(options);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.data).toEqual({ source: 'file-flag' });
		}
	});

	it('reads stdin content', () => {
		const options: ParseInputOptions = {
			hasStdin: true,
			stdinContent: '{"from":"stdin"}',
		};

		const result = parseJsonInput<{ from: string }>(options);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.data).toEqual({ from: 'stdin' });
		}
	});

	it('returns error for invalid JSON', () => {
		const options: ParseInputOptions = {
			positional: '{invalid json}',
		};

		const result = parseJsonInput(options);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain('Invalid JSON');
		}
	});

	it('returns error for missing file', () => {
		const options: ParseInputOptions = {
			positional: '@/nonexistent/path/file.json',
		};

		const result = parseJsonInput(options);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain('File not found');
		}
	});

	it('returns error when no input provided', () => {
		const options: ParseInputOptions = {};

		const result = parseJsonInput(options);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain('No input provided');
		}
	});

	it('prioritizes positional over --file', () => {
		const filePath = join(tempDir, 'should-not-read.json');
		writeFileSync(filePath, '{"source":"file"}');

		const options: ParseInputOptions = {
			positional: '{"source":"positional"}',
			file: filePath,
		};

		const result = parseJsonInput<{ source: string }>(options);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.data.source).toBe('positional');
		}
	});

	it('prioritizes --file over stdin', () => {
		const filePath = join(tempDir, 'file-priority.json');
		writeFileSync(filePath, '{"source":"file"}');

		const options: ParseInputOptions = {
			file: filePath,
			hasStdin: true,
			stdinContent: '{"source":"stdin"}',
		};

		const result = parseJsonInput<{ source: string }>(options);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.data.source).toBe('file');
		}
	});
});
