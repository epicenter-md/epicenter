/**
 * Tab Manager application acquisition: open the platform, bind the Lens, build
 * the side panel's capabilities and state, and hand back one ready handle.
 *
 * Ownership in one sentence: the open side panel document owns one Epicenter
 * browser replica, and the MV3 background service worker owns no database.
 *
 * Everything fallible happens inside this call, which the side panel root renders
 * through a single `{#await}`. Nothing here is module state and nothing runs at
 * import, so a failure (storage refused, another panel already holds the lock)
 * surfaces in a mounted error boundary instead of blanking the document. The
 * returned handle is frozen and disposes in the reverse order it was built.
 *
 * Sign-in is an enhancement, never a door (ADR-0088). The replica is the same one
 * signed in or out; `openRuntime` attaches a sync session when auth has one.
 * Nothing below this boundary branches on auth.
 */

import {
	createLocalToolCatalog,
	defaultApprovalDecision,
} from '@epicenter/agent';
import { createAgentChatState } from '@epicenter/app-shell/agent-chat';
import {
	createInferenceConnections,
	type InferenceConnections,
} from '@epicenter/app-shell/inference-picker';
import type { InstanceSetting, SyncAuthClient } from '@epicenter/auth';
import { toHostedCatalog } from '@epicenter/constants/ai-providers';
import { API_ROUTES } from '@epicenter/constants/api-routes';
import { APP_URLS } from '@epicenter/constants/vite';
import type { Epicenter, SyncStatus } from '@epicenter/data';
import type { StorageItemKey } from '@wxt-dev/storage';
import { createTabManagerActions, type TabManagerActions } from '$lib/actions';
import { APP_MODELS, DEFAULT_MODEL } from '$lib/chat/models';
import {
	buildDeviceConstraints,
	TAB_MANAGER_SYSTEM_PROMPT,
} from '$lib/chat/system-prompt';
import { type DeviceProfile, registerDevice } from '$lib/device';
import { createBookmarkState } from '$lib/state/bookmark-state.svelte';
import { createSavedTabState } from '$lib/state/saved-tab-state.svelte';
import { createStorageState } from '$lib/state/storage-state.svelte';
import { createToolTrustState } from '$lib/state/tool-trust.svelte';
import { createUnifiedViewState } from '$lib/state/unified-view-state.svelte';
import { type TabManagerData, tabManagerLens } from '$lib/workspace';

/**
 * The extension platform, acquired once per side panel document: the persisted
 * auth client, the instance choice, this device's identity, and this document's
 * replica.
 *
 * These arrive together because `chrome.storage` is asynchronous and the replica
 * opener needs the auth client that the same read produced. Disposing releases
 * the replica and its Web Lock.
 */
export type TabManagerRuntime = {
	auth: SyncAuthClient;
	instanceSetting: InstanceSetting;
	profile: DeviceProfile;
	epicenter: Epicenter;
	[Symbol.asyncDispose](): Promise<void>;
};

export type TabManagerDependencies = {
	openRuntime(): Promise<TabManagerRuntime>;
	reportBackgroundError(cause: unknown): void;
};

/** The reactive state the side panel's components read. */
export type TabManagerState = {
	savedTabs: ReturnType<typeof createSavedTabState>;
	bookmarks: ReturnType<typeof createBookmarkState>;
	toolTrust: ReturnType<typeof createToolTrustState>;
	unifiedView: ReturnType<typeof createUnifiedViewState>;
	aiChat: ReturnType<typeof createAgentChatState>;
};

export type TabManagerApplication = TabManagerData & {
	readonly auth: SyncAuthClient;
	readonly instanceSetting: InstanceSetting;
	/** Chrome and durable-row capabilities; also the agent's tool surface. */
	readonly actions: TabManagerActions;
	/** This device's inference connection registry (ADR-0059). */
	readonly connections: InferenceConnections;
	readonly state: TabManagerState;
	readonly syncStatus: SyncStatus;
	subscribeSyncStatus(listener: (status: SyncStatus) => void): () => void;
	[Symbol.asyncDispose](): Promise<void>;
};

/** Open one fully acquired and hydrated Tab Manager application. */
export async function openTabManagerApplication(
	{ openRuntime, reportBackgroundError }: TabManagerDependencies,
	{ signal }: { signal?: AbortSignal } = {},
): Promise<TabManagerApplication> {
	let runtime: TabManagerRuntime | undefined;
	let chat: ReturnType<typeof createAgentChatState> | undefined;
	let released = false;
	let releasePromise: Promise<void> | undefined;
	const release = (): Promise<void> => {
		releasePromise ??= (async () => {
			released = true;
			signal?.removeEventListener('abort', onAbort);
			const failures: unknown[] = [];
			try {
				chat?.[Symbol.dispose]();
			} catch (cause) {
				failures.push(cause);
			}
			try {
				await runtime?.[Symbol.asyncDispose]();
			} catch (cause) {
				failures.push(cause);
			}
			if (failures.length > 0) {
				throw new AggregateError(
					failures,
					'Tab Manager application cleanup failed',
				);
			}
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
		// Record the runtime the moment it arrives and dispose it here if release
		// already ran, so an abort during acquisition never orphans the replica or
		// its Web Lock.
		const opened = await untilAbort(
			openRuntime().then(async (acquired) => {
				runtime = acquired;
				if (released) await acquired[Symbol.asyncDispose]();
				return acquired;
			}),
		);
		signal?.throwIfAborted();

		const data = opened.epicenter.bind(tabManagerLens);
		const actions = createTabManagerActions({
			data,
			nodeId: opened.profile.nodeId,
		});

		// Device-local, never synced: an API key is a secret and a `localhost` URL
		// is meaningless elsewhere (ADR-0004). Built here rather than at module
		// scope so the hosted transport closes over this document's real auth
		// client instead of reaching back through a deferred accessor.
		const connections = createInferenceConnections({
			storageKey: 'tab-manager',
			hostedModels: toHostedCatalog(APP_MODELS),
			hosted: {
				fetch: (input, init) => opened.auth.fetch(input, init),
				baseURL: API_ROUTES.ai.baseUrl(APP_URLS.API),
			},
			persist: (key, schema, fallback) =>
				createStorageState(`local:${key}` as StorageItemKey, {
					schema,
					fallback,
				}),
		});

		const savedTabs = createSavedTabState({ data, actions });
		const bookmarks = createBookmarkState({ data, actions });
		const toolTrust = createToolTrustState({ data });
		const unifiedView = createUnifiedViewState({ bookmarks, savedTabs });

		// The shared chat registry (ADR-0047/0059) with Tab Manager's variation
		// injected: device-constraint plus base prompts read per turn, its own
		// capabilities as the tool surface, and the "Always Allow" set folded into
		// the approval policy.
		chat = createAgentChatState({
			table: data.tables.conversations,
			openConversationDocument: (id) =>
				data.tables.conversations.openDocument(id),
			reportBackgroundError,
			connections,
			agent: {
				buildSystemPrompts: () => [
					buildDeviceConstraints(opened.profile.nodeId),
					TAB_MANAGER_SYSTEM_PROMPT,
				],
				defaultModel: DEFAULT_MODEL,
				toolCatalog: createLocalToolCatalog(actions),
				// A tool the user chose to "Always Allow" auto-approves; otherwise a
				// query runs unattended and a mutation asks (ADR-0044).
				decideApproval: (call, definition) =>
					toolTrust.shouldAutoApprove(call.toolName)
						? 'auto'
						: defaultApprovalDecision(call, definition),
			},
		});
		const state: TabManagerState = {
			savedTabs,
			bookmarks,
			toolTrust,
			unifiedView,
			aiChat: chat,
		};

		// Hydrate every durable read before the panel renders, so a component can
		// read `state.savedTabs.tabs` synchronously and see the truth rather than an
		// empty list that fills in a frame later.
		await untilAbort(
			Promise.all([
				savedTabs.whenReady,
				bookmarks.whenReady,
				toolTrust.whenReady,
			]),
		);
		signal?.throwIfAborted();

		// Refreshing this device's row is bookkeeping, not a precondition for the
		// panel: a failure is reported and the app still opens.
		void registerDevice(data, opened.profile).catch(reportBackgroundError);

		return Object.freeze({
			...data,
			get auth() {
				return opened.auth;
			},
			get instanceSetting() {
				return opened.instanceSetting;
			},
			actions,
			connections,
			state,
			get syncStatus() {
				return opened.epicenter.syncStatus;
			},
			subscribeSyncStatus(listener: (status: SyncStatus) => void) {
				return opened.epicenter.subscribeSyncStatus(listener);
			},
			[Symbol.asyncDispose]: release,
		});
	} catch (cause) {
		try {
			await release();
		} catch (releaseCause) {
			throw new AggregateError(
				[cause, releaseCause],
				'Tab Manager application acquisition and cleanup failed',
			);
		}
		throw cause;
	}
}
