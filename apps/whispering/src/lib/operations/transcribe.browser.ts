import {
	type ResolvedConnection,
	resolveConnection,
	transcribe,
} from '@epicenter/client';
import { API_ROUTES } from '@epicenter/constants/api-routes';
import { defineErrors } from 'wellcrafted/error';
import { Err, type Result } from 'wellcrafted/result';
import type { SupportedLanguage } from '$lib/constants/languages';
import type { WhisperingAuth } from '$lib/environment/contract';
import type { BlobStore } from '$lib/services/blob-store/types';
import type { HttpService } from '$lib/services/http/types';
import { createDeepgramTranscriptionService } from '$lib/services/transcription/cloud/deepgram';
import { ElevenLabsTranscriptionServiceLive } from '$lib/services/transcription/cloud/elevenlabs';
import { MistralTranscriptionServiceLive } from '$lib/services/transcription/cloud/mistral';
import {
	PROVIDERS,
	type TranscriptionServiceId,
	type UploadProviderId,
} from '$lib/services/transcription/providers';
import { deviceConfig } from '$lib/state/device-config.svelte';
import { type SecretKey, secrets } from '$lib/state/secrets.svelte';
import type { TranscriptionSettings } from './transcription-ports';

/**
 * The error any transcription path can surface. Deliberately `AnyTaggedError`
 * rather than the concrete provider-error union: every consumer (toast,
 * failed-row tooltip, and practice view) presents these by `.message`,
 * and none discriminate on `.name`. The user-facing message is curated where
 * the context lives, in each service's `defineErrors` constructors, so this
 * boundary only needs to promise `{ name, message }`. Widening to the full
 * union would add error variants no consumer reads.
 */
import type {
	TranscriptionEngine,
	TranscriptionError,
} from './transcription-use-case';

const TranscriptionOperationError = defineErrors({
	/** The hosted Epicenter gateway answered 402 (`InsufficientCredits`, ADR-0100):
	 *  the wallet could not cover this transcription. Surfaced as a credit-aware
	 *  message instead of the raw provider envelope, so the user knows the one thing
	 *  that fixes it. */
	InsufficientCredits: () => ({
		message:
			"You're out of Epicenter AI credits. Add credits from the dashboard to keep transcribing, or switch to your own provider in settings.",
	}),
	ProviderUnavailable: ({ provider }: { provider: string }) => ({
		message: `${provider} is not available in this build.`,
	}),
});

type CloudTranscriptionTransport = {
	fetch: typeof fetch | undefined;
	http: HttpService;
};

export function createBrowserTranscription({
	auth,
	artifacts,
	cloudTransport,
	settings,
}: {
	auth: WhisperingAuth;
	artifacts: BlobStore;
	cloudTransport: CloudTranscriptionTransport;
	settings: TranscriptionSettings;
}): TranscriptionEngine {
	const providers = [
		'epicenter',
		'OpenAI',
		'Groq',
		'ElevenLabs',
		'Deepgram',
		'Mistral',
		'speaches',
	] as const satisfies readonly TranscriptionServiceId[];
	const providerSet: ReadonlySet<TranscriptionServiceId> = new Set(providers);
	function isBrowserProvider(
		provider: TranscriptionServiceId,
	): provider is UploadProviderId {
		return providerSet.has(provider);
	}
	const deepgram = createDeepgramTranscriptionService(cloudTransport.http);

	/**
	 * How an upload (non-on-device) provider is reached. A `wire` provider resolves its own
	 * transport and a model and hands them to the shared `transcribe()`; a `bespoke`
	 * provider keeps its own SDK client (a different wire). The `kind` discriminant
	 * carries the routing, so there is no wire-vs-bespoke id subset to derive and no
	 * `in`-guard: one exhaustive switch on `.kind`.
	 *
	 * The transport is a `resolve` thunk, not static connection data, so each wire entry
	 * owns how it becomes a transport (ADR-0060): a `key`/`endpoint` entry resolves a
	 * `{ baseUrl, apiKey }` over `customFetch`, while the `session` Epicenter entry closes
	 * over the signed-in session `fetch` (never connection data). The switch
	 * therefore never branches on what kind of transport it got.
	 *
	 * A bespoke entry closes over its own key and model (from the literal `PROVIDERS.X`
	 * pointers, the SSOT) rather than letting the caller read `PROVIDERS[id]`, because
	 * switching on `.kind` does not narrow the id back to a KeyProvider. The wire
	 * entries read the same pointers; the one fact `PROVIDERS` does not hold is the
	 * canonical wire base URL (it used to be each SDK's default), so that literal lives
	 * here.
	 */
	type UploadDispatch =
		| {
				kind: 'wire';
				resolve: () => ResolvedConnection;
				model: () => string;
		  }
		| {
				kind: 'bespoke';
				transcribe: (
					audio: Blob,
					options: { prompt: string; spokenLanguage: SupportedLanguage },
				) => Promise<Result<string, TranscriptionError>>;
		  };

	/**
	 * Read a provider API key through the credential facade (ADR-0074): the key when
	 * set, undefined when missing. A provider key is a secret, so it routes through
	 * `secrets`, never raw `deviceConfig`, which is what makes the user-global vault
	 * cover transcription once auth lands. Device-local plaintext today.
	 */
	function secretApiKey(key: SecretKey): string | undefined {
		const read = secrets.get(key);
		return read.status === 'available' ? read.value : undefined;
	}

	/**
	 * Every upload transcription provider, keyed by id. `satisfies Record<UploadProviderId,
	 * UploadDispatch>` makes the table total over the non-on-device providers: a new cloud or
	 * self-hosted provider is a compile error until it has an entry, and an on-device
	 * provider cannot appear (it goes through the FFI path, branched in `transcribeAudio`).
	 *
	 * Wire entries (OpenAI, Groq, Speaches): the endpoint override beats the canonical
	 * default; Speaches stores a bare host, so its `/v1` is appended; a keyless local
	 * box sends no key. Bespoke entries (ElevenLabs, Deepgram, Mistral) keep their own
	 * clients because they do not speak the wire (Deepgram's raw body + `Authorization:
	 * Token`, ElevenLabs' `xi-api-key`, Mistral's `context_bias`); ADR-0060 blesses it.
	 */
	const UPLOAD_DISPATCH = {
		// Epicenter (`session`) STT: the transport is the signed-in session fetch against
		// the deployment you are bonded to (`auth.deployment.baseURL`, so a self-hosted instance's own
		// gateway is used when connected to one), never a stored key. Both deployables mount
		// this gateway on their house key; a hosted deployment meters it (ADR-0100), a
		// self-host deployment does not. The model is fixed by the gateway.
		epicenter: {
			kind: 'wire',
			resolve: () => ({
				fetch: auth.fetch,
				baseURL: API_ROUTES.ai.baseUrl(auth.deployment.baseURL),
			}),
			model: () => PROVIDERS.epicenter.model,
		},
		OpenAI: {
			kind: 'wire',
			resolve: () =>
				resolveConnection(
					{
						baseUrl:
							deviceConfig.get(PROVIDERS.OpenAI.endpointConfigKey) ||
							'https://api.openai.com/v1',
						apiKey: secretApiKey(PROVIDERS.OpenAI.apiKeyConfigKey),
					},
					cloudTransport?.fetch,
				),
			model: () => settings.model(PROVIDERS.OpenAI.modelSettingKey),
		},
		Groq: {
			kind: 'wire',
			resolve: () =>
				resolveConnection(
					{
						baseUrl:
							deviceConfig.get(PROVIDERS.Groq.endpointConfigKey) ||
							'https://api.groq.com/openai/v1',
						apiKey: secretApiKey(PROVIDERS.Groq.apiKeyConfigKey),
					},
					cloudTransport?.fetch,
				),
			model: () => settings.model(PROVIDERS.Groq.modelSettingKey),
		},
		speaches: {
			kind: 'wire',
			resolve: () =>
				resolveConnection(
					{
						baseUrl: `${deviceConfig.get(PROVIDERS.speaches.endpointConfigKey)}/v1`,
					},
					cloudTransport?.fetch,
				),
			model: () => deviceConfig.get(PROVIDERS.speaches.modelIdConfigKey),
		},
		ElevenLabs: {
			kind: 'bespoke',
			transcribe: (audio, { prompt, spokenLanguage }) =>
				ElevenLabsTranscriptionServiceLive.transcribe(audio, {
					prompt,
					spokenLanguage,
					apiKey: secretApiKey(PROVIDERS.ElevenLabs.apiKeyConfigKey) ?? '',
					modelName: settings.model(PROVIDERS.ElevenLabs.modelSettingKey),
				}),
		},
		Deepgram: {
			kind: 'bespoke',
			transcribe: async (audio, { prompt, spokenLanguage }) => {
				return deepgram.transcribe(audio, {
					prompt,
					spokenLanguage,
					apiKey: secretApiKey(PROVIDERS.Deepgram.apiKeyConfigKey) ?? '',
					modelName: settings.model(PROVIDERS.Deepgram.modelSettingKey),
				});
			},
		},
		Mistral: {
			kind: 'bespoke',
			transcribe: (audio, { prompt, spokenLanguage }) =>
				MistralTranscriptionServiceLive.transcribe(audio, {
					prompt,
					spokenLanguage,
					apiKey: secretApiKey(PROVIDERS.Mistral.apiKeyConfigKey) ?? '',
					modelName: settings.model(PROVIDERS.Mistral.modelSettingKey),
				}),
		},
	} satisfies Record<UploadProviderId, UploadDispatch>;

	/**
	 * Materialize the bytes to upload for a non-on-device (upload) transcription. The
	 * recording is already saved under `recordings/{id}.{ext}`; in Tauri we round-trip
	 * through Rust's libopus to land on a compressed opus blob. On the web
	 * there is no Rust, so we fetch the original bytes from the blob store and
	 * upload them as-is.
	 */
	async function loadForUpload(
		recordingId: string,
	): Promise<Result<Blob, TranscriptionError>> {
		return artifacts.getBlob(recordingId);
	}

	/**
	 * Transcribe a saved recording by id. This is the single canonical entry
	 * point for transcription:
	 *
	 * - The cpal stop path saves the WAV via Rust and returns the id.
	 * - The navigator / VAD / file import paths save the blob via the
	 *   recordings blob store and pass the id here.
	 *
	 * Local transcription always goes through `transcribe_recording(id)`.
	 * Upload (non-on-device) transcription uploads compressed bytes derived from the
	 * saved file when possible, falling back to the raw blob.
	 */
	async function transcribeAudio(
		recordingId: string,
	): Promise<Result<string, TranscriptionError>> {
		const selectedService = settings.service();
		if (!isBrowserProvider(selectedService)) {
			return TranscriptionOperationError.ProviderUnavailable({
				provider: PROVIDERS[selectedService].label,
			});
		}

		return transcribeViaUpload(recordingId, selectedService);
	}

	/**
	 * Fold the user's Dictionary into a transcription prompt. Both the cloud `prompt`
	 * and the local `initialPrompt` are freeform context the recognizer biases
	 * toward, so appending the terms as a glossary nudges it to spell proper nouns
	 * and jargon the way the user wrote them. Composition stays here in the app, not
	 * in `@epicenter/client`: the wire just carries one prompt string. An empty
	 * Dictionary returns the prompt unchanged. See ADR-0099.
	 */
	function withDictionaryTerms(prompt: string, dictionary: string[]): string {
		if (dictionary.length === 0) return prompt;
		const glossary = dictionary.join(', ');
		const trimmed = prompt.trim();
		return trimmed ? `${trimmed} ${glossary}` : glossary;
	}

	async function transcribeViaUpload(
		recordingId: string,
		selectedService: UploadProviderId,
	): Promise<Result<string, TranscriptionError>> {
		const { data: audio, error: loadError } = await loadForUpload(recordingId);
		if (loadError) return Err(loadError);

		// `auto` language and an empty prompt map to the wire's "unset" (omitted from
		// the form). No per-provider key-format pre-check: no key just means no header,
		// and the server answers 401, surfaced as a RequestFailed carrying that detail.
		// The Dictionary terms fold into the prompt so cloud recognition spells them
		// the user's way.
		const spokenLanguage = settings.language();
		const prompt = withDictionaryTerms(
			settings.prompt(),
			settings.dictionary(),
		);
		const entry = UPLOAD_DISPATCH[selectedService];
		switch (entry.kind) {
			case 'wire': {
				const result = await transcribe(audio, entry.resolve(), {
					model: entry.model(),
					language: spokenLanguage === 'auto' ? undefined : spokenLanguage,
					prompt: prompt || undefined,
				});
				// Only the `session` wire can meter credits, and only when bonded to a hosted
				// deployment, so a 402 there is `InsufficientCredits` (ADR-0100). Remap it to
				// a credit-aware message; every other wire's 402 (none expected) stays a raw
				// RequestFailed. A self-host deployment never meters, so it never 402s here.
				if (
					selectedService === 'epicenter' &&
					result.error?.name === 'RequestFailed' &&
					result.error.status === 402
				) {
					return TranscriptionOperationError.InsufficientCredits();
				}
				return result;
			}
			case 'bespoke':
				return entry.transcribe(audio, { prompt, spokenLanguage });
		}
	}

	return {
		transcribe: transcribeAudio,
	};
}
