import { settings } from '$lib/state/settings.svelte';
import { createTextServiceDesktop } from './desktop';
import { createTextServiceWeb } from './web';

export type { TextService, TextServiceError } from './types';

export const TextServiceLive = window.__TAURI_INTERNALS__
	? createTextServiceDesktop({
			getUseYdotool: () => settings.value['system.useYdotool'],
		})
	: createTextServiceWeb();
