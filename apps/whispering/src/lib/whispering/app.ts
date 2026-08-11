import type { BoundData, Epicenter } from '@epicenter/data/legacy';
import type { TranscriptionServiceId } from '../services/transcription/providers';
import {
	createWhisperingSettingDefaults,
	whisperingLens,
} from '../workspace';
import {
	settingFieldName,
	WHISPERING_SETTINGS_ROW_ID,
} from '../workspace/contract';
import {
	createWhisperingRecipes,
	type WhisperingRecipes,
} from './recipes.svelte';
import type { WhisperingBlobs } from './recording-audio';
import {
	createWhisperingRecordings,
	type WhisperingRecordings,
} from './recordings';

export type { WhisperingBlobs } from './recording-audio';

export type WhisperingData = BoundData<typeof whisperingLens.tables>;

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
			table: whispering.recordings,
			blobs,
			reportBackgroundError,
		});
		const recipesDomain = createWhisperingRecipes({
			table: whispering.recipes,
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

/** The resolved settings values, as the Lens declares them. */
type WhisperingSettingValues = NonNullable<
	ReturnType<WhisperingData['kv']['get']>['data']
>;
type SettingKey = keyof WhisperingSettingValues;

/**
 * Settings over the Lens's KV, which is one name-addressed root.
 *
 * What this replaces was substantial and every piece of it answered a problem
 * that no longer exists. Settings were one ROW at a chosen id, so there was a
 * row id constant, a `settingFieldName` mapping from setting to column, and a
 * read that had to create the row when it was missing. Reads were asynchronous,
 * so there were per-key read generations, a `bumpGeneration` on every read and
 * write, an `isReleased` guard, and a background write queue that reconciled
 * `loadError` after the fact. Values came back live, so every read and write
 * ran `structuredClone`.
 *
 * KV is a reserved root, reads are synchronous, and a read hands back a plain
 * object (ADR-0213, ADR-0215, ADR-0216). So a read is a read, a write names its
 * keys, and an unwritten key returns its declared default without anything
 * creating a row to hold it.
 */
function createWhisperingSettings({ kv }: { kv: WhisperingData['kv'] }) {
	let values = kv.defaults as WhisperingSettingValues;
	let loadError: unknown = null;
	const listeners = new Set<() => void>();
	const notify = () => {
		for (const listener of listeners) listener();
	};

	function read(): void {
		const { data, error } = kv.get();
		if (error !== null) {
			// A stored value the current release cannot read costs that key, not
			// the whole object: `conforming` carries the ones that did pass.
			loadError = error;
			values = {
				...kv.defaults,
				...(error as { conforming?: Partial<WhisperingSettingValues> })
					.conforming,
			} as WhisperingSettingValues;
			notify();
			return;
		}
		values = data;
		loadError = null;
		notify();
	}

	read();
	const stop = kv.subscribe(read);

	const write = (patch: Partial<WhisperingSettingValues>): void => {
		const { error } = kv.update(patch);
		if (error !== null) {
			loadError = error;
			notify();
			return;
		}
		read();
	};

	const settings: WhisperingSettings = {
		get<TKey extends SettingKey>(key: TKey) {
			return values[key];
		},
		set<TKey extends SettingKey>(
			key: TKey,
			value: WhisperingSettingValues[TKey],
		) {
			write({ [key]: value } as Partial<WhisperingSettingValues>);
		},
		getDefault<TKey extends SettingKey>(key: TKey) {
			return (kv.defaults as WhisperingSettingValues)[key];
		},
		reset() {
			write(kv.defaults as WhisperingSettingValues);
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
		[Symbol.dispose]() {
			stop();
			listeners.clear();
		},
	};
}
