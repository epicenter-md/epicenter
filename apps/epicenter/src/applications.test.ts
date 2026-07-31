/**
 * What Home lists as launchable (ADR-0189).
 *
 * What these protect is the absence of a distinction downstream: whatever the
 * host has to do differently to serve a compiled application and an admitted
 * catalog member, one list of `{ id, title }` leaves this module, so Home
 * cannot grow two row shapes or two launch verbs by accident.
 */

import { describe, expect, test } from 'bun:test';
import { listApplications } from './applications.ts';
import type { SURFACE_ROUTES } from './routes.ts';
import type { AppCatalog, CatalogApp } from './static-assets.ts';

function catalogOf(...members: { id: string; title: string }[]): AppCatalog {
	return {
		apps: members.map(
			({ id, title }) =>
				({
					id,
					title,
					resolve: async () => undefined,
				}) satisfies CatalogApp,
		),
	};
}

describe('listApplications', () => {
	test('an empty catalog still offers the compiled applications', () => {
		expect(listApplications({ apps: [] })).toEqual([
			{ id: 'whispering', title: 'Whispering' },
		]);
	});

	test('compiled applications and catalog members share one shape and one list', () => {
		expect(
			listApplications(
				catalogOf(
					{ id: 'notes', title: 'Notes' },
					{ id: 'timeline', title: 'Timeline' },
				),
			),
		).toEqual([
			{ id: 'whispering', title: 'Whispering' },
			{ id: 'notes', title: 'Notes' },
			{ id: 'timeline', title: 'Timeline' },
		]);
	});

	test('a member carries nothing beyond what admission honestly derived', () => {
		const [application] = listApplications(
			catalogOf({ id: 'a', title: 'A' }),
		).slice(-1);
		expect(Object.keys(application ?? {}).sort()).toEqual(['id', 'title']);
	});

	test('Home and placeholder surfaces are not applications a person can open', () => {
		const listed = new Set(listApplications({ apps: [] }).map(({ id }) => id));
		for (const id of [
			'home',
			'mail',
			'books',
		] satisfies (keyof typeof SURFACE_ROUTES)[]) {
			expect(listed.has(id)).toBe(false);
		}
	});
});
