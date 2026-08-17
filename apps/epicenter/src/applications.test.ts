/**
 * What Home lists as launchable (ADR-0189).
 *
 * What these protect is the absence of a distinction downstream: whatever the
 * host has to do differently to serve a compiled application and an admitted
 * catalog member, one list of `{ id, title }` leaves this module, so Home
 * cannot grow two row shapes or two launch verbs by accident.
 */

import { describe, expect, test } from 'bun:test';
import { COMPILED_APPLICATIONS, listApplications } from './applications.ts';
import { PLACEHOLDER_PAGES } from './placeholder-pages.ts';
import { BUILT_IN_ROUTES } from './routes.ts';
import type { AppCatalog, CatalogApp } from './static-assets.ts';

function catalogOf(...members: { id: string; title: string }[]): AppCatalog {
	return {
		apps: members.map(
			({ id, title }) =>
				({
					id,
					title,
					page: '<!doctype html><html></html>',
					// An id is the workspace id its declaration declared (ADR-0210), which is
					// the only thing admission keeps: the compiled declaration itself is not
					// carried past it, because the host reads nobody's rows.
					directory: id,
					resolve: async () => undefined,
				}) satisfies CatalogApp,
		),
	};
}

describe('listApplications', () => {
	test('an empty catalog still offers the compiled applications', () => {
		expect(listApplications({ apps: [] })).toEqual([
			{ id: 'whispering', title: 'Whispering' },
			{ id: 'honeycrisp', title: 'Honeycrisp' },
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
			{ id: 'honeycrisp', title: 'Honeycrisp' },
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

	test('Home and placeholder routes are not applications a person can open', () => {
		const listed = new Set(listApplications({ apps: [] }).map(({ id }) => id));
		for (const id of [
			'home',
			'mail',
			'books',
		] satisfies (keyof typeof BUILT_IN_ROUTES)[]) {
			expect(listed.has(id)).toBe(false);
		}
	});
});

/**
 * Every built-in route the host serves has something behind it, and every compiled
 * application has its own route. The two lists used to be one object literal the
 * type checker cross-checked; now that compiled builds arrive at runtime, this
 * is where a built-in route with no document, or an application with no route, shows
 * up.
 */
describe('built-in route coverage', () => {
	test('each built-in route is Home, a compiled application, or a placeholder', () => {
		const served = new Set<string>([
			BUILT_IN_ROUTES.home.id,
			...COMPILED_APPLICATIONS.map(({ id }) => id),
			...Object.keys(PLACEHOLDER_PAGES),
		]);
		expect(
			Object.keys(BUILT_IN_ROUTES).filter((id) => !served.has(id)),
		).toEqual([]);
	});

	test('each compiled application has its own built-in route', () => {
		expect(
			COMPILED_APPLICATIONS.filter(
				({ id, title }) =>
					BUILT_IN_ROUTES[id as keyof typeof BUILT_IN_ROUTES]?.title !== title,
			),
		).toEqual([]);
	});
});
