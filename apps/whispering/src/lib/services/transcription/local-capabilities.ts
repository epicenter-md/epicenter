/**
 * The local transcription route's capabilities, as an application asks for them.
 *
 * This is a deliberately small stand-in for the portable
 * `epicenter.transcription.capabilities()` that ADR-0181 specifies. That handle
 * does not exist yet; this wave builds the native substrate underneath it, so
 * the shape here is chosen to match the eventual contract rather than to be it:
 * a Wellcrafted `Result` whose `Err` says *why* the capability cannot be used,
 * including when the host itself could not answer.
 *
 * The one rule this file exists to enforce: **a host that denies, dies, or is
 * not there is unavailable, never ready.** Reading capabilities is advisory, but
 * "advisory" must not decay into "optimistic". A rejected invoke that left the
 * value undefined would be read downstream as "not blocked yet" and the user
 * would be told everything was fine right up until they finished speaking.
 *
 * Environment differences arrive here as an `Err`, not as a missing namespace or
 * a platform check in the caller (ADR-0181): on web there is no host, and that
 * is reported as `host-unavailable` like any other reason the route cannot run.
 */

import { extractErrorMessage } from 'wellcrafted/error';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { LocalTranscriptionReadiness } from '$lib/tauri/commands.types';

/** What the route accepts when it is usable. */
export type TranscriptionCapabilities = {
	supportsPrompt: boolean;
	supportsLanguage: boolean;
};

/**
 * Why the route cannot be used. `host-unavailable` is this layer's own reason
 * for "the host could not answer at all"; the other two are the host's verdict,
 * passed through with the sentence it wrote.
 */
export type TranscriptionUnavailable = {
	reason: 'host-unavailable' | 'no-active-model' | 'active-model-unavailable';
	message: string;
};

export type LocalCapabilitiesResult = Result<
	TranscriptionCapabilities,
	TranscriptionUnavailable
>;

/**
 * Ask the host whether the local route can run, converting every failure mode
 * into a typed answer.
 *
 * `read` is the host call. It is a parameter so the failure path is testable
 * without a Tauri runtime, and so the browser build can pass `null` rather than
 * branching on the platform at each call site.
 */
export async function readLocalCapabilities(
	read: (() => Promise<LocalTranscriptionReadiness>) | null,
): Promise<LocalCapabilitiesResult> {
	if (!read) {
		return Err({
			reason: 'host-unavailable',
			message:
				'Local transcription needs the Epicenter desktop app. Choose a cloud or self-hosted provider here.',
		});
	}
	try {
		const readiness = await read();
		if (readiness.status === 'ready') {
			return Ok({
				supportsPrompt: readiness.supportsPrompt,
				supportsLanguage: readiness.supportsLanguage,
			});
		}
		return Err({ reason: readiness.reason, message: readiness.message });
	} catch (cause) {
		// A denied capability, a host that went away, or a malformed reply. None
		// of them mean "ready", and none of them are the caller's to diagnose.
		return Err({
			reason: 'host-unavailable',
			message: `Epicenter could not check local transcription on this device: ${extractErrorMessage(cause)}`,
		});
	}
}
