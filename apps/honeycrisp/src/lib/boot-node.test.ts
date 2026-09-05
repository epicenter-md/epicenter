/**
 * Nothing above the OAuth callback opens a store.
 *
 * The rule is ADR-0345's, and it is the reason this application's boot lives
 * where it does: `/auth/callback` runs for one round trip while a PKCE code is
 * exchanged, and it runs while signed out, which is the one state in which
 * there is no store to open at all (ADR-0336). A store opened above it would
 * claim a Web Lock the real page then finds taken, and an auth gate rendered
 * above it would show a signed-out person a sign-in screen on top of the
 * callback that is signing them in.
 *
 * The failure is silent in exactly the way a lost platform leaf is: moving the
 * boot up one node still builds, still starts, and still passes every other
 * test in this application.
 *
 * This walks the tree rather than grepping the repository. It reads the
 * callback page's ancestor layouts, which is the set ADR-0345 names, and says
 * which one broke the rule.
 *
 * Key behaviors:
 * - Every ancestor layout of the callback opens nothing and imports no session
 * - The callback page itself opens nothing
 * - The boot node DOES open, which is what proves the assertion has teeth
 */

import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = fileURLToPath(new URL('../..', import.meta.url));
const routes = join(appRoot, 'src/routes');
const callback = join(routes, 'auth/callback/+page.svelte');

/** The application's one session module, as a route would import it. */
const SESSION_MODULE = '$lib/epicenter';
/** The one node that is allowed to open, and is not an ancestor of the callback. */
const BOOT_NODE = 'src/routes/+page.svelte';

/**
 * Every `+layout.svelte` that renders the callback, nearest first.
 *
 * SvelteKit composes a page under the layout of every ancestor directory, so
 * this is that chain and nothing else: a sibling group's layout never wraps
 * this page, which is the whole reason a boot node can be a sibling.
 */
function ancestorLayouts(page: string): string[] {
	const found: string[] = [];
	for (
		let directory = dirname(page);
		directory.startsWith(routes);
		directory = dirname(directory)
	) {
		const layout = join(directory, '+layout.svelte');
		if (existsSync(layout)) found.push(layout);
	}
	return found;
}

describe('the callback opens nothing', () => {
	test('the callback page exists and has at least one ancestor layout', () => {
		// Without this the walk below could pass by finding nothing, which is the
		// one way a structural test lies.
		expect(existsSync(callback)).toBe(true);
		expect(ancestorLayouts(callback).length).toBeGreaterThan(0);
	});

	test('no ancestor layout imports the session or opens it', async () => {
		for (const layout of ancestorLayouts(callback)) {
			const source = await Bun.file(layout).text();
			expect({
				layout: relative(appRoot, layout),
				imports: source.includes(SESSION_MODULE),
				opens: source.includes('epicenter.open'),
			}).toEqual({
				layout: relative(appRoot, layout),
				imports: false,
				opens: false,
			});
		}
	});

	test('the callback page itself opens nothing', async () => {
		const source = await Bun.file(callback).text();
		expect({
			imports: source.includes(SESSION_MODULE),
			opens: source.includes('epicenter.open'),
		}).toEqual({ imports: false, opens: false });
	});

	test('the boot node opens, and is not an ancestor of the callback', async () => {
		// The positive half. If the boot ever moved up into a layout the callback
		// renders under, this would still pass and the test above would fail,
		// which is the pair that says where the boundary is rather than that one
		// file happens to be quiet.
		const bootNode = join(appRoot, BOOT_NODE);
		expect(await Bun.file(bootNode).text()).toContain('epicenter.open');
		expect(ancestorLayouts(callback)).not.toContain(bootNode);
	});
});
