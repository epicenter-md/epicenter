/**
 * @fileoverview What `epicenter.transcription` sends, and how it turns the
 * host's readiness answer into a capability answer.
 */

import { afterEach, expect, test } from 'bun:test';
import { epicenter } from './index.js';

type Call = { command: string; args: unknown };
type Answer = { ok: unknown } | { reject: unknown };

const globals = globalThis as { window?: unknown };

function installHost(...answers: Answer[]) {
	const calls: Call[] = [];
	const queued = [...answers];
	globals.window = {
		__TAURI_INTERNALS__: {
			invoke: (command: string, args: unknown) => {
				calls.push({ command, args });
				const answer = queued.shift() ?? { ok: null };
				return 'ok' in answer
					? Promise.resolve(answer.ok)
					: Promise.reject(answer.reject);
			},
			transformCallback: () => 1,
		},
	};
	return calls;
}

afterEach(() => {
	delete globals.window;
});

test('capabilities reports what the route accepts', async () => {
	installHost({
		ok: { status: 'ready', supportsPrompt: true, supportsLanguage: false },
	});

	const { data, error } = await epicenter.transcription.capabilities();

	expect(error).toBeNull();
	expect(data).toEqual({ supportsPrompt: true, supportsLanguage: false });
});

// The host answers this read successfully either way, which is the difference
// between "the query worked" and "the capability is usable". Only the second is
// what the caller asked about, so an unusable route is a typed failure here.
test('an unusable route is a failure of the capability, not a successful answer', async () => {
	installHost({
		ok: {
			status: 'unavailable',
			reason: 'no-active-model',
			message: 'Choose a transcription model in Epicenter Home.',
		},
	});

	const { data, error } = await epicenter.transcription.capabilities();

	expect(data).toBeNull();
	expect(error?.name).toBe('TranscriptionUnavailable');
	expect(error).toMatchObject({ reason: 'no-active-model' });
	expect(error?.message).toBe(
		'Choose a transcription model in Epicenter Home.',
	);
});

test('transcribe names audio and hints, never a model', async () => {
	const calls = installHost({
		ok: {
			outcome: 'transcribed',
			text: 'hello there',
			modelId: 'whisper-large-v3-turbo',
			applied: { language: 'en', initialPrompt: false },
		},
	});

	const { data, error } = await epicenter.transcription.transcribe('blob_one', {
		language: 'en',
	});

	expect(error).toBeNull();
	expect(data).toEqual({
		outcome: 'transcribed',
		text: 'hello there',
		modelId: 'whisper-large-v3-turbo',
		applied: { language: 'en', initialPrompt: false },
	});
	expect(calls).toEqual([
		{
			command: 'transcribe_recording',
			args: {
				audioBlobId: 'blob_one',
				hints: { language: 'en', initialPrompt: null },
			},
		},
	]);
});

// Silence is not a failure. Turning it into one would teach every caller to
// treat a quiet recording as something that went wrong.
test('empty audio is an outcome, not an error', async () => {
	installHost({ ok: { outcome: 'empty-audio' } });

	const { data, error } = await epicenter.transcription.transcribe('blob_one');

	expect(error).toBeNull();
	expect(data).toEqual({ outcome: 'empty-audio' });
});

test('an unusable route fails the same way at transcribe time', async () => {
	installHost({
		reject: {
			name: 'LocalRouteUnavailable',
			reason: 'active-model-unavailable',
			message: 'The active model is not on this machine.',
		},
	});

	const { error } = await epicenter.transcription.transcribe('blob_one');

	expect(error?.name).toBe('TranscriptionUnavailable');
	expect(error).toMatchObject({ reason: 'active-model-unavailable' });
});

// Kept apart from unavailability so a broken install does not read to the user
// as "you have not set this up yet".
test('a model that will not load is a failure, not unavailability', async () => {
	installHost({
		reject: { name: 'ModelLoadError', message: 'backend init failed' },
	});

	const { error } = await epicenter.transcription.transcribe('blob_one');

	expect(error?.name).toBe('ModelLoadFailed');
});

test('unreadable audio names the recording that could not be read', async () => {
	installHost({
		reject: { name: 'AudioReadError', message: 'no such blob' },
	});

	const { error } = await epicenter.transcription.transcribe('blob_missing');

	expect(error?.name).toBe('AudioUnreadable');
	expect(error).toMatchObject({ audioBlobId: 'blob_missing' });
});

test('prewarm asks the host and reports nothing', () => {
	const calls = installHost({ ok: null });

	const outcome = epicenter.transcription.prewarm();

	expect(outcome).toBeUndefined();
	expect(calls).toEqual([{ command: 'prewarm_model', args: {} }]);
});
