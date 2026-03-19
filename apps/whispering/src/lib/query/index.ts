import { actions } from './actions';
import { analytics } from './analytics';
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

export { desktopRpc } from './desktop';

/**
 * Cross-platform RPC namespace.
 * These query operations are available on both web and desktop.
 */
export const rpc = {
	analytics,
	text,
	actions,
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
