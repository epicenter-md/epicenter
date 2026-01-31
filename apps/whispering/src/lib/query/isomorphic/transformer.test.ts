import { describe, expect, it } from 'bun:test';
import { applySimplePunctuation } from './transformation-logic';

describe('applySimplePunctuation', () => {
	it('should handle simple punctuation replacement', () => {
		const inputs = [
			{
				input: 'Hello comma world',
				expected: 'Hello, world',
			},
			{
				input: 'This is a period',
				expected: 'This is a.',
			},
			{
				input: 'Question mark at start',
				expected: '? at start',
			},
			{
				input: 'Line one new line Line two',
				expected: 'Line one\n Line two',
			},
			{
				input: 'Capitalized Period works',
				expected: 'Capitalized. works',
			},
			{
				input: 'Multiple  spaces   comma handled',
				expected: 'Multiple  spaces, handled',
			},
			{
				input: 'No punctuation here',
				expected: 'No punctuation here',
			}
		];

		for (const { input, expected } of inputs) {
			const result = applySimplePunctuation(input);
			expect(result).toBe(expected);
		}
	});
});
