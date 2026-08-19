/**
 * Transcription query integration tests.
 *
 * Verifies single and bulk manual transcription continue from exact raw
 * persistence through deterministic finalization without introducing Polish.
 *
 * Key behaviors:
 * - Single retry returns transformed text and finalizes delivered history
 * - Bulk transcription applies the same operation independently to every row
 * - The query adapter does not call any AI Polish operation
 */
import { expect, mock, test } from 'bun:test';
import { Ok } from 'wellcrafted/result';
import type { Recording } from '$lib/state/recordings.svelte';

const transcribeAndPersist = mock(async () =>
	Ok({ text: 'raw', history: Ok(undefined) }),
);
const processTranscript = mock(
	(_app: unknown, input: { text: string; final: boolean }) => ({
		text: `${input.text} transformed`,
		history: Ok(undefined),
	}),
);
mock.module('$lib/operations/transcribe', () => ({ transcribeAndPersist }));
mock.module('$lib/operations/process-transcript', () => ({
	processTranscript,
}));

const { createTranscriptionQueries } = await import('./transcription.js');
type WhisperingApp = import('$lib/whispering/app').WhisperingApp;
type WhisperingQueryRuntime =
	import('$lib/queries/client').WhisperingQueryRuntime;

function recording(id: string): Recording {
	return {
		id,
		audioBlobId: `blob_${'a'.repeat(21)}`,
	} as Recording;
}

function runtime(): WhisperingQueryRuntime {
	return {
		defineMutation(definition: {
			mutationFn: (input: Recording) => Promise<unknown>;
		}) {
			return Object.assign((input: Recording) => definition.mutationFn(input), {
				options: definition,
			});
		},
		queryClient: { isMutating: () => 0 },
	} as unknown as WhisperingQueryRuntime;
}

const app = {} as WhisperingApp;

test('single manual transcription finalizes deterministic output', async () => {
	const queries = createTranscriptionQueries(app, runtime());
	const result = await queries.transcribeRecording(recording('one'));
	expect(result).toEqual(
		Ok({ text: 'raw transformed', history: Ok(undefined) }),
	);
	expect(processTranscript).toHaveBeenLastCalledWith(
		app,
		expect.objectContaining({
			recordingId: 'one',
			text: 'raw',
			final: true,
		}),
	);
});

test('bulk manual transcription finalizes every recording', async () => {
	const queries = createTranscriptionQueries(app, runtime());
	const callsBefore = processTranscript.mock.calls.length;
	const result = await queries.transcribeRecordings([
		recording('one'),
		recording('two'),
	]);
	expect(result.error).toBeNull();
	expect(result.data?.oks).toHaveLength(2);
	expect(result.data?.errs).toEqual([]);
	expect(processTranscript).toHaveBeenCalledTimes(callsBefore + 2);
	expect(transcribeAndPersist).toHaveBeenCalledWith(
		app,
		'two',
		expect.any(String),
	);
});
