import {
	type HoneycrispWorkspace,
	honeycrispWorkspace,
} from '@epicenter/honeycrisp';
import type {
	WorkspaceLens,
	Workspace,
} from '@epicenter/workspace/sqlite';
import { createHoneycrispState } from '../routes/state/index.js';

type ApplicationRuntime = {
	open<TDefinition extends WorkspaceLens>(
		definition: TDefinition,
	): Promise<Workspace<TDefinition>>;
	[Symbol.asyncDispose](): Promise<void>;
};

export type HoneycrispDependencies = {
	createRuntime(
		onRecordsChanged: (workspaceId: string) => void,
	): ApplicationRuntime;
	reportBackgroundError(cause: unknown): void;
};

export type HoneycrispApplication = HoneycrispWorkspace & {
	state: ReturnType<typeof createHoneycrispState>;
	[Symbol.asyncDispose](): Promise<void>;
};

/** Open one fully acquired and hydrated Honeycrisp application. */
export async function openHoneycrispApplication(
	{ createRuntime, reportBackgroundError }: HoneycrispDependencies,
	{ signal }: { signal?: AbortSignal } = {},
): Promise<HoneycrispApplication> {
	const recordsChangedListeners = new Set<() => void>();
	const runtime = createRuntime((workspaceId) => {
		if (workspaceId !== honeycrispWorkspace.id) return;
		for (const listener of recordsChangedListeners) listener();
	});
	let state: ReturnType<typeof createHoneycrispState> | undefined;
	let releasePromise: Promise<void> | undefined;
	const release = (): Promise<void> => {
		releasePromise ??= (async () => {
			signal?.removeEventListener('abort', onAbort);
			recordsChangedListeners.clear();
			const failures: unknown[] = [];
			try {
				state?.[Symbol.dispose]();
			} catch (cause) {
				failures.push(cause);
			}
			try {
				await runtime[Symbol.asyncDispose]();
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
		const workspace = await untilAbort(runtime.open(honeycrispWorkspace));
		signal?.throwIfAborted();
		state = createHoneycrispState({
			honeycrisp: workspace,
			onRecordsChanged(listener) {
				recordsChangedListeners.add(listener);
				return () => recordsChangedListeners.delete(listener);
			},
			reportBackgroundError,
		});
		await untilAbort(state.whenReady);
		signal?.throwIfAborted();
		return Object.freeze({
			...workspace,
			state,
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
