import { audio } from './audio';
import { download } from './download';
import { transcription } from './transcription';

/**
 * Cross-platform RPC namespace.
 * These query operations are available on both web and desktop.
 */
export const rpc = {
	audio,
	download,
	transcription,
};
