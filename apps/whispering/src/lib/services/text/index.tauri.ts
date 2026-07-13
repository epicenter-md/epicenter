import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import { tryAsync } from 'wellcrafted/result';
import type { TextService } from './types';
import { TextError } from './types';

export type { TextError, TextService } from './types';

export const TextServiceLive = {
	readFromClipboard: () =>
		tryAsync({
			try: async () => {
				const text = await readText();
				return text ?? null;
			},
			catch: (error) => TextError.ClipboardRead({ cause: error }),
		}),

	copyToClipboard: (text) =>
		tryAsync({
			try: () => writeText(text),
			catch: (error) => TextError.ClipboardWrite({ cause: error }),
		}),
} satisfies TextService;
