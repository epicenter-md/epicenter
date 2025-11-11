import * as services from '$lib/services';
import { defineMutation, defineQuery } from './_client';

const textKeys = {
	clipboard: ['text', 'clipboard'] as const,
	readFromClipboard: ['text', 'readFromClipboard'] as const,
	copyToClipboard: ['text', 'copyToClipboard'] as const,
	writeToCursor: ['text', 'writeToCursor'] as const,
} as const;

export const text = {
	readFromClipboard: defineQuery({
		queryKey: textKeys.readFromClipboard,
		resultQueryFn: () => services.text.readFromClipboard(),
	}),
	copyToClipboard: defineMutation({
		mutationKey: ['text', 'copyToClipboard'],
		resultMutationFn: ({ text }: { text: string }) =>
			services.text.copyToClipboard(text),
	}),
	writeToCursor: defineMutation({
		mutationKey: ['text', 'writeToCursor'],
		resultMutationFn: async ({ text }: { text: string }) => {
			// writeToCursor handles everything internally:
			// 1. Saves current clipboard
			// 2. Writes text to clipboard
			// 3. Simulates paste
			// 4. Restores original clipboard
			return await services.text.writeToCursor(text);
		},
	}),
};
