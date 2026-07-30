/**
 * Whether the host's local transcription route can run here, and what it accepts.
 *
 * Epicenter has exactly one active local model per device; the host owns it and
 * Epicenter Home administers it (ADR-0180). Whispering chooses the *route*
 * (local against a cloud provider) and reads this to render that choice
 * honestly. It never learns which model is active, what models exist, or
 * anything about what is cached or resident.
 *
 * Advisory, not a gate. Nothing here decides whether `transcribeRecording` may
 * be called: the host resolves the active model independently at the point of
 * use and fails closed on its own. That matters because the shared Hugging Face
 * cache changes outside Epicenter, so a `ready` answer can be stale by the time
 * the user stops speaking. Treating this as a precondition would turn a stale
 * read into a refused transcription; treating it as advice turns it into a
 * slightly stale hint.
 *
 * Its real job is the *preventive* warning. When local transcription fails, the
 * surface that reports it is the dictation pill, which has nowhere to put a
 * recovery action, so the warning has to happen before the user speaks.
 *
 * Three states, and `checking` is genuinely separate from `unavailable`: a boot
 * that has not answered yet must not flash a warning, and a host that refused
 * must not read as ready. Refreshed on window focus, because the answer changes
 * in another window.
 */
import { tauri } from '#platform/tauri';
import {
	type LocalCapabilitiesResult,
	readLocalCapabilities,
} from '$lib/services/transcription/local-capabilities';

function createLocalRoute() {
	// `undefined` until the first answer lands: "checking", which is neither
	// ready nor unavailable.
	let result = $state.raw<LocalCapabilitiesResult | undefined>(undefined);

	// Bound once so the closure below cannot re-narrow a possibly-null seam.
	const host = tauri;

	async function refresh() {
		result = await readLocalCapabilities(
			host ? () => host.transcription.getLocalTranscriptionReadiness() : null,
		);
	}

	// `tauri` gates only the *listener*, not the read: off Tauri the read still
	// runs and answers `host-unavailable`, so callers never platform-detect.
	void refresh();
	if (host) {
		// A model activated, downloaded, or deleted in Home lands here when the
		// user comes back to this window.
		window.addEventListener('focus', () => void refresh());
	}

	return {
		/** The host's answer, or `undefined` while the first read is in flight. */
		get result() {
			return result;
		},
		/**
		 * What the route accepts. Permissive while unknown or unavailable: the
		 * host guards the real decision at use and reports which hints it applied,
		 * so an optimistic field can only offer something that turns out to be
		 * ignored, never misfeed the model.
		 */
		get capabilities() {
			return result?.data ?? { supportsPrompt: true, supportsLanguage: true };
		},
		/**
		 * Send the user to Epicenter Home's model administration. The app shell
		 * owns this navigation (ADR-0181); Whispering only asks for it, and the
		 * user still chooses what to do there.
		 */
		openHomeTranscription() {
			host?.transcription.openHomeTranscription();
		},
	};
}

/** The one shared read of the host's local transcription route. */
export const localRoute = createLocalRoute();
