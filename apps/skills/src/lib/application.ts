/**
 * One page lifetime's Skills runtime: the opened document and the state bound
 * to it. The root owns it, provides it through context, and disposes it.
 *
 * Skills is device-only, and that is the whole composition (ADR-0233). There is
 * no auth client in this build and therefore no account replica: a skill
 * library lives on the device that edits it, and there is exactly one ready
 * shape, `{ data }`. If Skills ever signs in, this is where the second document
 * appears, beside the first rather than instead of it.
 */

import type { DataOf } from '@epicenter/data';
import { type LocalStore, openLocal } from '@epicenter/data/browser';
import { skillsDefinition } from '@epicenter/skills';
import { createSkillsState } from './state/skills-state.svelte.js';

export type SkillsRuntime = {
	/** The device-owned document, open for the whole page lifetime. */
	readonly data: DataOf<typeof skillsDefinition, LocalStore>;
	readonly state: ReturnType<typeof createSkillsState>;
	[Symbol.asyncDispose](): Promise<void>;
};

/**
 * Open one Skills generation, hydrated and ready to read synchronously.
 *
 * The only asynchronous thing in this application. Opening a store is real
 * I/O: an IndexedDB checkpoint, a WASM compile, and the replay of a durable
 * log. Everything after it is a property access on a document already in
 * memory, which is why nothing below this line returns a promise.
 */
export async function openSkillsRuntime({
	signal,
}: {
	signal?: AbortSignal;
} = {}): Promise<SkillsRuntime> {
	signal?.throwIfAborted();
	const opened = await openLocal(skillsDefinition);
	if (opened.error !== null) throw opened.error;
	const data = opened.data;

	try {
		signal?.throwIfAborted();
		const state = createSkillsState({ data });
		let disposed = false;
		return Object.freeze({
			data,
			state,
			async [Symbol.asyncDispose]() {
				if (disposed) return;
				disposed = true;
				state[Symbol.dispose]();
				await data[Symbol.asyncDispose]();
			},
		});
	} catch (cause) {
		await data[Symbol.asyncDispose]().catch(() => undefined);
		throw cause;
	}
}
