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
		expect(read('src/lib/environment/browser.ts')).toContain(
			'createBrowserTranscription',
		);
		expect(read('src/lib/environment/browser.ts')).not.toContain(
			'createEpicenterTranscription',
		);
		expect(read('src/lib/environment/epicenter.ts')).toContain(
			'createEpicenterTranscription',
		);
		expect(read('src/lib/environment/epicenter.ts')).not.toContain(
			'createBrowserTranscription',
		);
	});
});
