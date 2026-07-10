import type { SyncAuthClient } from '@epicenter/auth';
import { toConnection } from '@epicenter/svelte/auth';
import type { NodeId } from '@epicenter/workspace';
import { defineActions, satisfiesWorkspace } from '@epicenter/workspace';
import type { TranscriptionServiceId } from '$lib/services/transcription/providers';
import { defineRecordingsMarkdownExport } from '$lib/whispering/recordings-markdown-export';
import { defineWhispering } from './index';

/**
 * Open Whispering once for this browser-hosted application boot.
 *
 * Authentication selects the connection at construction time: signed out uses
 * the plaintext local document, while signed in uses the principal's synced
 * document. Identity changes reload the application so the next boot constructs
 * one new workspace rather than mutating the active workspace in place.
 */
export function openWhisperingBrowser({
	auth,
	nodeId,
	defaultTranscriptionService,
}: {
	auth: SyncAuthClient;
	nodeId: NodeId;
	defaultTranscriptionService: TranscriptionServiceId;
}) {
	const model = defineWhispering(defaultTranscriptionService);
	const bundle = model.connect(toConnection(auth, nodeId), (workspace) => ({
		actions: defineActions({
			recordings_export_markdown: defineRecordingsMarkdownExport(
				workspace.tables.recordings,
			),
		}),
	}));

	return satisfiesWorkspace({
		...bundle,
		whenReady: bundle.storage.whenLoaded,
	});
}
