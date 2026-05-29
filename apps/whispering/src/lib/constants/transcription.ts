/**
 * Single source of truth for transcription services and their models.
 *
 * Access patterns:
 * - Service IDs:    `keyof typeof TRANSCRIPTION` → 'OpenAI' | 'Groq' | ...
 * - Cloud models:   `TRANSCRIPTION.OpenAI.models` → readonly [{name, description, cost}, ...]
 * - Model names:    `TRANSCRIPTION.OpenAI.models.map(m => m.name)` for schema enums
 * - Labels:         `TRANSCRIPTION.OpenAI.label` → 'OpenAI'
 * - Capabilities:   `TRANSCRIPTION.OpenAI.capabilities.supportsPrompt`
 * - Default model:  `TRANSCRIPTION.OpenAI.defaultModel` → 'whisper-1'
 * - Enumerate:      `Object.keys(TRANSCRIPTION)` / `Object.entries(TRANSCRIPTION)`
 * - Schema:         `type.enumerated(...TRANSCRIPTION.OpenAI.models.map(m => m.name))`
 */
export const TRANSCRIPTION = {
	// ── Cloud services ──────────────────────────────────────────────
	OpenAI: {
		label: 'OpenAI',
		location: 'cloud',
		defaultModel: 'whisper-1',
		models: [
			{
				name: 'whisper-1',
				description:
					"OpenAI's flagship speech-to-text model with multilingual support. Reliable and accurate transcription for a wide variety of use cases.",
				cost: '$0.36/hour',
			},
			{
				name: 'gpt-4o-transcribe',
				description:
					'GPT-4o powered transcription with enhanced understanding and context. Best for complex audio requiring deep comprehension.',
				cost: '$0.36/hour',
			},
			{
				name: 'gpt-4o-mini-transcribe',
				description:
					'Cost-effective GPT-4o mini transcription model. Good balance of performance and cost for standard transcription needs.',
				cost: '$0.18/hour',
			},
		],
		capabilities: {
			supportsPrompt: true,
			supportsLanguage: true,
		},
	},
	Groq: {
		label: 'Groq',
		location: 'cloud',
		defaultModel: 'whisper-large-v3-turbo',
		models: [
			{
				name: 'whisper-large-v3',
				description:
					'Best accuracy (10.3% WER) and full multilingual support, including translation. Recommended for error-sensitive applications requiring multilingual support.',
				cost: '$0.111/hour',
			},
			{
				name: 'whisper-large-v3-turbo',
				description:
					'Fast multilingual model with good accuracy (12% WER). Best price-to-performance ratio for multilingual applications.',
				cost: '$0.04/hour',
			},
		],
		capabilities: {
			supportsPrompt: true,
			supportsLanguage: true,
		},
	},
	ElevenLabs: {
		label: 'ElevenLabs',
		location: 'cloud',
		defaultModel: 'scribe_v2',
		models: [
			{
				name: 'scribe_v2',
				description:
					'Latest flagship transcription model with 97% accuracy. Features speaker diarization (up to 48 speakers), entity detection, keyterm prompting, and dynamic audio tagging across 90+ languages.',
				cost: '$0.40/hour',
			},
			{
				name: 'scribe_v1',
				description:
					'Previous generation transcription model with 96.7% accuracy for English. Supports 99 languages with word-level timestamps and speaker diarization.',
				cost: '$0.40/hour',
			},
			{
				name: 'scribe_v1_experimental',
				description:
					'Experimental version of Scribe with latest features and improvements. May include cutting-edge capabilities but with potential instability.',
				cost: '$0.40/hour',
			},
		],
		capabilities: {
			supportsPrompt: true,
			supportsLanguage: true,
		},
	},
	Deepgram: {
		label: 'Deepgram',
		location: 'cloud',
		defaultModel: 'nova-3',
		models: [
			{
				name: 'nova-3',
				description:
					"Deepgram's most advanced speech-to-text model with superior accuracy and speed. Best for high-quality transcription needs.",
				cost: '$0.0043/minute',
			},
			{
				name: 'nova-2',
				description: "Deepgram's previous best speech-to-text model.",
				cost: '$0.0043/minute',
			},
			{
				name: 'nova',
				description:
					'Deepgram Nova model with excellent accuracy and performance. Good balance of speed and quality.',
				cost: '$0.0043/minute',
			},
			{
				name: 'enhanced',
				description:
					'Enhanced general-purpose model with good accuracy for most use cases. Cost-effective option.',
				cost: '$0.0025/minute',
			},
			{
				name: 'base',
				description:
					'Base model for standard transcription needs. Most cost-effective option with reasonable accuracy.',
				cost: '$0.0020/minute',
			},
		],
		capabilities: {
			supportsPrompt: true,
			supportsLanguage: true,
		},
	},
	Mistral: {
		label: 'Mistral AI',
		location: 'cloud',
		defaultModel: 'voxtral-mini-latest',
		models: [
			{
				name: 'voxtral-mini-latest',
				description:
					'API-optimized Voxtral Mini model delivering unparalleled cost and latency efficiency. Supports multilingual transcription with high accuracy.',
				cost: '$0.12/hour',
			},
			{
				name: 'voxtral-small-latest',
				description:
					'Voxtral Small model for higher accuracy and broader language support. Suitable for most transcription needs with a balance of cost and performance.',
				cost: '$0.24/hour',
			},
		],
		capabilities: {
			supportsPrompt: true,
			supportsLanguage: true,
		},
	},

	// ── Local services ──────────────────────────────────────────────
	// Models are null here because the local model catalogs (download URLs,
	// sizes, ONNX directory shapes) live in `./local-models.ts`. This map
	// only carries the user-facing label and capability flags.
	whispercpp: {
		label: 'Whisper C++',
		location: 'local',
		models: null,
		capabilities: {
			supportsPrompt: true,
			supportsLanguage: true,
		},
	},
	parakeet: {
		label: 'Parakeet',
		location: 'local',
		models: null,
		capabilities: {
			supportsPrompt: false,
			supportsLanguage: false,
		},
	},
	moonshine: {
		label: 'Moonshine',
		location: 'local',
		models: null,
		capabilities: {
			supportsPrompt: false,
			supportsLanguage: false,
		},
	},

	// ── Self-hosted services ────────────────────────────────────────
	// Models are null — user specifies model ID at runtime.
	speaches: {
		label: 'Speaches',
		location: 'self-hosted',
		models: null,
		capabilities: {
			supportsPrompt: true,
			supportsLanguage: true,
		},
	},
} as const;

export type TranscriptionServiceId = keyof typeof TRANSCRIPTION;

/** Every transcription service ID, e.g. for `column.enum(TRANSCRIPTION_SERVICE_IDS)`. */
export const TRANSCRIPTION_SERVICE_IDS = Object.keys(
	TRANSCRIPTION,
) as TranscriptionServiceId[];

/** Lookup: service ID → display label. */
export const TRANSCRIPTION_SERVICE_ID_TO_LABEL = Object.fromEntries(
	TRANSCRIPTION_SERVICE_IDS.map((id) => [id, TRANSCRIPTION[id].label]),
) as Record<TranscriptionServiceId, string>;

/**
 * When to drop the resident local transcription model from memory after the
 * user stops transcribing. Single source of truth: the OPTIONS array below
 * carries values, labels, and descriptions; the tuple and union type are
 * derived from it (same pattern as TRANSCRIPTION → TRANSCRIPTION_SERVICE_IDS).
 *
 * Mirrored in Rust by the `UnloadPolicy` enum in
 * `src-tauri/src/transcription/config.rs` (serde rename tags pair each value
 * with a variant). If you add a value here, add a matching variant there.
 *
 * Default order is UX order (recommended first), not alphabetical.
 */
export const LOCAL_MODEL_UNLOAD_POLICY_OPTIONS = [
	{
		value: 'after_5_minutes',
		label: 'After 5 minutes',
		description: 'Drop the model after 5 minutes of inactivity. Good default.',
	},
	{
		value: 'after_30_minutes',
		label: 'After 30 minutes',
		description:
			'Drop the model after 30 minutes of inactivity. Useful for bursty workflows.',
	},
	{
		value: 'immediately',
		label: 'Immediately',
		description:
			'Drop after every transcription. Minimum memory, slowest next transcription.',
	},
	{
		value: 'never',
		label: 'Never',
		description: 'Keep the model resident until the app exits.',
	},
] as const;

export type LocalModelUnloadPolicy =
	(typeof LOCAL_MODEL_UNLOAD_POLICY_OPTIONS)[number]['value'];

/** Convenience array for `type.enumerated(...LOCAL_MODEL_UNLOAD_POLICIES)`. */
export const LOCAL_MODEL_UNLOAD_POLICIES =
	LOCAL_MODEL_UNLOAD_POLICY_OPTIONS.map(
		(o) => o.value,
	) as LocalModelUnloadPolicy[];
