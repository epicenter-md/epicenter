import { commands } from './actions';
import { analytics } from './analytics';
import { config } from './config';
import { db } from './db';
import { delivery } from './delivery';
import { download } from './download';
import { notify } from './notify';
import { recorder } from './recorder';
import { localShortcuts } from './shortcuts';
import { sound } from './sound';
import { text } from './text';
import { transcription } from './transcription';
import { transformer } from './transformer';

/**
 * Cross-platform RPC namespace.
 * These query operations are available on both web and desktop.
 */
export const rpc = {
	analytics,
	text,
	commands,
	config,
	db,
	download,
	recorder,
	localShortcuts,
	sound,
	transcription,
	transformer,
	notify,
	delivery,
};
