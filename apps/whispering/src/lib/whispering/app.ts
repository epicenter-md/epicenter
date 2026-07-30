import type { BoundData, Epicenter, ValueLens } from '@epicenter/data';
import type { TranscriptionServiceId } from '../services/transcription/providers';
import {
	createWhisperingSettingDefaults,
	type WhisperingSettingValues,
	whisperingLens,
} from '../workspace';
import { createWhisperingRecipes, type WhisperingRecipes } from './recipes';
import type { WhisperingBlobs } from './recording-audio';
import {
	createWhisperingRecordings,
	type WhisperingRecordings,
} from './recordings';

export type { WhisperingBlobs } from './recording-audio';

export type WhisperingData = BoundData<
	typeof whisperingLens.tables,
	typeof whisperingLens.values
>;

/** Environment-owned inputs for one fully acquired Whispering app. */
export type WhisperingAppDependencies = {
	openEpicenter(): Promise<Epicenter>;
	blobs: WhisperingBlobs;
	defaultTranscriptionService: TranscriptionServiceId;
	reportBackgroundError(cause: unknown): void;
};

/**
 * Hydrated, UI-free settings over typed singleton values. Reads stay
 * synchronous for existing app consumers; each value subscription refreshes
 * the cache after local or synchronized commits.
 */
export type WhisperingSettings = {
	get<TKey extends keyof WhisperingSettingValues>(
		key: TKey,
	): WhisperingSettingValues[TKey];
	set<TKey extends keyof WhisperingSettingValues>(
		key: TKey,
		value: WhisperingSettingValues[TKey],
	): void;
	getDefault<TKey extends keyof WhisperingSettingValues>(
		key: TKey,
	): WhisperingSettingValues[TKey];
	reset(): void;
	readonly loadError: unknown;
	subscribe(listener: () => void): () => void;
};

export type WhisperingApp = {
	readonly settings: WhisperingSettings;
	readonly recordings: WhisperingRecordings;
	readonly recipes: WhisperingRecipes;
	[Symbol.asyncDispose](): Promise<void>;
};

function clone<TValue>(value: TValue): TValue {
	return structuredClone(value);
}

/** Acquire one ready Whispering facade over an environment-owned Epicenter. */
export async function openWhisperingApp(
	{
		openEpicenter,
		blobs,
		defaultTranscriptionService,
		reportBackgroundError,
	}: WhisperingAppDependencies,
	{ signal }: { signal?: AbortSignal } = {},
): Promise<WhisperingApp> {
	let epicenter: Epicenter | undefined;
	let disposeDomains: (() => void) | undefined;
	let released = false;
	let releasePromise: Promise<void> | undefined;

	const release = (): Promise<void> => {
		releasePromise ??= (async () => {
			released = true;
			signal?.removeEventListener('abort', onAbort);
			disposeDomains?.();
			await epicenter?.[Symbol.asyncDispose]();
		})();
		return releasePromise;
	};
	const aborted = Promise.withResolvers<never>();
	const onAbort = () => {
		aborted.reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
		void release().catch(reportBackgroundError);
	};
	signal?.addEventListener('abort', onAbort, { once: true });
	const untilAbort = <TValue>(work: Promise<TValue>): Promise<TValue> =>
		signal ? Promise.race([work, aborted.promise]) : work;

	try {
		signal?.throwIfAborted();
		const opened = await untilAbort(
			openEpicenter().then(async (value) => {
				epicenter = value;
				if (released) await value[Symbol.asyncDispose]();
				return value;
			}),
		);
		const whispering = opened.bind(whisperingLens);
		const settingsDomain = createWhisperingSettings({
			data: whispering,
			defaults: createWhisperingSettingDefaults(defaultTranscriptionService),
			isReleased: () => released,
			reportBackgroundError,
		});
		const recordingsDomain = createWhisperingRecordings({
			table: whispering.tables.recordings,
			blobs,
			reportBackgroundError,
		});
		const recipesDomain = createWhisperingRecipes({
			table: whispering.tables.recipes,
			reportBackgroundError,
		});
		disposeDomains = () => {
			settingsDomain.dispose();
			recordingsDomain.dispose();
			recipesDomain.dispose();
		};
		await untilAbort(
			Promise.all([
				settingsDomain.ready,
				recordingsDomain.ready,
				recipesDomain.ready,
			]),
		);
		signal?.throwIfAborted();
		signal?.removeEventListener('abort', onAbort);
		return Object.freeze({
			settings: settingsDomain.settings,
			recordings: recordingsDomain.recordings,
			recipes: recipesDomain.recipes,
			[Symbol.asyncDispose]: release,
		});
	} catch (cause) {
		try {
			await release();
		} catch (releaseCause) {
			throw new AggregateError(
				[cause, releaseCause],
				'Whispering app acquisition and cleanup failed',
			);
		}
		throw cause;
	}
}

type SettingKey = keyof WhisperingSettingValues;

function createWhisperingSettings({
	data,
	defaults,
	isReleased,
	reportBackgroundError,
}: {
	data: WhisperingData;
	defaults: WhisperingSettingValues;
	isReleased(): boolean;
	reportBackgroundError(cause: unknown): void;
}) {
	const keys = Object.keys(defaults) as SettingKey[];
	const values = new Map<SettingKey, unknown>();
	const listeners = new Set<() => void>();
	let loadError: unknown = null;
	/**
	 * Per-key read generations.
	 *
	 * Every read of a key and every local write to it bumps that key's
	 * generation, and a read installs its answer only if the generation it
	 * started with is still current. That is what lets one key's slow read run
	 * beside another key's write without either clobbering the other, and it is
	 * per key because the reads are per key.
	 */
	const readGenerations = new Map<SettingKey, number>();
	const bumpGeneration = (key: SettingKey): number => {
		const next = (readGenerations.get(key) ?? 0) + 1;
		readGenerations.set(key, next);
		return next;
	};
	const notify = () => {
		for (const listener of listeners) listener();
	};
	const lens = <TKey extends SettingKey>(key: TKey) =>
		data.values[key] as ValueLens<(typeof whisperingLens.values)[TKey]>;

	async function read<TKey extends SettingKey>(key: TKey) {
		const result = await lens(key).get();
		return clone(
			result.error === null ? (result.data ?? defaults[key]) : defaults[key],
		);
	}

	/**
	 * Read every setting once, for boot and for an explicit reload.
	 *
	 * Still batched: at first paint nothing is known yet, so thirty-seven reads
	 * issued together beat thirty-seven rounds of the same work.
	 */
	async function refreshAll(): Promise<void> {
		const started = new Map(keys.map((key) => [key, bumpGeneration(key)]));
		const next = await Promise.all(
			keys.map(async (key) => [key, await read(key)] as const),
		);
		if (isReleased()) return;
		for (const [key, value] of next) {
			if (readGenerations.get(key) !== started.get(key)) continue;
			values.set(key, value);
		}
		loadError = null;
		notify();
	}

	/**
	 * Re-read one setting, because one setting is what moved.
	 *
	 * A value invalidation names the handle that changed and nothing smaller, so
	 * the honest response is to re-read that handle. Re-reading all thirty-seven
	 * on every change was thirty-seven reads per keystroke-sized edit, and it
	 * scaled with how many settings exist rather than with what happened.
	 */
	async function refreshOne(key: SettingKey): Promise<void> {
		const generation = bumpGeneration(key);
		const value = await read(key);
		if (isReleased()) return;
		if (readGenerations.get(key) !== generation) return;
		values.set(key, value);
		loadError = null;
		notify();
	}

	const inBackground = (work: Promise<unknown>): void => {
		void work.then(
			() => {
				if (isReleased() || loadError === null) return;
				loadError = null;
				notify();
			},
			(cause) => {
				if (isReleased()) return;
				loadError = cause;
				notify();
				reportBackgroundError(cause);
			},
		);
	};

	const stopValues = keys.map((key) =>
		lens(key).subscribe(() => inBackground(refreshOne(key))),
	);
	const ready = refreshAll();
	const settings: WhisperingSettings = {
		get<TKey extends SettingKey>(key: TKey) {
			return clone(values.get(key) as WhisperingSettingValues[TKey]);
		},
		set<TKey extends SettingKey>(
			key: TKey,
			value: WhisperingSettingValues[TKey],
		) {
			bumpGeneration(key);
			values.set(key, clone(value));
			notify();
			inBackground(lens(key).set(clone(value)));
		},
		getDefault<TKey extends SettingKey>(key: TKey) {
			return clone(defaults[key]);
		},
		reset() {
			for (const key of keys) {
				bumpGeneration(key);
				values.set(key, clone(defaults[key]));
				inBackground(lens(key).unset());
			}
			notify();
		},
		get loadError() {
			return loadError;
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};

	return {
		settings,
		ready,
		dispose() {
			for (const key of keys) bumpGeneration(key);
			for (const stop of stopValues) stop();
			listeners.clear();
		},
	};
}
