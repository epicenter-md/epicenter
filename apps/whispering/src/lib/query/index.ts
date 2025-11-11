// Import all query modules

import { commands } from './actions';
import { analytics } from './analytics';
import { db } from './db';
import { delivery } from './delivery';
import { download } from './download';
import { ffmpeg } from './ffmpeg';
import { notify } from './notify';
import { recorder } from './recorder';
import { shortcuts } from './shortcuts';
import { sound } from './sound';
import { text } from './text';
import { transcription } from './transcription';
import { transformer } from './transformer';
import { tray } from './tray';
import { vadRecorder } from './vad-recorder';

/**
 * Unified namespace for all query operations.
 * Provides a single entry point for all TanStack Query-based operations.
 */
export const rpc = {
	analytics,
	text,
	commands,
	db,
	download,
	ffmpeg,
	recorder,
	vadRecorder,
	tray,
	shortcuts,
	sound,
	transcription,
	transformer,
	notify,
	delivery,
};
