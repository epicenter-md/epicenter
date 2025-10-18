export type { FfmpegService } from './types';

import { createFfmpegService } from './desktop';
import { createFfmpegServiceWeb } from './web';

export const FfmpegServiceLive = window.__TAURI_INTERNALS__
	? createFfmpegService()
	: createFfmpegServiceWeb();
