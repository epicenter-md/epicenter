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
 * Refreshed on window focus, because the answer changes in another window.
 */
import { tauri } from '#platform/tauri';
import type { LocalTranscriptionReadiness } from '$lib/tauri/commands.types';

function createLocalRoute() {
	// `undefined` until the first read lands, so "checking" is distinguishable
	// from "unavailable" and no warning flashes during boot.
	let readiness = $state.raw<LocalTranscriptionReadiness | undefined>(
		undefined,
	);

	async function refresh() {
		if (!tauri) return;
		readiness = await tauri.transcription.getLocalTranscriptionReadiness();
	}

	// `tauri` is the platform check, and it is enough here. adapter-static
	// prerenders every page in Node, but the SSR pass resolves `#platform/tauri`
	// under the server conditions, where the seam exports `null`, so neither the
	// read nor the `window` access below is reachable without a real webview.
	if (tauri) {
		void refresh();
		// A model activated, downloaded, or deleted in Home lands here when the
		// user comes back to this window.
		window.addEventListener('focus', () => void refresh());
	}

	return {
		/** Whether the first read has landed. */
		get loaded() {
			return readiness !== undefined;
		},
		/** The host's answer, or `undefined` before the first read. */
		get readiness() {
			return readiness;
		},
		/**
		 * What the route accepts. Permissive while unknown: the host guards the
		 * real decision at use and reports which hints it applied, so an
		 * optimistic field can only offer something that turns out to be ignored,
		 * never misfeed the model.
		 */
		get capabilities() {
			return readiness?.status === 'ready'
				? {
						supportsPrompt: readiness.supportsPrompt,
						supportsLanguage: readiness.supportsLanguage,
					}
				: { supportsPrompt: true, supportsLanguage: true };
		},
		refresh,
		/**
		 * Send the user to Epicenter Home's model administration. The app shell
		 * owns this navigation (ADR-0180); Whispering only asks for it, and the
		 * user still chooses what to do there.
		 */
		openModelAdministration() {
			void tauri?.transcription.openModelAdministration();
		},
	};
}

/** The one shared read of the host's local transcription route. */
export const localRoute = createLocalRoute();
