/**
 * Tab Manager browser composition: open this document's replica, then attach
 * sync when auth is signed in (ADR-0088: sign-in is an enhancement, never a
 * door).
 *
 * The replica is the same one either way. Signing in attaches a sync session to
 * the replica already open; signing out detaches. Nothing downstream branches on
 * auth, and no identity change swaps the underlying storage, so there is no
 * reload-on-principal-change and no migration between two local documents.
 *
 * Where this runs matters. `openBrowserEpicenter` constructs a DedicatedWorker
 * that claims one exclusive Web Lock over one OPFS SQLite file, and that replica
 * is owned by the storage-partition and origin pair of the document that opened
 * it (ADR-0165 as amended by ADR-0177). The owner here is the side panel
 * document, never the MV3 background service worker: a background worker has no
 * production lifetime guarantee, so a replica owned there would lose its lock to
 * termination at a moment nothing observes. A second same-partition extension
 * document is refused immediately rather than queued, by design.
 */

import type { SyncAuthClient } from '@epicenter/auth';
import type { Exchange, SyncCredentialProvider } from '@epicenter/data';
import { openBrowserEpicenter } from '@epicenter/data/browser';
import { parseExchangeResponse } from '@epicenter/data/protocol';
import { createHttpDocumentTransports } from '@epicenter/document-sync';

type SyncAuth = Pick<
	SyncAuthClient,
	'state' | 'deployment' | 'fetch' | 'onStateChange'
>;

function deploymentUrl(baseUrl: string): URL {
	const url = new URL(baseUrl);
	if (!url.pathname.endsWith('/')) url.pathname += '/';
	return url;
}

function createExchange(auth: SyncAuth): Exchange {
	return async (request) => {
		const response = await auth.fetch(
			new URL('api/sync/v1', deploymentUrl(auth.deployment.baseURL)),
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(request),
			},
		);
		if (!response.ok) {
			throw new Error(`Epicenter sync failed (${response.status})`);
		}
		const parsed = parseExchangeResponse(await response.json());
		if (parsed.error !== null) throw parsed.error;
		return parsed.data;
	};
}

/** Open this document's replica and attach sync for signed-in auth. */
export async function openTabManagerBrowserEpicenter({
	auth,
	reportBackgroundError,
}: {
	auth: SyncAuth;
	reportBackgroundError(cause: unknown): void;
}) {
	const epicenter = await openBrowserEpicenter();
	const credentials: SyncCredentialProvider = {
		get: () => (auth.state.status === 'signed-in' ? 'available' : undefined),
		subscribe: (listener) => auth.onStateChange(listener),
	};
	const exchange = createExchange(auth);

	async function attachSignedIn(): Promise<void> {
		const state = auth.state;
		if (state.status !== 'signed-in') return;
		const attached = await epicenter.attachSync({
			deploymentId: deploymentUrl(auth.deployment.baseURL).href,
			principalId: state.principalId,
			exchange,
			...createHttpDocumentTransports({
				baseUrl: auth.deployment.baseURL,
				fetch: (url, init) => auth.fetch(url, init),
			}),
			credentials,
		});
		if (attached.error !== null) throw attached.error;
	}

	try {
		await attachSignedIn();
	} catch (cause) {
		await epicenter[Symbol.asyncDispose]();
		throw cause;
	}
	const stopAuth = auth.onStateChange(() => {
		void attachSignedIn().catch(reportBackgroundError);
	});

	return Object.freeze({
		epicenter,
		async [Symbol.asyncDispose]() {
			stopAuth();
			await epicenter[Symbol.asyncDispose]();
		},
	});
}
