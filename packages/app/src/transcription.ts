/**
 * @fileoverview `epicenter.transcription`: turn a published recording into text
 * on Epicenter's own local transcription route.
 *
 * An app asks for transcription; it does not ask for a model. Which model runs
 * is one machine-wide choice that Epicenter Home administers, so there is no
 * listing, no selection, and no per-call model name here. What an app gets back
 * names the model that produced the text, which is enough to notice a
 * substitution and not enough to start steering one.
 *
 * The input is a blob id, never audio. Nothing in this namespace moves bytes
 * across the boundary: `recording.stop` publishes audio under an id, and
 * `transcribe` reads it back host-side.
 */

import {
	type TranscribeError,
	type TranscriptionCapabilitiesError,
	TranscriptionErrors,
} from './errors.js';
import { callHost, isHostRejection, nudgeHost, taggedMessage, taggedName } from './host.js';
import {
	COMMANDS,
	type WireLocalTranscriptionReadiness,
	type WireTranscriptionOutcome,
	type WireUnavailableReason,
} from './protocol.js';
import { Err, Ok, type Result } from 'wellcrafted/result';

/** What the transcription route currently accepts. */
export type TranscriptionCapabilities = {
	/** Whether an `initialPrompt` hint would reach the recognizer. */
	supportsPrompt: boolean;
	/** Whether a `language` hint would reach the recognizer. */
	supportsLanguage: boolean;
};

/**
 * Advisory inputs a transcription may carry.
 *
 * Advisory in the exact sense that the result reports which of them were
 * applied: a hint the active model cannot take is reported as not applied
 * rather than silently dropped.
 */
export type TranscriptionHints = {
	/** A spoken-language hint. Omit it to let the recognizer detect the language. */
	language?: string | null;
	/** Text that primes the recognizer, for names and jargon it would otherwise miss. */
	initialPrompt?: string | null;
};

/** Which hints actually reached the recognizer. */
export type AppliedHints = {
	/** The language the run used, or `null` when it detected one itself. */
	language: string | null;
	/** Whether the initial prompt reached the recognizer. */
	initialPrompt: boolean;
};

/**
 * The outcome of a transcription.
 *
 * Two arms because there are two honest stories, and neither is a failure.
 * `empty-audio` carries no model and no applied hints, because no inference
 * ran: claiming either would be describing something that did not happen.
 */
export type Transcript =
	| {
			outcome: 'transcribed';
			text: string;
			/** The exact model that produced this text. */
			modelId: string;
			applied: AppliedHints;
	  }
	| { outcome: 'empty-audio' };

export type TranscriptionNamespace = {
	/**
	 * What the transcription route currently accepts, or why it cannot run.
	 *
	 * Advisory, not a gate. An app reads this to warn someone *before* they
	 * speak, and to decide whether to offer a prompt or language field.
	 * {@link TranscriptionNamespace.transcribe} resolves the route independently
	 * at the moment it runs, so a stale answer here can only produce a stale
	 * hint, never a wrong transcript.
	 */
	capabilities(): Promise<
		Result<TranscriptionCapabilities, TranscriptionCapabilitiesError>
	>;
	/**
	 * Transcribe the audio a `recording.stop` published.
	 *
	 * @param audioBlobId The id `recording.stop` published audio under.
	 * @param hints Advisory only. The result reports which ones applied.
	 */
	transcribe(
		audioBlobId: string,
		hints?: TranscriptionHints,
	): Promise<Result<Transcript, TranscribeError>>;
	/**
	 * Say that transcription may be imminent, so the work of getting ready can
	 * overlap with whatever happens next. The usual moment is when a recording
	 * starts.
	 *
	 * Returns nothing and cannot fail, on purpose. It is a timing hint, not a
	 * readiness call: there is no state to observe afterwards and nothing for a
	 * caller to branch on. Calling it changes what a later `transcribe` costs,
	 * never what it does.
	 */
	prewarm(): void;
};

function unavailable(reason: WireUnavailableReason, cause: string) {
	return TranscriptionErrors.TranscriptionUnavailable({ reason, cause });
}

export const transcription: TranscriptionNamespace = {
	async capabilities() {
		const operation = 'transcription.capabilities';
		const { data, error } = await callHost<WireLocalTranscriptionReadiness>(
			operation,
			COMMANDS.localTranscriptionReadiness,
		);
		if (error) {
			if (!isHostRejection(error)) return Err(error);
			return TranscriptionErrors.TranscriptionFailed({
				operation,
				cause: error.domain,
			});
		}
		// The host answers this read successfully whether or not the route can
		// run, so the unusable case becomes a typed failure here. That is the
		// difference between "the query worked" and "the capability is usable",
		// and only the second one is what a caller asked about.
		if (data.status === 'unavailable') {
			return unavailable(data.reason, data.message);
		}
		return Ok({
			supportsPrompt: data.supportsPrompt,
			supportsLanguage: data.supportsLanguage,
		});
	},

	async transcribe(audioBlobId, hints) {
		const operation = 'transcription.transcribe';
		const { data, error } = await callHost<WireTranscriptionOutcome>(
			operation,
			COMMANDS.transcribeRecording,
			{
				audioBlobId,
				hints: {
					language: hints?.language ?? null,
					initialPrompt: hints?.initialPrompt ?? null,
				},
			},
		);
		if (error) {
			if (!isHostRejection(error)) return Err(error);
			const cause = taggedMessage(error.domain);
			switch (taggedName(error.domain)) {
				case 'LocalRouteUnavailable':
					return unavailable(readUnavailableReason(error.domain), cause);
				case 'AudioReadError':
					return TranscriptionErrors.AudioUnreadable({ audioBlobId, cause });
				case 'ModelLoadError':
					return TranscriptionErrors.ModelLoadFailed({ cause });
				default:
					return TranscriptionErrors.TranscriptionFailed({
						operation,
						cause: error.domain,
					});
			}
		}
		return Ok(data);
	},

	prewarm() {
		nudgeHost(COMMANDS.prewarmModel);
	},
};

/**
 * The host states why the route is unusable alongside the failure. A payload
 * that does not carry a reason this build knows is read as the broader of the
 * two, because "a model is active but unusable" is the claim that would be
 * wrong to make without evidence.
 */
function readUnavailableReason(domain: unknown): WireUnavailableReason {
	const reason =
		typeof domain === 'object' && domain !== null
			? Reflect.get(domain, 'reason')
			: undefined;
	return reason === 'active-model-unavailable'
		? 'active-model-unavailable'
		: 'no-active-model';
}
