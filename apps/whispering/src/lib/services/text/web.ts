import { Ok, tryAsync } from 'wellcrafted/result';
import type { TextService } from './types';
import { TextServiceErr } from './types';

export function createTextServiceWeb(): TextService {
	return {
		readFromClipboard: () =>
			tryAsync({
				try: async () => {
					const text = await navigator.clipboard.readText();
					return text || null;
				},
				catch: (error) =>
					TextServiceErr({
						message:
							'There was an error reading from the clipboard using the browser Clipboard API. Please try again.',
						context: {},
						cause: error,
					}),
			}),

		copyToClipboard: async (text) => {
			const { error: copyError } = await tryAsync({
				try: () => navigator.clipboard.writeText(text),
				catch: (error) =>
					TextServiceErr({
						message:
							'There was an error copying to the clipboard using the browser Clipboard API. Please try again.',
						context: { text },
						cause: error,
					}),
			});

			if (copyError) {
				// Extension fallback code commented out for now
				// Could be re-enabled if extension support is needed
				return Ok(undefined);
			}
			return Ok(undefined);
		},

		writeToCursor: async (text) => {
			// In web browsers, we cannot programmatically paste for security reasons
			// We can copy the text to clipboard but the user must manually paste with Cmd/Ctrl+V
			await navigator.clipboard.writeText(text);
			return TextServiceErr({
				message:
					'Text copied to clipboard. Automatic paste is not supported in web browsers for security reasons. Please paste manually using Cmd/Ctrl+V.',
				context: { text },
				cause: undefined,
			});
		},
	};
}
