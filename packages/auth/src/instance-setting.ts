import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { type Instance, normalizeInstanceUrl } from './instance.js';

const InstanceSettingError = defineErrors({
	/** The stored record could not be read (a throwing `getItem`). */
	Unreadable: ({ cause }: { cause: unknown }) => ({
		message: `Could not read the stored instance setting; falling back to the hosted default: ${extractErrorMessage(cause)}`,
		cause,
	}),
	/** The stored record was present but not parseable JSON. */
	Corrupt: ({ cause }: { cause: unknown }) => ({
		message: `Discarding a corrupt instance setting; falling back to the hosted default: ${extractErrorMessage(cause)}`,
		cause,
	}),
});

/**
 * The persisted instance setting as a small handle every client shares.
 *
 * One concept, injected per app: the storage substrate (synchronous
 * `localStorage`, an async `chrome.storage`) is the only thing that varies, so
 * the read/write/clear contract and the hosted-default invariant live here once
 * instead of being re-implemented in every app's `instance.ts`.
 *
 * `read()` returns the boot snapshot (the value read when the handle was built);
 * `write`/`clear` persist and update that snapshot. Apps reload after a write so
 * auth construction re-reads, mirroring how {@link PersistedAuthStorage} is read
 * once at construction.
 */
export type InstanceSetting = {
	/** The boot snapshot: the persisted instance, or the hosted default. */
	read(): Instance;
	/** True when the snapshot is the hosted default (no self-host override). */
	isDefault(): boolean;
	/** Persist an override and update the snapshot. */
	write(next: Instance): void | Promise<void>;
	/** Forget the override, reverting the snapshot to the hosted default. */
	clear(): void | Promise<void>;
};

/**
 * Decode a stored record into an {@link Instance}, falling back to the hosted
 * default. The single owner of the "a half-configured or corrupt record reads as
 * hosted" rule, including the ADR-0071 invariant: OAuth runs only against the
 * hosted default, so a non-hosted base URL with no token cannot authenticate and
 * reads as the hosted default rather than a wedged override.
 *
 * A corrupt record (present but not parseable) is logged before the fallback, so
 * a self-hoster whose stored bearer was mangled can tell it apart from "never
 * configured" instead of silently reading as the hosted default.
 */
function decodeInstance(
	raw: string | null,
	defaultBaseURL: string,
	log: Logger,
): Instance {
	const hosted: Instance = { baseURL: defaultBaseURL };
	if (raw === null) return hosted;
	let parsed: Partial<Instance>;
	try {
		parsed = JSON.parse(raw) as Partial<Instance>;
	} catch (cause) {
		log.warn(InstanceSettingError.Corrupt({ cause }));
		return hosted;
	}
	// Re-normalize on read so a hand-edited record cannot smuggle in a malformed
	// origin.
	const { data: baseURL } = normalizeInstanceUrl(String(parsed.baseURL ?? ''));
	if (!baseURL) return hosted;
	const token =
		typeof parsed.token === 'string' && parsed.token.trim() !== ''
			? parsed.token
			: undefined;
	// ADR-0071: a custom instance requires a token; OAuth is hosted-only.
	if (baseURL !== defaultBaseURL && !token) return hosted;
	return { baseURL, token };
}

function isHostedDefault(instance: Instance, defaultBaseURL: string): boolean {
	return instance.baseURL === defaultBaseURL && instance.token === undefined;
}

/**
 * Build an {@link InstanceSetting} over a `persist` sink. Private: the two public
 * factories below differ only in how they read the boot snapshot and persist.
 */
function makeInstanceSetting({
	initial,
	defaultBaseURL,
	persist,
}: {
	initial: Instance;
	defaultBaseURL: string;
	persist: (serialized: string | null) => void | Promise<void>;
}): InstanceSetting {
	let current = initial;
	return {
		read: () => current,
		isDefault: () => isHostedDefault(current, defaultBaseURL),
		write(next) {
			current = next;
			return persist(JSON.stringify(next));
		},
		clear() {
			current = { baseURL: defaultBaseURL };
			return persist(null);
		},
	};
}

/**
 * Build an {@link InstanceSetting} over a synchronous Web `Storage`
 * (`localStorage` in a browser tab or a Tauri webview).
 *
 * `storage` may be `undefined` (SSR import with no `localStorage`); the handle
 * then reports the hosted default and persists nothing. Reads are guarded so a
 * throwing `getItem` (private-mode Safari) reads as the default and is logged;
 * writes propagate so a credential that could not be persisted fails loudly,
 * matching {@link createWebStoragePersistedAuthStorage}.
 */
export function createInstanceSetting({
	storageKey,
	defaultBaseURL,
	storage,
	log = createLogger('auth/instance-setting'),
}: {
	storageKey: string;
	defaultBaseURL: string;
	storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined;
	/** Library logger for corrupt or unreadable stored records. */
	log?: Logger;
}): InstanceSetting {
	let raw: string | null = null;
	try {
		raw = storage?.getItem(storageKey) ?? null;
	} catch (cause) {
		log.warn(InstanceSettingError.Unreadable({ cause }));
		raw = null;
	}
	return makeInstanceSetting({
		initial: decodeInstance(raw, defaultBaseURL, log),
		defaultBaseURL,
		persist: (serialized) => {
			if (!storage) return;
			if (serialized === null) {
				storage.removeItem(storageKey);
				return;
			}
			storage.setItem(storageKey, serialized);
		},
	});
}
