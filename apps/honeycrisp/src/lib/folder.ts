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
	PushOutcome,
	PushPlan,
} from '@epicenter/data/artifact/checkout';
import { diff, pull, push } from '@epicenter/data/artifact/checkout';
import type { Result } from 'wellcrafted/result';
import { type HoneycrispData, honeycrispDefinition } from './data/index.js';

export type FolderVerbs = {
	/**
	 * Fill the folder with these notes and write the manifest (ADR-0337).
	 *
	 * It refuses a folder holding unpushed edits, and `discardEdits` is the
	 * person saying they saw them and want them gone.
	 */
	pull(options?: {
		discardEdits?: boolean;
	}): Promise<Result<{ files: number }, CheckoutError>>;
	/** What a push would do, changing nothing (ADR-0337). */
	diff(): Promise<Result<PushPlan, CheckoutError>>;
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
		pull: ({ discardEdits = false } = {}) =>
			pull({ data, definition: honeycrispDefinition, discardEdits }),
		diff: () => diff({ data, definition: honeycrispDefinition }),
		push: ({ plan }) => push({ data, definition: honeycrispDefinition, plan }),
	};
}
