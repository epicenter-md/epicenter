/**
 * The `~/Epicenter/so.epicenter.honeycrisp/` working copy, bound to one store.
 *
 * Three verbs over the folder (ADR-0337), each one the library's with this
 * application's definition supplied. That is all this is: `pull`, `diff`, and
 * `push` take the store and the declaration, the store states its own address
 * (ADR-0340), and the declaration is an import. A component that offers a
 * person the button gets these rather than the library, so nothing in the UI
 * names the definition or the store.
 *
 * They used to hang off the object the route's opener returned, beside the
 * data and the sync status. There is no route-owned opener any more
 * (ADR-0339), and these never belonged to it: they belong to the store's
 * address, which is why they stay functions over an opened store rather than
 * methods on the handle.
 */

import type {
	CheckoutError,
	FolderState,
	PushOutcome,
	PushPlan,
} from '@epicenter/data/artifact/checkout';
import { diff, pull, push } from '@epicenter/data/artifact/checkout';
import type { Result } from 'wellcrafted/result';
import { type HoneycrispData, honeycrispDefinition } from './data/index.js';

export type FolderVerbs = {
	/**
	 * Write every file in the folder from these notes (ADR-0341).
	 *
	 * `state` is what `diff` said and a person approved: a pull writes over
	 * everything in it, so confirming the list IS the discard, and one that
	 * stopped being true is refused rather than applied.
	 */
	pull(options: {
		state: FolderState;
	}): Promise<Result<{ files: number }, CheckoutError>>;
	/**
	 * What the folder holds that these notes do not, changing nothing.
	 *
	 * The one question both directions ask: a push applies this list, a pull
	 * writes over it.
	 */
	diff(): Promise<Result<FolderState, CheckoutError>>;
	/**
	 * Apply the folder's edits, then re-render.
	 *
	 * `plan` is what `diff` said and a person agreed to, and a push that finds
	 * it is no longer true refuses rather than applying an answer to a question
	 * that changed.
	 */
	push(options: {
		plan: PushPlan;
	}): Promise<Result<PushOutcome, CheckoutError>>;
};

export function folderVerbs(data: HoneycrispData): FolderVerbs {
	return {
		pull: ({ state }) => pull({ data, definition: honeycrispDefinition, state }),
		diff: () => diff({ data, definition: honeycrispDefinition }),
		push: ({ plan }) => push({ data, definition: honeycrispDefinition, plan }),
	};
}
