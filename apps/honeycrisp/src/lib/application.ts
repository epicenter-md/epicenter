import type { Epicenter, RowDocument, SyncStatus } from '@epicenter/data';
import type { connectRowDocument } from '@epicenter/document-sync';
import {
	type HoneycrispData,
	honeycrispDefinitions,
} from '@epicenter/honeycrisp';
import { createHoneycrispState } from '../routes/state/index.js';

type ApplicationRuntime = {
	epicenter: Epicenter;
	connectDocument(document: RowDocument): ReturnType<typeof connectRowDocument>;
	[Symbol.asyncDispose](): Promise<void>;
};

export type HoneycrispDependencies = {
	openEpicenter(): Promise<ApplicationRuntime>;
	reportBackgroundError(cause: unknown): void;
};

export type HoneycrispNoteDocument = {
	document: RowDocument;
	connection: ReturnType<typeof connectRowDocument>;
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
	let runtime: ApplicationRuntime | undefined;
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
		const data = activeRuntime.epicenter.bind(honeycrispDefinitions);
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
				return activeRuntime.epicenter.syncStatus;
			},
			subscribeSyncStatus(listener: (status: SyncStatus) => void) {
				return activeRuntime.epicenter.subscribeSyncStatus(listener);
			},
			async openNoteDocument(noteId: string) {
				const document = await data.tables.notes.openDocument(noteId);
				let connection: ReturnType<typeof connectRowDocument>;
				try {
					connection = activeRuntime.connectDocument(document);
				} catch (cause) {
					await document[Symbol.asyncDispose]();
					throw cause;
				}
				let disposed = false;
				const opened: HoneycrispNoteDocument = {
					document,
					connection,
					async [Symbol.asyncDispose]() {
						if (disposed) return;
						disposed = true;
						documents.delete(opened);
						connection.dispose();
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
