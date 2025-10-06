import { WhisperingWarningErr } from '$lib/result';
import { invoke } from '@tauri-apps/api/core';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { type } from '@tauri-apps/plugin-os';
import { Err, Ok, tryAsync } from 'wellcrafted/result';
import type { TextService } from './types';
import { TextServiceErr } from './types';

export function createTextServiceDesktop(): TextService {
	return {
		copyToClipboard: (text) =>
			tryAsync({
				try: () => writeText(text),
				catch: (error) =>
					TextServiceErr({
						message:
							'There was an error copying to the clipboard using the Tauri Clipboard Manager API. Please try again.',
						context: { text },
						cause: error,
					}),
			}),

		writeToCursor: async (text) =>
			tryAsync({
				try: () => invoke<void>('write_text', { text }),
				catch: (error) =>
					TextServiceErr({
						message:
							'There was an error writing the text. Please try pasting manually with Cmd/Ctrl+V.',
						context: { text },
						cause: error,
					}),
			}),
	};
}
