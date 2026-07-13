import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

describe('transcription build boundary', () => {
	test('browser transcription has no native engine dependency', () => {
		const source = read('src/lib/operations/transcribe.browser.ts');
		expect(source).not.toContain('#desktop');
		expect(source).not.toContain('DesktopLocalTranscription');
		expect(source).not.toContain('localTranscription');
	});

	test('Epicenter transcription has no remote transport dependency', () => {
		const source = read('src/lib/operations/transcribe.epicenter.ts');
		expect(source).not.toContain('services/http');
		expect(source).not.toContain('services/transcription/cloud');
		expect(source).not.toContain('@epicenter/client');
	});

	test('each composition root selects exactly one engine', () => {
		expect(read('src/lib/runtime/browser.ts')).toContain(
			'createBrowserTranscription',
		);
		expect(read('src/lib/runtime/browser.ts')).not.toContain(
			'createEpicenterTranscription',
		);
		expect(read('src/lib/runtime/epicenter.ts')).toContain(
			'createEpicenterTranscription',
		);
		expect(read('src/lib/runtime/epicenter.ts')).not.toContain(
			'createBrowserTranscription',
		);
	});

	test('one selected runtime owns workspace and environment construction', () => {
		const packageJson = read('package.json');
		expect(packageJson).toContain('"#runtime"');
		expect(packageJson).not.toContain('"#environment-base"');
		expect(packageJson).not.toContain('"#environment"');
		expect(read('src/lib/runtime/browser.ts')).toContain(
			'export const whispering',
		);
		expect(read('src/lib/runtime/epicenter.ts')).toContain(
			'export const whispering',
		);
	});

	test('runtime dependencies cannot import runtime-backed state singletons', () => {
		for (const path of [
			'src/lib/operations/transcribe.browser.ts',
			'src/lib/operations/transcribe.epicenter.ts',
			'src/lib/operations/transcription-use-case.ts',
		]) {
			const source = read(path);
			expect(source).not.toContain('#runtime');
			expect(source).not.toContain('state/settings.svelte');
			expect(source).not.toContain('state/recordings.svelte');
		}
	});
});
