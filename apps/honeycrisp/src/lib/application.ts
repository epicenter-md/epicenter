import type { Epicenter, RowDocument, SyncStatus } from '@epicenter/data';
import { type HoneycrispData, honeycrispLens } from '@epicenter/honeycrisp';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { createHoneycrispState } from '../routes/state/index.js';

/**
 * Failures that reach `reportBackgroundError`: work nobody is awaiting, so the
 * only honest response is a log line. The `cause` is `unknown` because these
 * arrive from rejected promises the application fired and forgot.
 */
export const HoneycrispBackgroundError = defineErrors({
	RefreshFailed: ({ cause }: { cause: unknown }) => ({
		message: 'Honeycrisp background refresh failed',
		cause,
	}),
	SyncFailed: ({ cause }: { cause: unknown }) => ({
		message: 'Honeycrisp background sync failed',
		cause,
	}),
});
export type HoneycrispBackgroundError = InferErrors<
	typeof HoneycrispBackgroundError
>;

export type HoneycrispDependencies = {
	/**
	 * Open the replica this build talks to. Which one that is, and who owns its
	 * storage, is the whole of what separates Honeycrisp's builds: a browser
	 * origin owns its own, and the desktop host owns the one it serves.
	 */
	openEpicenter(): Promise<Epicenter>;
	reportBackgroundError(cause: unknown): void;
};

export type HoneycrispNoteDocument = {
	document: RowDocument;
	[Symbol.asyncDispose](): Promise<void>;
};

export type HoneycrispApplication = HoneycrispData & {
	state: ReturnType<typeof createHoneycrispState>;
	readonly syncStatus: SyncStatus;
	subscribeSyncStatus(listener: (status: SyncStatus) => void): () => void;
	openNoteDocument(noteId: string): Promise<HoneycrispNoteDocument>;
	[Symbol.asyncDispose](): Promise<void>;
};

/** Open one fully acquired and hydrated Honeycrisp application. */
export async function openHoneycrispApplication(
	{ openEpicenter, reportBackgroundError }: HoneycrispDependencies,
	{ signal }: { signal?: AbortSignal } = {},
): Promise<HoneycrispApplication> {
	let runtime: Epicenter | undefined;
	let state: ReturnType<typeof createHoneycrispState> | undefined;
	const documents = new Set<HoneycrispNoteDocument>();
	let releasePromise: Promise<void> | undefined;
	const release = (): Promise<void> => {
		releasePromise ??= (async () => {
			signal?.removeEventListener('abort', onAbort);
			const failures: unknown[] = [];
			for (const document of documents) {
				try {
					await document[Symbol.asyncDispose]();
				} catch (cause) {
					failures.push(cause);
				}
			}
			documents.clear();
			try {
				state?.[Symbol.dispose]();
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
					'Honeycrisp application cleanup failed',
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
		runtime = await untilAbort(openEpicenter());
		signal?.throwIfAborted();
		const activeRuntime = runtime;
		const data = activeRuntime.bind(honeycrispLens);
		state = createHoneycrispState({
			honeycrisp: data,
			reportBackgroundError,
		});
		await untilAbort(state.whenReady);
		signal?.throwIfAborted();
		return Object.freeze({
			...data,
			state,
			get syncStatus() {
				return activeRuntime.syncStatus;
			},
			subscribeSyncStatus(listener: (status: SyncStatus) => void) {
				return activeRuntime.subscribeSyncStatus(listener);
			},
			async openNoteDocument(noteId: string) {
				// Opening hydrates locally durable state only; remote refresh is
				// an explicit pull the view performs after this resolves.
				const document = await data.tables.notes.openDocument(noteId);
				let disposed = false;
				const opened: HoneycrispNoteDocument = {
					document,
					async [Symbol.asyncDispose]() {
						if (disposed) return;
						disposed = true;
						documents.delete(opened);
						await document[Symbol.asyncDispose]();
					},
				};
				documents.add(opened);
				return opened;
			},
			[Symbol.asyncDispose]: release,
		});
	} catch (cause) {
		try {
			await release();
		} catch (releaseCause) {
			throw new AggregateError(
				[cause, releaseCause],
				'Honeycrisp application acquisition and cleanup failed',
			);
		}
		throw cause;
	}
}
