import type { Epicenter } from '@epicenter/data';
import { openBrowserEpicenter } from '@epicenter/data/browser';
import { type SkillsData, skillsLens } from '@epicenter/skills';
import { createSkillsState } from './state/skills-state.svelte.js';

type ApplicationRuntime = {
	epicenter: Epicenter;
	[Symbol.asyncDispose](): Promise<void>;
};

export type SkillsDependencies = {
	openEpicenter(): Promise<ApplicationRuntime>;
	reportBackgroundError(cause: unknown): void;
};

export type SkillsApplication = SkillsData & {
	state: ReturnType<typeof createSkillsState>;
	[Symbol.asyncDispose](): Promise<void>;
};

/**
 * Inert browser dependencies. Storage opens only when the root calls open.
 *
 * Skills binds the origin's replica but never attaches sync: it is a
 * device-local product, so it has no auth, no deployment, and no exchange.
 */
export const skillsBrowser: Pick<SkillsDependencies, 'openEpicenter'> = {
	openEpicenter: async () => {
		const epicenter = await openBrowserEpicenter();
		return {
			epicenter,
			[Symbol.asyncDispose]: () => epicenter[Symbol.asyncDispose](),
		};
	},
};

/** Open one fully acquired and hydrated standalone Skills application. */
export async function openSkillsApplication(
	{ openEpicenter, reportBackgroundError }: SkillsDependencies,
	{ signal }: { signal?: AbortSignal } = {},
): Promise<SkillsApplication> {
	let runtime: ApplicationRuntime | undefined;
	let state: ReturnType<typeof createSkillsState> | undefined;
	let releasePromise: Promise<void> | undefined;
	const release = (): Promise<void> => {
		releasePromise ??= (async () => {
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
		const data = opened.epicenter.bind(skillsLens);
		state = createSkillsState({ skills: data, reportBackgroundError });
		await untilAbort(state.whenReady);
		signal?.throwIfAborted();
		return Object.freeze({
			...data,
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
