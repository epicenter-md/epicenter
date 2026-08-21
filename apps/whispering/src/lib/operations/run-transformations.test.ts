/**
 * Deterministic Transformation executor tests.
 *
 * Verifies ordered local step execution and atomic group composition without any
 * workspace, network, UI, or history dependency.
 *
 * Key behaviors:
 * - Literal, regex, and Spoken URLs steps run globally in stable order
 * - Disabled groups are skipped and equal positions use row-id tie-breakers
 * - A failed group contributes no partial output and later groups still run
 */
import { expect, test } from 'bun:test';
import type { TransformationStep } from '../workspace';
import {
	executeTransformation,
	type RunnableTransformation,
	runTransformations,
} from './run-transformations';

function step(
	id: string,
	overrides: Partial<TransformationStep> = {},
): TransformationStep {
	return {
		id,
		transformationId: 'transformation',
		position: 0,
		kind: 'find_replace',
		find: 'before',
		replace: 'after',
		useRegex: false,
		...overrides,
	};
}

function transformation(
	id: string,
	overrides: Partial<RunnableTransformation> = {},
): RunnableTransformation {
	return {
		id,
		name: id,
		description: '',
		enabled: true,
		position: 0,
		steps: [],
		...overrides,
	};
}

test('literal replacement applies globally and preserves unmatched case', () => {
	const result = executeTransformation(
		'before Before before',
		transformation('literal', {
			steps: [step('literal-step', { replace: 'after' })],
		}),
	);
	expect(result).toEqual({ text: 'after Before after', failure: null });
});

test('regex replacement compiles globally', () => {
	const result = executeTransformation(
		'cat cot cut',
		transformation('regex', {
			steps: [
				step('regex-step', {
					find: 'c.t',
					replace: 'pet',
					useRegex: true,
				}),
			],
		}),
	);
	expect(result.text).toBe('pet pet pet');
});

test('step order changes output predictably', () => {
	const forward = transformation('ordered', {
		steps: [
			step('first', { position: 0, find: 'a', replace: 'b' }),
			step('second', { position: 1, find: 'b', replace: 'c' }),
		],
	});
	const reversed = transformation('reversed', {
		steps: forward.steps.map((candidate) => ({
			...candidate,
			position: 1 - candidate.position,
		})),
	});
	expect(executeTransformation('a', forward).text).toBe('c');
	expect(executeTransformation('a', reversed).text).toBe('b');
});

test('Transformation order composes enabled groups and skips disabled groups', () => {
	const result = runTransformations('a', [
		transformation('last', {
			position: 2,
			steps: [step('last-step', { find: 'b', replace: 'c' })],
		}),
		transformation('disabled', {
			position: 1,
			enabled: false,
			steps: [step('disabled-step', { find: 'b', replace: 'wrong' })],
		}),
		transformation('first', {
			position: 0,
			steps: [step('first-step', { find: 'a', replace: 'b' })],
		}),
	]);
	expect(result).toEqual({ text: 'c', failures: [] });
});

test('equal positions use row id at both ordering levels', () => {
	const tiedSteps = transformation('tied-steps', {
		steps: [
			step('b', { find: 'a', replace: 'b' }),
			step('a', { find: 'b', replace: 'c' }),
		],
	});
	// Step "a" runs first by id and cannot see b yet; step "b" then produces b.
	const firstGroup = transformation('b', {
		steps: [step('group-b', { find: 'b', replace: 'd' })],
	});
	const secondGroup = transformation('a', { steps: tiedSteps.steps });
	// Group "a" runs before group "b", so b then becomes d.
	expect(runTransformations('a', [firstGroup, secondGroup]).text).toBe('d');
});

test('a failed Transformation is atomic and later groups continue', () => {
	const failed = transformation('broken', {
		name: 'Broken regex',
		position: 0,
		steps: [
			step('partial', { position: 5, find: 'a', replace: 'b' }),
			step('invalid', { position: 12, find: '[', useRegex: true }),
		],
	});
	const later = transformation('later', {
		position: 1,
		steps: [step('later-step', { find: 'a', replace: 'z' })],
	});
	const result = runTransformations('a', [failed, later]);
	expect(result.text).toBe('z');
	expect(result.failures).toHaveLength(1);
	expect(result.failures[0]).toMatchObject({
		transformationId: 'broken',
		transformationName: 'Broken regex',
		stepId: 'invalid',
		stepIndex: 1,
	});
});

test('Spoken URLs is an explicit executor step', () => {
	const result = executeTransformation(
		'HTTPS colon slash slash Docs dot Example dot com slash API',
		transformation('urls', {
			steps: [
				step('urls-step', {
					kind: 'spoken_urls',
					find: '',
					replace: '',
				}),
			],
		}),
	);
	expect(result.text).toBe('https://docs.example.com/API');
});
