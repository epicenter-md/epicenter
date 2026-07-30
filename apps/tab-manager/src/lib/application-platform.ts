/**
 * The extension platform behind {@link TabManagerDependencies}: inert at import,
 * acquired when the side panel root calls it.
 *
 * `chrome.storage` is asynchronous, so the persisted auth cell, the instance
 * choice, and this device's identity are all read here rather than closed over at
 * module scope. Reading them is what makes the auth client constructible, and the
 * auth client is what the replica opener needs, so the three arrive as one
 * acquisition.
 *
 * This is also the file that decides where the replica lives. It is imported only
 * by the side panel entrypoint: the background service worker never opens a
 * replica, because MV3 gives its in-memory state no production lifetime
 * guarantee, and a replica whose owner can be terminated at any moment would
 * strand its Web Lock (ADR-0165/ADR-0177).
 */

import { EPICENTER_TAB_MANAGER_OAUTH_CLIENT_ID } from '@epicenter/constants/oauth-clients';
import { createAppAuthClient } from '@epicenter/svelte/auth';
import { createLogger } from 'wellcrafted/logger';
import type {
	TabManagerDependencies,
	TabManagerRuntime,
} from '$lib/application';
import { createDeviceProfile } from '$lib/device';
import {
	instanceSettingPromise,
	oauthLauncher,
	persistedAuthStoragePromise,
} from '$lib/platform/auth';
import { openTabManagerBrowserEpicenter } from '$lib/workspace/browser';

const log = createLogger('tab-manager/application');

const reportBackgroundError = (cause: unknown) =>
	log.warn(new Error('Tab Manager background work failed', { cause }));

async function openExtensionRuntime(): Promise<TabManagerRuntime> {
	const [persistedAuthStorage, instanceSetting, profile] = await Promise.all([
		persistedAuthStoragePromise,
		instanceSettingPromise,
		createDeviceProfile(),
	]);
	// One choke point: the persisted instance picks hosted OAuth versus a
	// self-host token (ADR-0071). The launcher is the extension launcher, used
	// only by the OAuth branch.
	const auth = createAppAuthClient(instanceSetting.read(), {
		clientId: EPICENTER_TAB_MANAGER_OAUTH_CLIENT_ID,
		persistedAuthStorage,
		launcher: oauthLauncher,
	});
	let opened: Awaited<ReturnType<typeof openTabManagerBrowserEpicenter>>;
	try {
		opened = await openTabManagerBrowserEpicenter({
			auth,
			reportBackgroundError,
		});
	} catch (cause) {
		auth[Symbol.dispose]();
		throw cause;
	}
	return {
		auth,
		instanceSetting,
		profile,
		epicenter: opened.epicenter,
		async [Symbol.asyncDispose]() {
			try {
				await opened[Symbol.asyncDispose]();
			} finally {
				auth[Symbol.dispose]();
			}
		},
	};
}

/** Inert side panel dependencies. Nothing opens until the root calls it. */
export const tabManagerPlatform: TabManagerDependencies = {
	openRuntime: openExtensionRuntime,
	reportBackgroundError,
};
