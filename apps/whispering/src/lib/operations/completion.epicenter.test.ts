import { describe, expect, test } from 'bun:test';
import {
	completeWithGlobalDefault,
	resolveCompletionState,
} from './completion.epicenter';

describe('Epicenter completion refusal', () => {
	test('reports unavailable before a pipeline attempts completion', () => {
		expect(resolveCompletionState()).toEqual({
			target: null,
			canRun: false,
			textStaysOnDevice: true,
		});
	});

	test('returns a typed transport failure if called directly', async () => {
		const result = await completeWithGlobalDefault({
			systemPrompt: 'system',
			userPrompt: 'user',
		});
		expect(result.error?.name).toBe('TransportFailed');
	});
});
