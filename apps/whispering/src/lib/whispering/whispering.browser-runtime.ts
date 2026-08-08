import type { SyncAuthClient } from '@epicenter/auth';
import type {
	Epicenter,
	Exchange,
	SyncCredentialProvider,
} from '@epicenter/data/legacy';
import { openBrowserEpicenter } from '@epicenter/data/legacy/browser';
import { parseExchangeResponse } from '@epicenter/data/legacy/protocol';

type WhisperingAuth = Pick<
	SyncAuthClient,
	'state' | 'deployment' | 'fetch' | 'onStateChange'
>;

function deploymentUrl(baseUrl: string): URL {
	const url = new URL(baseUrl);
	if (!url.pathname.endsWith('/')) url.pathname += '/';
	return url;
}

function syncUrl(baseUrl: string): URL {
	return new URL('api/sync/v1', deploymentUrl(baseUrl));
}

function createExchange(auth: WhisperingAuth): Exchange {
	return async (request) => {
		const response = await auth.fetch(syncUrl(auth.deployment.baseURL), {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(request),
		});
		if (!response.ok) {
			throw new Error(`Epicenter sync failed (${response.status})`);
		}
		const parsed = parseExchangeResponse(await response.json());
		if (parsed.error !== null) throw parsed.error;
		return parsed.data;
	};
}

/** Open this browser origin's replica and attach it on signed-in auth states. */
export async function openWhisperingBrowserEpicenter({
	auth,
	reportBackgroundError,
}: {
	auth: WhisperingAuth;
	reportBackgroundError(cause: unknown): void;
}): Promise<Epicenter> {
	const browser = await openBrowserEpicenter();
	const credentials: SyncCredentialProvider = {
		get: () => (auth.state.status === 'signed-in' ? 'available' : undefined),
		subscribe: (listener) => auth.onStateChange(listener),
	};
	const exchange = createExchange(auth);

	const attachSignedIn = async () => {
		const state = auth.state;
		if (state.status !== 'signed-in') return;
		const attachment = Object.freeze({
			deploymentId: deploymentUrl(auth.deployment.baseURL).href,
			principalId: state.principalId,
		});
		const result = await browser.attachSync({
			...attachment,
			exchange,
			credentials,
		});
		if (result.error !== null) throw result.error;
	};

	try {
		await attachSignedIn();
	} catch (cause) {
		await browser[Symbol.asyncDispose]();
		throw cause;
	}
	const stopAuth = auth.onStateChange(() => {
		void attachSignedIn().catch(reportBackgroundError);
	});

	return Object.freeze({
		bind: browser.bind,
		attachSync: browser.attachSync,
		get syncStatus() {
			return browser.syncStatus;
		},
		subscribeSyncStatus: browser.subscribeSyncStatus,
		async [Symbol.asyncDispose]() {
			stopAuth();
			await browser[Symbol.asyncDispose]();
		},
	});
}
