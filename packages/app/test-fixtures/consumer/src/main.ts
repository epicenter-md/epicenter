/**
 * A dictation app, written the way an app author would write it.
 *
 * This file is the contract under test. It imports `@epicenter/app` and its own
 * app contract, and nothing else: no `@tauri-apps/*`, no platform check, no
 * `isTauri()`, no dynamic import guard, no SQLite, no Yjs, and no mention of a
 * transcription model. If any of those became necessary, this file would stop
 * compiling or stop being honest, and the point of the client would be gone.
 */

import { epicenter } from '@epicenter/app';
import { notesContract } from './notes-contract.js';

const status = document.querySelector<HTMLElement>('#status');
const transcript = document.querySelector<HTMLElement>('#transcript');
const button = document.querySelector<HTMLButtonElement>('#record');

const show = (text: string) => {
	if (status) status.textContent = text;
};

let held: string | null = null;

/**
 * Endings nobody asked for. Subscribed once, at startup, before anything is
 * recording: the subscription belongs to the app, so no ending can land in a
 * gap between starting a recording and being able to hear about it.
 */
const { data: unsubscribe, error: observeError } =
	await epicenter.recording.onEnded(({ audioBlobId, reason }) => {
		if (audioBlobId !== held) return;
		show(`Recording ended early (${reason}). Saving what was captured.`);
		void finish(audioBlobId);
	});
if (observeError) show(observeError.message);
window.addEventListener('beforeunload', () => unsubscribe?.());

/**
 * A recording outlives a reload, so the first thing an app does is ask whether
 * it is already holding one. This is also where a capture that died while the
 * app was gone turns up.
 */
const { data: existing } = await epicenter.recording.current();
if (existing) {
	held = existing.audioBlobId;
	show(
		existing.endedReason === null
			? `Still recording from ${existing.microphone}.`
			: `A recording is waiting to be saved (${existing.endedReason}).`,
	);
}

async function start() {
	// A timing hint, not a readiness call: there is nothing to await and
	// nothing to branch on.
	epicenter.transcription.prewarm();

	const { data: recording, error } = await epicenter.recording.start();
	if (error) {
		// Every reason this can decline, named. The compiler is what makes this
		// list complete, and it does not include a case for "not on desktop":
		// that is `HostUnavailable`, like everything else.
		switch (error.name) {
			case 'HostUnavailable':
				return show('Open this app in Epicenter to record.');
			case 'CapabilityUnavailable':
				return show('This app is not allowed to record here.');
			case 'MicrophoneAccessDenied':
				return show('Grant Epicenter microphone access in system settings.');
			case 'NoMicrophone':
				return show('Connect a microphone.');
			case 'RecorderBusy':
				return show('Something else is recording. Try again when it stops.');
			case 'RecordingFailed':
				return show(error.message);
		}
	}
	held = recording.audioBlobId;
	show(`Recording from ${recording.microphone}.`);
}

async function finish(audioBlobId: string) {
	held = null;

	const { data: published, error: stopError } =
		await epicenter.recording.stop(audioBlobId);
	if (stopError) return show(stopError.message);
	show(`Saved ${Math.round(published.durationMs / 1000)}s. Transcribing.`);

	const { data: result, error: transcribeError } =
		await epicenter.transcription.transcribe(published.audioBlobId, {
			language: 'en',
		});
	if (transcribeError) return show(transcribeError.message);

	if (result.outcome === 'empty-audio')
		return show('That recording was silent.');
	if (transcript) transcript.textContent = result.text;
	show(`Transcribed with ${result.modelId}.`);
}

button?.addEventListener('click', () => {
	void (held === null ? start() : finish(held));
});

// Advisory, and read for exactly what it is advisory about: whether to offer a
// prompt field. Never a gate in front of transcribing.
const { data: accepts, error: capabilitiesError } =
	await epicenter.transcription.capabilities();
if (capabilitiesError?.name === 'TranscriptionUnavailable') {
	show(capabilitiesError.message);
} else if (accepts?.supportsPrompt) {
	document.querySelector<HTMLElement>('#prompt')?.removeAttribute('hidden');
}

/**
 * Structured data, bound through the app's own contract.
 *
 * `bind` is the one awaited call in the client. It waits for the document's
 * shared observation carrier, so once it resolves, subscribing and then reading
 * cannot miss a change that landed in between.
 */
const { data: notes, error: bindError } =
	await epicenter.data.bind(notesContract);
if (bindError) {
	// Every reason binding can decline, named. There is no case for "not on
	// desktop": that is `HostUnavailable`, like everything else.
	switch (bindError.name) {
		case 'HostUnavailable':
			show('Open this app in Epicenter to keep notes.');
			break;
		case 'CapabilityUnavailable':
			show('This app is not allowed to read data here.');
			break;
		case 'DataUnavailable':
		case 'DataFailed':
			show(bindError.message);
			break;
	}
} else {
	// Subscribe first, then read. Registration is synchronous and never fires
	// initially, so nothing can land in the gap and nothing has to be discarded.
	notes.notes.subscribe((invalidation) => {
		if (invalidation.scope === 'table') {
			void renderEverything();
			return;
		}
		for (const rowId of invalidation.rowIds) void rerender(rowId);
	});
	notes.settings.subscribe(() => void renderEverything());

	await renderEverything();

	document.querySelector('#note')?.addEventListener('click', () => {
		void notes.notes.create({ title: 'Untitled', body: undefined });
	});
}

async function renderEverything() {
	const bound = notes;
	if (!bound) return;
	const { data: scanned, error } = await bound.notes.scan();
	if (error) return show(error.message);
	const list = document.querySelector('#notes');
	if (list)
		list.textContent = scanned.rows.map((note) => note.title).join(', ');
	if (scanned.nonconforming.length > 0) {
		show(`${scanned.nonconforming.length} note(s) this version cannot read.`);
	}
}

async function rerender(rowId: string) {
	const bound = notes;
	if (!bound) return;
	const { data: note, error } = await bound.notes.get(rowId);
	if (error) return show(error.message);
	if (!note) return void renderEverything();
	show(`Updated ${note.title}.`);
}
