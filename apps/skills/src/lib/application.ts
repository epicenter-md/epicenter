import type { Epicenter } from '@epicenter/data/legacy';
import { openBrowserEpicenter } from '@epicenter/data/legacy/browser';
import { type SkillsData, skillsLens } from '@epicenter/skills';
import { createSkillsState } from './state/skills-state.svelte.js';

export type SkillsDependencies = {
	openEpicenter(): Promise<Epicenter>;
	reportBackgroundError(cause: unknown): void;
};

export type SkillsApplication = SkillsData & {
	state: ReturnType<typeof createSkillsState>;
	[Symbol.asyncDispose](): Promise<void>;
};

/** Inert browser dependencies. Storage opens only when the root calls open. */
export const skillsBrowser: Pick<SkillsDependencies, 'openEpicenter'> = {
	openEpicenter: openBrowserEpicenter,
};

/** Open one fully acquired and hydrated standalone Skills application. */
export async function openSkillsApplication(
	{ openEpicenter, reportBackgroundError }: SkillsDependencies,
	{ signal }: { signal?: AbortSignal } = {},
): Promise<SkillsApplication> {
	let runtime: Epicenter | undefined;
	let state: ReturnType<typeof createSkillsState> | undefined;
	let released = false;
	let releasePromise: Promise<void> | undefined;
	const release = (): Promise<void> => {
		releasePromise ??= (async () => {
			released = true;
			signal?.removeEventListener('abort', onAbort);
			const failures: unknown[] = [];
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
				throw new AggregateError(failures, 'Skills application cleanup failed');
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
		const opened = await untilAbort(
			openEpicenter().then(async (opened) => {
				runtime = opened;
				if (released) await opened[Symbol.asyncDispose]();
				return opened;
			}),
		);
		signal?.throwIfAborted();
		const skills = opened.bind(skillsLens);
		state = createSkillsState({
			skills,
		});
		await untilAbort(state.whenReady);
		signal?.throwIfAborted();
		return Object.freeze({
			...skills,
			state,
			[Symbol.asyncDispose]: release,
		});
	} catch (cause) {
		try {
			await release();
		} catch (releaseCause) {
			throw new AggregateError(
				[cause, releaseCause],
				'Skills application acquisition and cleanup failed',
			);
		}
		throw cause;
	}
}
