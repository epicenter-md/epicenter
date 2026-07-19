/**
 * The recorder switcher's row source: `readyTranscribers()`, a flat list of the
 * transcribers usable *right now*. It is a union of two honestly
 * different producers (see the reconciliation spec):
 *
 *  - the static non-onDevice provider registry (`session` / `key` / `endpoint`),
 *    filtered to the ones configured, one transcriber each; and
 *  - the live on-device catalog (`localModels`), filtered to the downloaded
 *    GGUFs, one transcriber per model.
 *
 * Same transcriber shape, different provenance. Each producer computes its own
 * `title` and exact-model fields where it already reads its own store, so the
 * selector does not need cross-store display branching.
 * Reactive by construction: the getters it reads (`settings`, `secrets`,
 * `auth`, `deviceConfig`, `localModels`) are all reactive, so calling this
 * inside a `$derived` re-runs it when any source changes.
 */
import { tauri } from '#platform/tauri';
import {
	PROVIDER_ICONS,
	TRANSCRIPTION_PROVIDERS,
	type TranscriptionProviderEntry,
} from '$lib/services/transcription/provider-ui';
import { deviceConfig } from '$lib/state/device-config.svelte';
import { localModels } from '$lib/state/local-models.svelte';
import type { ModelInfo } from '$lib/tauri/commands.types';
import type { WhisperingApp } from '$lib/whispering/app';
import { isTranscriptionServiceConfigured } from './transcription-validation';

/**
 * One ready transcriber: a configured remote service or downloaded local model
 * that can turn captured audio into text immediately. Each producer fills the
 * display fields from the store it owns.
 */
export type Transcriber = {
	/** Stable list/cmdk key. Remote providers: provider id. On-device: model id. */
	key: string;
	access: 'session' | 'key' | 'endpoint' | 'onDevice';
	/** Brand glyph markup from `PROVIDER_ICONS` (local shares the ggml icon). */
	icon: string;
	invertInDarkMode: boolean;
	/**
	 * The compact trigger and row title. On-device transcribers use the curated
	 * model name; every remote provider uses its provider label. This is
	 * unambiguous because each remote provider contributes one transcriber.
	 */
	title: string;
	/** The exact configured model for keyed and endpoint providers. */
	modelId?: string;
	/** The endpoint provider's configured host. */
	endpointHost?: string;
	/** The cmdk search string (also its unique `value`). */
	keywords: string;
	/** True when this transcriber is the current active selection. */
	isActive: boolean;
	/** Write today's selection keys to make this the active transcriber. */
	select: () => void;
};

/** The endpoint provider's host; the raw string if it won't parse. */
function endpointHost(endpoint: string): string {
	try {
		return new URL(endpoint).host || endpoint;
	} catch {
		return endpoint;
	}
}

/** Every non-onDevice provider: reached over the wire, one ready transcriber each. */
type RemoteEntry = Extract<
	TranscriptionProviderEntry,
	{ access: 'session' | 'key' | 'endpoint' }
>;

const REMOTE_ENTRIES = TRANSCRIPTION_PROVIDERS.filter(
	(entry): entry is RemoteEntry => entry.access !== 'onDevice',
);

/** A configured remote provider -> its one ready transcriber. */
function toRemoteTranscriber(
	app: WhisperingApp,
	entry: RemoteEntry,
): Transcriber {
	const base = {
		key: entry.id,
		icon: entry.icon,
		invertInDarkMode: entry.invertInDarkMode,
		isActive: app.settings.get('transcription.service') === entry.id,
		select: () => app.settings.set('transcription.service', entry.id),
	};
	switch (entry.access) {
		case 'session':
			// Fixed wire model, metered by duration: the provider name is the whole
			// story, no model shown.
			return {
				...base,
				access: 'session',
				title: entry.label,
				keywords: `${entry.id} ${entry.label} epicenter hosted account credits`,
			};
		case 'key': {
			// The provider is the route identity; the committed model remains visible
			// as exact context in the expanded row.
			const model =
				app.settings.get(entry.modelSettingKey) || entry.defaultModel;
			return {
				...base,
				access: 'key',
				title: entry.label,
				modelId: model,
				keywords: `${entry.id} ${entry.label} ${model} cloud api key`,
			};
		}
		case 'endpoint': {
			// Preserve #2337's exact model confirmation without making an arbitrary
			// server identifier the compact trigger's primary label.
			const endpoint = deviceConfig.get(entry.endpointConfigKey);
			const modelId = deviceConfig.get(entry.modelIdConfigKey);
			return {
				...base,
				access: 'endpoint',
				title: entry.label,
				modelId,
				endpointHost: endpointHost(endpoint),
				keywords: `${entry.id} ${entry.label} ${modelId} ${endpoint} custom server self-hosted`,
			};
		}
	}
}

/** A downloaded on-device GGUF -> its one ready transcriber. */
function toLocalTranscriber(app: WhisperingApp, model: ModelInfo): Transcriber {
	return {
		key: model.id,
		access: 'onDevice',
		icon: PROVIDER_ICONS.local.icon,
		invertInDarkMode: PROVIDER_ICONS.local.invertInDarkMode,
		title: model.name,
		keywords: `${model.id} ${model.name} ${model.description} local on-device offline gguf whisper private`,
		isActive:
			app.settings.get('transcription.service') === 'local' &&
			deviceConfig.get('transcription.local.selectedModel') === model.id,
		select: () => {
			app.settings.set('transcription.service', 'local');
			deviceConfig.set('transcription.local.selectedModel', model.id);
		},
	};
}

/**
 * The switcher's row source: on-device transcribers first (privacy-forward),
 * then configured remote services. On-device is empty off Tauri (the store
 * never scans on web). Membership is the store's own per-model `downloaded`
 * verdict, never the raw deviceConfig pointer.
 */
export function readyTranscribers(app: WhisperingApp): Transcriber[] {
	const remote = REMOTE_ENTRIES.filter((entry) =>
		isTranscriptionServiceConfigured(entry),
	).map((entry) => toRemoteTranscriber(app, entry));
	const onDevice = tauri
		? localModels.models
				.filter((model) => model.downloaded)
				.map((model) => toLocalTranscriber(app, model))
		: [];
	return [...onDevice, ...remote];
}
