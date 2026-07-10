import { Err, Ok, tryAsync } from 'wellcrafted/result';
import type { TextService } from './types';
import { TextError } from './types';

export type { TextError, TextService } from './types';

export const TextServiceLive = {
	readFromClipboard: () =>
		tryAsync({
			try: async () => {
				const text = await navigator.clipboard.readText();
				return text || null;
			},
			catch: (error) => TextError.ClipboardRead({ cause: error }),
		}),

	copyToClipboard: async (text) => {
		const { error: copyError } = await tryAsync({
			try: () => navigator.clipboard.writeText(text),
			catch: (error) => TextError.ClipboardWrite({ cause: error }),
		});

		if (copyError) {
			return Err(copyError);
		}
		return Ok(undefined);
	},

} satisfies TextService;
