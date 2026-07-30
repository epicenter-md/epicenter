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

import {
	defineLens,
	defineTable,
	defineValue,
	field,
	optional,
} from '@epicenter/lens';

export const notesContract = defineLens({
	namespace: 'so.epicenter.fixture.notes',
	tables: {
		notes: defineTable({
			fields: {
				title: field.string(),
				body: optional(field.string()),
			},
		}),
	},
	values: {
		'settings.sortOrder': defineValue({
			value: field.select(['newest', 'oldest']),
		}),
	},
});
