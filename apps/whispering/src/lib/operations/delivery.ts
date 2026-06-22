import { goto } from '$app/navigation';
import { WHISPERING_RECORDINGS_PATHNAME } from '$lib/constants/urls';
import type { DeliveryOutcome } from '$lib/operations/delivery-reach';
import type { Notice } from '$lib/report';
import { services } from '$lib/services';
import { settings } from '$lib/state/settings.svelte';

// The reach types live in their own `delivery-reach` module next to their ADR
// docstrings; re-exported here so callers keep one delivery import.
export type {
	DeliveryOutcome,
	DeliveryReach,
} from '$lib/operations/delivery-reach';

/**
 * The output scopes Whispering delivers into. Each has its own
 * clipboard/cursor/enter toggles under `output.<scope>.*`. Keeping the list in
 * one place lets delivery and the tap-hold capability derive from the same
 * source instead of hardcoding the scope names.
 */
const OUTPUT_SCOPES = ['transcription', 'recipe'] as const;
type OutputScope = (typeof OUTPUT_SCOPES)[number];

/**
 * True when any output scope is set to write at the cursor. Cursor delivery is a
 * synthetic Cmd/Ctrl+V, so this is exactly when delivery needs the macOS
 * Accessibility grant, which is the one fact the tap supervisor holds the tap to
 * track. Call inside a reactive scope to stay live as the toggles change.
 */
export function outputWritesToCursor(): boolean {
	return OUTPUT_SCOPES.some((scope) => settings.get(`output.${scope}.cursor`));
}

/**
 * Where a transcript originated: a live `recording` or an imported file
 * (`import`). Shapes the success copy and flows in from the pipeline's
 * `deliverySource`.
 */
export type TranscriptionSource = 'recording' | 'import';

const TRANSCRIPTION_SUCCESS_COPY = {
	recording: '📝 Recording transcribed',
	import: '📁 File transcribed',
} as const satisfies Record<TranscriptionSource, string>;

/** A delivery result: the structured outcome plus a human notice for toasts. */
export type DeliveryResult = { outcome: DeliveryOutcome; notice: Notice };

/**
 * Delivers transcript to the user according to their text output preferences
 * (copy to clipboard, write to cursor, simulate enter). Returns the structured
 * outcome plus a human notice; it does not toast. The dictation path reads the
 * outcome to drive the pill; file import and row actions show the notice.
 */
export async function deliverTranscriptionResult({
	text,
	source = 'recording',
}: {
	text: string;
	source?: TranscriptionSource;
}): Promise<DeliveryResult> {
	return deliverResult({
		text,
		successCopy: TRANSCRIPTION_SUCCESS_COPY[source],
		settingsScope: 'transcription',
		// A transcription always belongs to a recording, so its history is reachable.
		linkedRecording: true,
	});
}

/**
 * Delivers a Recipe's output to the user according to their text output
 * preferences. Returns the structured outcome plus a human notice. `recordingId`
 * is the run's link to a recording, or null for ad-hoc runs (clipboard,
 * selection): only a recording-anchored run offers a "go to recordings" action,
 * since an ad-hoc run has no history to open.
 */
export async function deliverRecipeResult({
	text,
	recordingId,
}: {
	text: string;
	recordingId: string | null;
}): Promise<DeliveryResult> {
	return deliverResult({
		text,
		successCopy: '🔄 Recipe complete',
		settingsScope: 'recipe',
		linkedRecording: recordingId !== null,
	});
}

async function deliverResult({
	text,
	successCopy,
	settingsScope,
	linkedRecording,
}: {
	text: string;
	successCopy: string;
	settingsScope: OutputScope;
	linkedRecording: boolean;
}): Promise<DeliveryResult> {
	const recordingsAction = linkedRecording
		? {
				label: 'Go to recordings',
				onClick: () => goto(WHISPERING_RECORDINGS_PATHNAME),
			}
		: undefined;

	const clipboardRequested = settings.get(`output.${settingsScope}.clipboard`);
	const cursorRequested = settings.get(`output.${settingsScope}.cursor`);

	// No cursor write requested: the clipboard is the only configured sink, so
	// copy the transcript there (or it reaches history when nothing is configured).
	// Best-effort: a clipboard write effectively never fails, and the transcript is
	// in history regardless, so its error does not change the reach.
	if (!cursorRequested) {
		if (clipboardRequested) await services.text.copyToClipboard(text);
		return {
			outcome: { reach: 'output' },
			notice: {
				title: `${successCopy}!`,
				description: text,
				action: recordingsAction,
			},
		};
	}

	// Cursor write requested. The clipboard is `write_text`'s paste transport;
	// `keepOnClipboard` tells it what the clipboard should hold afterward, so it
	// owns the staging that delivery used to pre-copy: when clipboard output is on
	// it leaves the transcript there; when off it borrows and restores the user's
	// clipboard (full-fidelity on macOS — see write_text's docstring in src-tauri).
	// `write_text` decides from the Accessibility grant whether it can paste and
	// reports where the transcript landed: `pasted` at the cursor (clean), or
	// `leftOnClipboard` when it could not paste.
	const { data: writeOutcome, error: writeError } =
		await services.text.writeToCursor(text, clipboardRequested);

	if (writeError) {
		// The write failed outright (rare). Ensure the transcript is at least on the
		// clipboard, and report the reduced reach.
		await services.text.copyToClipboard(text);
		return {
			outcome: { reach: 'clipboard' },
			notice: {
				title: `${successCopy}, copied to clipboard (couldn't write to cursor)`,
				description: text,
				action: recordingsAction,
			},
		};
	}

	if (
		writeOutcome === 'pasted' &&
		settings.get(`output.${settingsScope}.enter`)
	) {
		// The Enter keystroke is a nicety on top of a successful write; a failure
		// here does not change the delivery outcome.
		await services.text.simulateEnterKeystroke();
	}

	// A clean `pasted` reached the configured output; a `leftOnClipboard` fallback
	// is a reduced (but recoverable) reach — see DeliveryReach and ADR-0039/0040.
	const reach = writeOutcome === 'pasted' ? 'output' : 'clipboard';
	return {
		outcome: { reach },
		notice: {
			title:
				reach === 'output'
					? `${successCopy} and written to cursor!`
					: `${successCopy}, copied to clipboard (couldn't write to cursor)`,
			description: text,
			action: recordingsAction,
		},
	};
}
