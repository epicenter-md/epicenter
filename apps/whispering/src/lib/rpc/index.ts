import type { WhisperingApp } from '$lib/whispering/context';
import { audio } from './audio';
import { download } from './download';
import { createTranscriptionRpc } from './transcription';

/**
 * Cross-platform RPC namespace, bound to one ready application. Built once by
 * the provider and read from context; query operations that do not touch the
 * application (audio availability, download) compose in unchanged.
 */
export function createWhisperingRpc(app: WhisperingApp) {
	return {
		audio,
		download,
		transcription: createTranscriptionRpc(app),
	};
}

export type WhisperingRpc = ReturnType<typeof createWhisperingRpc>;
