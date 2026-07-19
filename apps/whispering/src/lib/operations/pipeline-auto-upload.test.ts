/**
 * Recording Pipeline Auto-Upload Tests
 *
 * Verifies the intentionally small automatic policy at the row-creation seam.
 *
 * Key behaviors:
 * - An enabled setting attempts the same upload operation exactly once
 * - A disabled setting performs no upload
 * - Upload remains best-effort and does not block transcription
 */
import { expect, mock, test } from 'bun:test';
import { generateBlobId } from '@epicenter/blobs';
import { Ok } from 'wellcrafted/result';
import type { RecordingId } from '$lib/workspace';

let autoUpload = true;
let createError: unknown = null;
const uploadRecordingAudio = mock(async () => Ok(undefined));
const deleteBlob = mock(async () => Ok(undefined));

mock.module('$lib/operations/recording-audio', () => ({
	uploadRecordingAudio,
}));
mock.module('$lib/operations/delivery', () => ({
	deliverTranscriptionResult: async () => ({
		outcome: { reach: 'output' },
		notice: { title: 'done' },
	}),
}));
mock.module('$lib/operations/run-polish', () => ({
	polishWillRun: () => false,
	runPolish: async ({ input }: { input: string }) => Ok(input),
}));
mock.module('$lib/operations/sound', () => ({
	sound: { playSoundIfEnabled: mock() },
}));
mock.module('$lib/operations/transcribe', () => ({
	transcribeAndPersist: async () => Ok('transcript'),
}));
mock.module('$lib/report', () => ({
	report: {
		info: mock(),
		error: mock(),
		loading: () => ({ resolve: mock(), reject: mock() }),
	},
}));
mock.module('$lib/services', () => ({
	services: { blobs: { delete: deleteBlob } },
}));
mock.module('$lib/state/dictation-lifecycle.svelte', () => ({
	dictationLifecycle: {
		markTranscribing: mock(),
		markFailed: mock(),
		markPolishing: mock(),
		markDelivered: mock(),
	},
}));
mock.module('$lib/state/polish-hud.svelte', () => ({
	polishHud: { begin: mock(), end: mock() },
}));
mock.module('$lib/state/recordings.svelte', () => ({
	recordings: {
		async create(fields: Record<string, unknown>) {
			if (createError !== null) throw createError;
			return { ...fields, id: 'recording-1' as RecordingId };
		},
		update: mock(async () => Ok(undefined)),
	},
}));
mock.module('$lib/state/settings.svelte', () => ({
	settings: { get: () => autoUpload },
}));

const { processRecordingPipeline } = await import('./pipeline.js');

test('auto-upload attempts once for each new row only when enabled', async () => {
	await processRecordingPipeline({
		audioBlobId: generateBlobId(),
		durationMs: 100,
		deliverySource: 'import',
	});
	await Promise.resolve();
	expect(uploadRecordingAudio).toHaveBeenCalledTimes(1);

	autoUpload = false;
	await processRecordingPipeline({
		audioBlobId: generateBlobId(),
		durationMs: 100,
		deliverySource: 'import',
	});
	await Promise.resolve();
	expect(uploadRecordingAudio).toHaveBeenCalledTimes(1);
});

test('a failed row creation removes the already-finalized local blob', async () => {
	const cause = new Error('row rejected');
	createError = cause;
	const audioBlobId = generateBlobId();

	await expect(
		processRecordingPipeline({
			audioBlobId,
			durationMs: 100,
			deliverySource: 'import',
		}),
	).rejects.toBe(cause);
	expect(deleteBlob).toHaveBeenLastCalledWith(audioBlobId);
	createError = null;
});
