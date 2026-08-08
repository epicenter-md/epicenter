/**
 * A shared app contract, written the way one would actually be shared.
 *
 * This file imports `@epicenter/lens` and nothing else. In particular it does
 * not import `@epicenter/app`: a contract is inert vocabulary, so a second app
 * that wants to read the same notes can depend on this module without also
 * taking on a client, and a tool that only wants to understand the shape of the
 * data can read it without taking on either.
 *
 * The namespace is declared exactly once, here. Two apps that import this bind
 * the same namespace, and therefore the same data.
 */

import { field } from '@epicenter/lens';
import { defineLens, defineTable, optional } from '@epicenter/lens/legacy';

export const notesContract = defineLens({
	namespace: 'so.epicenter.fixture.notes',
	tables: {
		notes: defineTable({
			fields: {
				title: field.string(),
				body: optional(field.string()),
			},
		}),
		settings: defineTable({
			fields: { sortOrder: field.select(['newest', 'oldest']) },
		}),
	},
});

/**
 * The one row id this contract chooses.
 *
 * A singleton is an ordinary row whose id the application supplies rather than
 * a second kind of fact, so both devices reach the same address without
 * coordinating (ADR-0206).
 */
export const SETTINGS = 'app';
