import type { AuthClient } from '@epicenter/auth';
import { readArtifact } from '@epicenter/data/artifact';

/** The principal half of an account address, as the auth client states it. */
type PrincipalId = Extract<
	AuthClient['state'],
	{ principalId: unknown }
>['principalId'];

import type { DataOf } from '@epicenter/data';
import {
	type BrowserAccountStore,
	GENERATIONS_ROUTE,
	importGeneration,
	type LocalStore,
	listLocalGenerations,
	openDatabase,
} from '@epicenter/data/browser';
import {
	attachStoreSync,
	type SyncConnection,
	type SyncConnectionStatus,
} from '@epicenter/data/sync';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import {
	type WhisperingSettingValues,
	whisperingDefinition,
} from '../workspace';
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

/** The device-owned document: this machine's settings, and its work when
 * signed out. */
export type WhisperingDeviceData = DataOf<
	typeof whisperingDefinition,
	LocalStore
>;
/** One account's retained replica of the portable work. */
export type WhisperingAccountData = DataOf<
	typeof whisperingDefinition,
	BrowserAccountStore
>;

/**
 * Failures that reach `reportBackgroundError`: work nobody is awaiting, so the
 * only honest response is a log line. The `cause` is `unknown` because these
 * arrive from rejected promises and transport callbacks the app fired and
 * forgot.
 */
export const WhisperingBackgroundError = defineErrors({
	AppFailed: ({ cause }: { cause: unknown }) => ({
		message: 'Whispering app background work failed',
		cause,
	}),
});
export type WhisperingBackgroundError = InferErrors<
	typeof WhisperingBackgroundError
>;

/** Environment-owned inputs for one fully acquired Whispering app. */
export type WhisperingAppDependencies = {
	/**
	 * This build's auth. Read once, as a boot snapshot: it chooses whether this
	 * generation also opens an account replica, and whose (ADR-0233).
	 */
	auth: AuthClient;
	blobs: WhisperingBlobs;
	/**
	 * Where work nobody awaited goes when it fails: a sync dial that could not
	 * reach the network, a discard on the way to adopting a superseded document.
	 */
	reportBackgroundError(cause: unknown): void;
};

/**
 * Hydrated, UI-free settings over typed singleton values.
 *
 * Always the DEVICE document's `kv`, signed in or out. Which microphone
 * shortcut this machine listens for, which transcription service it can reach,
 * and whether it plays a sound are facts about this machine, not portable work
 * (ADR-0233). Recordings and recipes travel; the way this install behaves does
 * not.
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
	subscribe(listener: () => void): () => void;
};

/** Release-local initialization and recovery values for the device KV. */
const APPLICATION_DEFAULTS: Partial<WhisperingSettingValues> = {
	soundManualStart: true,
	soundManualStop: true,
	soundManualCancel: true,
	soundVadStart: true,
	soundVadCapture: true,
	soundVadStop: true,
	soundTranscriptionComplete: true,
	soundRecipeComplete: true,
	outputTranscriptionClipboard: true,
	outputTranscriptionCursor: false,
	outputTranscriptionEnter: false,
	outputRecipeClipboard: true,
	outputRecipeCursor: false,
	outputRecipeEnter: false,
	recordingTrigger: 'manual',
	recordingPausePlayback: false,
	recordingAutoUpload: false,
	transcriptionService: 'local',
	transcriptionOpenaiModel: 'whisper-1',
	transcriptionGroqModel: 'whisper-large-v3-turbo',
	transcriptionElevenlabsModel: 'scribe_v2',
	transcriptionDeepgramModel: 'nova-3',
	transcriptionMistralModel: 'voxtral-mini-latest',
	transcriptionLanguage: 'auto',
	transcriptionPrompt: '',
	completionProvider: 'Google',
	completionModel: 'gemini-2.5-flash',
	dictionary: null,
	polishEnabled: true,
	polishInstructions: 'Fix grammar and punctuation. Keep my wording.',
	analyticsEnabled: true,
	shortcutPushToTalkModifiers: null,
	shortcutPushToTalkKeys: null,
	shortcutToggleManualRecordingModifiers: null,
	shortcutToggleManualRecordingKeys: null,
	shortcutCancelRecordingModifiers: null,
	shortcutCancelRecordingKeys: null,
	shortcutToggleVadRecordingModifiers: null,
	shortcutToggleVadRecordingKeys: null,
	shortcutOpenRecipePickerModifiers: null,
	shortcutOpenRecipePickerKeys: null,
	shortcutRunRecipeOnClipboardModifiers: null,
	shortcutRunRecipeOnClipboardKeys: null,
	shortcutOpenSettingsModifiers: null,
	shortcutOpenSettingsKeys: null,
};

export type WhisperingApp = {
	readonly settings: WhisperingSettings;
	readonly recordings: WhisperingRecordings;
	readonly recipes: WhisperingRecipes;
	/**
	 * What sync is doing, or undefined when this generation has no account or
	 * its dials were permanently denied. A denied bound replica works offline
	 * and shows nothing, correctly.
	 */
	syncStatus(): SyncConnectionStatus | undefined;
	[Symbol.asyncDispose](): Promise<void>;
};

/**
 * Acquire one ready Whispering app over its two documents.
 *
 * The device document opens for every page lifetime and holds this machine's
 * settings. When the boot auth snapshot carries an identity, that principal's
 * retained account replica opens too and sync attaches, and the portable work
 * (recordings, recipes) comes from it; a signed-out generation reads and writes
 * that work on the device document instead. A surface never sees the choice:
 * one `recordings` and one `recipes`, over one document, for the whole
 * generation.
 *
 * The account arm opens one exact generation and is safe to edit the moment it
 * resolves (ADR-0292): a cache hit is already bound and a miss bootstraps the
 * whole state first, so there is no second moment and no boot gate. It never
 * falls back to the device document, because silently writing a signed-in
 * person's recordings into device storage is the one outcome nobody can undo
 * later.
 */
export async function openWhisperingApp(
	{ auth, blobs, reportBackgroundError }: WhisperingAppDependencies,
	{ signal }: { signal?: AbortSignal } = {},
): Promise<WhisperingApp> {
	signal?.throwIfAborted();
	// An auth state carrying no usable principal id is refused inside
	// `openDatabase` as `Unaddressable` rather than guessed at.
	const boot =
		auth.state.status === 'signed-out'
			? undefined
			: { principalId: auth.state.principalId };

	const opened = await openDatabase(whisperingDefinition, {
		generation: await resolveLocalGeneration(),
	});
	if (opened.error !== null) throw opened.error;
	const localData = opened.data;

	let account: AccountRuntime | undefined;
	try {
		signal?.throwIfAborted();
		if (boot !== undefined) {
			account = await openAccountRuntime({
				auth,
				principalId: boot.principalId,
				reportBackgroundError,
				signal,
			});
		}
	} catch (cause) {
		await localData[Symbol.asyncDispose]().catch(() => undefined);
		throw cause;
	}

	// The one place the document choice is made (ADR-0233).
	const work = account?.data ?? localData;
	const settingsDomain = createWhisperingSettings({ kv: localData.kv });
	const recordingsDomain = createWhisperingRecordings({
		table: work.tables.recordings,
		blobs,
	});
	const recipesDomain = createWhisperingRecipes({
		table: work.tables.recipes,
	});

	let disposed = false;
	return Object.freeze({
		settings: settingsDomain.settings,
		recordings: recordingsDomain.recordings,
		recipes: recipesDomain,
		syncStatus: () => account?.syncStatus(),
		async [Symbol.asyncDispose]() {
			if (disposed) return;
			disposed = true;
			recipesDomain[Symbol.dispose]();
			recordingsDomain[Symbol.dispose]();
			settingsDomain[Symbol.dispose]();
			await account?.dispose();
			await localData[Symbol.asyncDispose]();
		},
	});
}

/** The account arm plus the disposal only the app may run. */
type AccountRuntime = {
	data: WhisperingAccountData;
	syncStatus(): SyncConnectionStatus | undefined;
	dispose(): Promise<void>;
};

/**
 * Open one account's replica and see it through its bound gate.
 *
 * Everything sync-shaped lives here, so nothing in a device-only generation can
 * so much as name it. On any failure it lets go of everything it acquired and
 * rethrows.
 */
async function openAccountRuntime({
	auth,
	principalId,
	reportBackgroundError,
	signal,
}: {
	auth: AuthClient;
	/** Exactly what an account address needs, beside the server URL. */
	principalId: PrincipalId;
	reportBackgroundError(cause: unknown): void;
	signal?: AbortSignal;
}): Promise<AccountRuntime> {
	const account = {
		baseURL: auth.connection.baseURL,
		principalId,
		fetch: (input: Request | string | URL, init?: RequestInit) =>
			auth.fetch(input, init),
	};
	const generation = await resolveAccountGeneration(auth, principalId);
	const opened = await openDatabase(whisperingDefinition, {
		generation,
		account,
	});
	if (opened.error !== null) throw opened.error;
	const data = opened.data;

	let sync: SyncConnection | undefined;
	try {
		signal?.throwIfAborted();
		const connection = attachStoreSync({
			store: data.store,
			dataId: whisperingDefinition.id,
			generation,
			transport: {
				openWebSocket: (url) => auth.openWebSocket(url),
			},
			onTransportError: reportBackgroundError,
		});
		sync = connection;

		return {
			data,
			syncStatus: () => {
				const status = connection.status();
				return status.denied ? undefined : status;
			},
			dispose: async () => {
				connection[Symbol.dispose]();
				await data[Symbol.asyncDispose]();
			},
		};
	} catch (cause) {
		sync?.[Symbol.dispose]();
		await data[Symbol.asyncDispose]().catch(() => undefined);
		throw cause;
	}
}

/**
 * The generation this device opens locally, creating one if it holds none.
 *
 * A generation is an address (ADR-0292) and importing is the only way one comes
 * into being (ADR-0293), so "a new local database here" is an import of an
 * empty folder. Newest rather than latest-by-time: the number IS the order.
 */
async function resolveLocalGeneration(): Promise<number> {
	const held = await listLocalGenerations(whisperingDefinition.id);
	const newest = held.at(-1);
	if (newest !== undefined) return newest;
	const state = readArtifact(new Map(), whisperingDefinition);
	if (state.error !== null) throw state.error;
	const created = await importGeneration(whisperingDefinition, state.data);
	if (created.error !== null) throw created.error;
	return created.data.generation;
}

/**
 * The account generation this device opens: its own newest copy, or the
 * account's newest.
 *
 * Never creates one. An account generation is the account's, and a device
 * arriving second must not invent a history for it.
 */
async function resolveAccountGeneration(
	auth: AuthClient,
	principalId: PrincipalId,
): Promise<number> {
	const held = await listLocalGenerations(whisperingDefinition.id, {
		baseURL: auth.connection.baseURL,
		principalId,
	});
	const newest = held.at(-1);
	if (newest !== undefined) return newest;
	const listed = await auth.fetch(
		GENERATIONS_ROUTE.collection(
			auth.connection.baseURL,
			whisperingDefinition.id,
		),
	);
	if (!listed.ok) {
		throw new Error(
			`Whispering could not ask your account which recordings it holds (${listed.status}).`,
		);
	}
	const { generations } = (await listed.json()) as { generations: number[] };
	const latest = generations.at(-1);
	if (latest !== undefined) return latest;
	// An EMPTY list is a first run, not a refusal, and the distinction is the
	// listing itself: a failed one already threw above. Creating the account's
	// first generation is an import of an empty folder (ADR-0293), which is the
	// only way one ever comes into being; what a device must not do is invent
	// one because it could not SEE what the account has.
	const state = readArtifact(new Map(), whisperingDefinition);
	if (state.error !== null) throw state.error;
	const created = await importGeneration(whisperingDefinition, state.data, {
		account: {
			baseURL: auth.connection.baseURL,
			principalId,
			fetch: (input: Request | string | URL, init?: RequestInit) =>
				auth.fetch(input, init),
		},
	});
	if (created.error !== null) throw created.error;
	return created.data.generation;
}

type SettingKey = keyof WhisperingSettingValues;

/**
 * Settings over the workspace's KV, which is one name-addressed root.
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
 * object or a conformance diagnostic (ADR-0213, ADR-0215, ADR-0216). So a read
 * is a read, a write names its keys, and application recovery handles missing
 * values without creating a row to hold them.
 */
function createWhisperingSettings({ kv }: { kv: WhisperingDeviceData['kv'] }) {
	let values = { ...APPLICATION_DEFAULTS } as WhisperingSettingValues;
	const listeners = new Set<() => void>();
	const notify = () => {
		for (const listener of listeners) listener();
	};

	function read(): void {
		const { data, error } = kv.get();
		if (error !== null) {
			// A stored value the current release cannot read costs those keys, not
			// the whole object: the error arm is always the diagnostic, and its
			// `conforming` carries the ones that did pass.
			values = {
				...APPLICATION_DEFAULTS,
				...error.conforming,
			} as WhisperingSettingValues;
			notify();
			return;
		}
		values = data;
		notify();
	}

	read();
	const stop = kv.subscribe(read);

	const write = (patch: Partial<WhisperingSettingValues>): void => {
		kv.update(patch);
		// The subscription above already re-read inside the write; nothing left
		// to refresh here.
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
			return APPLICATION_DEFAULTS[key] as WhisperingSettingValues[TKey];
		},
		reset() {
			write(APPLICATION_DEFAULTS);
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
