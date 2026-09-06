import { onMount } from 'svelte';
import type { WhisperingApp } from '$lib/whispering/app';

/**
 * Two of the reconciler's triggers: the session opening, and the browser
 * reporting it is back online. Both gated on the backup policy being on and
 * the remote being reachable at all; a person's click on "Back up now" is the
 * ungated third, and the pipeline's kick after each new recording is the
 * fourth. No timer, and no reconnect edge derived from polling sync status.
 *
 * `online` is an interface event, not a reachability one: it fires when a
 * network comes back and never when a server does, and the desktop WebView
 * fires it on the same terms. It is kept because it is free and right more
 * often than not; the next open or click covers the rest.
 */
export function reconcileBackups(app: WhisperingApp): void {
	const kickUnderPolicy = () => {
		if (!app.settings.get('recordingAutoUpload')) return;
		if (!app.recordings.remoteAvailable) return;
		void app.recordings.backup.kick();
	};
	onMount(() => {
		kickUnderPolicy();
		window.addEventListener('online', kickUnderPolicy);
		return () => window.removeEventListener('online', kickUnderPolicy);
	});
}
