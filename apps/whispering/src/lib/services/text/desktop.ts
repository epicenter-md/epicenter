import { invoke } from '@tauri-apps/api/core';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import { tryAsync } from 'wellcrafted/result';
import type { TextService } from './types';
import { TextError } from './types';

export function createTextServiceDesktop(deps: {
	getUseYdotool: () => boolean;
}): TextService {
	return {
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

		writeToCursor: async (text) =>
			tryAsync({
				try: () =>
					invoke<void>('write_text', {
						text,
						useYdotool: deps.getUseYdotool(),
					}),
				catch: (error) => TextError.WriteToCursor({ cause: error }),
			}),

		simulateEnterKeystroke: () =>
			tryAsync({
				try: () =>
					invoke<void>('simulate_enter_keystroke', {
						useYdotool: deps.getUseYdotool(),
					}),
				catch: (error) => TextError.SimulateKeystroke({ cause: error }),
			}),
	};
}
