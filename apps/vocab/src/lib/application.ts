/**
 * Vocab application acquisition: open the replica, bind the Lens, and hand back
 * one ready handle.
 *
 * Sign-in is an enhancement, never a door (ADR-0088). Vocab opens the same
 * replica signed in or out; `openEpicenter` attaches a sync session when auth
 * has one. Nothing below this boundary branches on auth.
 */

import type { Epicenter, SyncStatus } from '@epicenter/data';
import { type VocabData, vocabLens } from '@epicenter/vocab';
import { createEntriesState } from './state/entries.svelte.js';

type ApplicationRuntime = {
	epicenter: Epicenter;
	[Symbol.asyncDispose](): Promise<void>;
};

export type VocabDependencies = {
	openEpicenter(): Promise<ApplicationRuntime>;
	reportBackgroundError(cause: unknown): void;
};

export type VocabApplication = VocabData & {
	/** The one entry pool for this replica. */
	entries: ReturnType<typeof createEntriesState>;
	readonly syncStatus: SyncStatus;
	subscribeSyncStatus(listener: (status: SyncStatus) => void): () => void;
	[Symbol.asyncDispose](): Promise<void>;
};

/** Open one fully acquired Vocab application. */
export async function openVocabApplication(
	{ openEpicenter, reportBackgroundError }: VocabDependencies,
	{ signal }: { signal?: AbortSignal } = {},
): Promise<VocabApplication> {
	let runtime: ApplicationRuntime | undefined;
	let releasePromise: Promise<void> | undefined;
	const release = (): Promise<void> => {
		releasePromise ??= (async () => {
			signal?.removeEventListener('abort', onAbort);
			await runtime?.[Symbol.asyncDispose]();
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
		const acquiring = openEpicenter();
		// An abort releases immediately, which can happen before acquisition
		// settles. Record the runtime the moment it arrives, and dispose it here
		// if release already ran, so a late arrival is never orphaned.
		void acquiring.then(
			(acquired) => {
				runtime = acquired;
				if (releasePromise) {
					void acquired[Symbol.asyncDispose]().catch(reportBackgroundError);
				}
			},
			() => {},
		);
		const opened = await untilAbort(acquiring);
		signal?.throwIfAborted();
		const data = opened.epicenter.bind(vocabLens);
		return Object.freeze({
			...data,
			entries: createEntriesState(data),
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
				'Vocab application acquisition and cleanup failed',
			);
		}
		throw cause;
	}
}
