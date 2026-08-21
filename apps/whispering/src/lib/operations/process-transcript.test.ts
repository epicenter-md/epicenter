/**
 * Transcript processing boundary tests.
 *
 * Verifies deterministic processing after raw persistence and the distinction
 * between an intermediate value headed to Polish and a final value headed to
 * recording history.
 *
 * Key behaviors:
 * - Empty pipelines are identity operations
 * - Final manual processing stores transformed text without AI
 * - Failed groups are reported while later groups and persistence continue
 */
import { expect, mock, test } from 'bun:test';
import { Err, Ok } from 'wellcrafted/result';
import type { Recording } from '$lib/whispering/recording';
import type { RecordingId } from '$lib/workspace';
import type { RunnableTransformation } from './run-transformations';
import type { TranscriptionSuccess } from './transcription-history';

const reportInfo = mock();
mock.module('$lib/report', () => ({
	report: { info: reportInfo },
}));

const { processTranscript } = await import('./process-transcript.js');
type WhisperingApp = import('$lib/whispering/app').WhisperingApp;

// SAFETY: processTranscript reads only the recording id from this fixture.
const recording = { id: 'recording-1' } as Recording;
const patch = mock(() => recording);

function transformation(
	id: string,
	{
		position = 0,
		find = 'raw',
		replace = 'transformed',
		useRegex = false,
	}: {
		position?: number;
		find?: string;
		replace?: string;
		useRegex?: boolean;
	} = {},
): RunnableTransformation {
	return {
		id,
		name: id,
		description: '',
		enabled: true,
		position,
		steps: [
			{
				id: `${id}-step`,
				transformationId: id,
				position: 0,
				kind: 'find_replace',
				find,
				replace,
				useRegex,
			},
		],
	};
}

function appWith(transformations: RunnableTransformation[]): WhisperingApp {
	// SAFETY: processTranscript uses only the domains assigned to this fixture.
	const app = {} as WhisperingApp;
	return Object.assign(app, {
		transformations: { sorted: transformations },
		recordings: { patch },
	});
}

test('an empty intermediate pipeline preserves text and existing history', () => {
	const history = Ok(undefined);
	const result = processTranscript(appWith([]), {
		recordingId: 'recording-1',
		text: 'raw',
		history,
		final: false,
	});
	expect(result).toEqual({ text: 'raw', history });
	expect(patch).not.toHaveBeenCalled();
});

test('final processing stores transformed text without replacing an earlier warning', () => {
	patch.mockImplementationOnce(() => recording);
	const priorHistory: TranscriptionSuccess['history'] = Err({
		name: 'SaveUnconfirmed',
		message: 'Raw history was not confirmed.',
		// SAFETY: this stable fixture id represents the recording used by this test.
		recordingId: 'recording-1' as RecordingId,
		cause: new Error('raw write'),
	});
	const result = processTranscript(appWith([transformation('cleanup')]), {
		recordingId: 'recording-1',
		text: 'raw text',
		history: priorHistory,
		final: true,
	});
	expect(result.text).toBe('transformed text');
	expect(result.history).toBe(priorHistory);
	expect(patch).toHaveBeenLastCalledWith('recording-1', {
		deliveredTranscript: 'transformed text',
	});
});

test('a failed group is reported while later processing and persistence continue', () => {
	patch.mockImplementationOnce(() => recording);
	const noticesBefore = reportInfo.mock.calls.length;
	const result = processTranscript(
		appWith([
			transformation('broken', { position: 0, find: '[', useRegex: true }),
			transformation('later', { position: 1, replace: 'later' }),
		]),
		{
			recordingId: 'recording-1',
			text: 'raw',
			history: Ok(undefined),
			final: true,
		},
	);
	expect(result.text).toBe('later');
	expect(patch).toHaveBeenLastCalledWith('recording-1', {
		deliveredTranscript: 'later',
	});
	expect(reportInfo).toHaveBeenCalledTimes(noticesBefore + 1);
	expect(reportInfo).toHaveBeenLastCalledWith({
		title: 'Transformation skipped: broken',
		description: expect.stringContaining('Step 1:'),
	});
});

test('a refused final write becomes the returned history warning', () => {
	patch.mockImplementationOnce(() => {
		throw new Error('store refused final text');
	});
	const result = processTranscript(appWith([]), {
		recordingId: 'recording-1',
		text: 'raw',
		history: Ok(undefined),
		final: true,
	});
	expect(result.text).toBe('raw');
	expect(result.history.error).toMatchObject({ name: 'SaveUnconfirmed' });
});
