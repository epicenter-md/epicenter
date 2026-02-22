import { invoke } from '@tauri-apps/api/core';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import { extractErrorMessage } from 'wellcrafted/error';
import { tryAsync } from 'wellcrafted/result';
import type { TextService } from './types';
import { TextServiceErr } from './types';

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
				catch: (error) =>
					TextServiceErr({
						message: `There was an error reading from the clipboard using the Tauri Clipboard Manager API. Please try again. ${extractErrorMessage(error)}`,
					}),
			}),

		copyToClipboard: (text) =>
			tryAsync({
				try: () => writeText(text),
				catch: (error) =>
					TextServiceErr({
						message: `There was an error copying to the clipboard using the Tauri Clipboard Manager API. Please try again. ${extractErrorMessage(error)}`,
					}),
			}),

		writeToCursor: async (text) =>
			tryAsync({
				try: () =>
					invoke<void>('write_text', {
						text,
						useYdotool: deps.getUseYdotool(),
					}),
				catch: (error) =>
					TextServiceErr({
						message: `There was an error writing the text. Please try pasting manually with Cmd/Ctrl+V. ${extractErrorMessage(error)}`,
					}),
			}),

		simulateEnterKeystroke: () =>
			tryAsync({
				try: () =>
					invoke<void>('simulate_enter_keystroke', {
						useYdotool: deps.getUseYdotool(),
					}),
				catch: (error) =>
					TextServiceErr({
						message: `There was an error simulating the Enter keystroke. Please press Enter manually. ${extractErrorMessage(error)}`,
					}),
			}),
	};
}
