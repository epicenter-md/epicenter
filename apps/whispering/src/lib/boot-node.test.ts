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
 * - The shell it mounts does not open, so the boot cannot drift downward
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
/**
 * The one component that opens, which the boot node mounts under its gate.
 *
 * The open moved off the boot node when a session became a value the tree owns
 * (ADR-0350), so a boot that drifted upward would now import a component rather
 * than call `epicenter.open` itself. That is why the assertions below forbid an
 * ancestor from naming EITHER: greping one string would pass over the drift.
 */
const SESSION_COMPONENT =
	'src/routes/(app)/_components/RecordingsSession.svelte';
/** The one node that is allowed to gate, and is not an ancestor of the callback. */
const BOOT_NODE = 'src/routes/(app)/+layout.svelte';
/** What the boot node mounts once the store is open, which must not open it. */
const SHELL = 'src/routes/(app)/_components/WhisperingShell.svelte';

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
				mounts: source.includes(SESSION_COMPONENT.split('/').pop() ?? ''),
			}).toEqual({
				layout: relative(appRoot, layout),
				imports: false,
				opens: false,
				mounts: false,
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
		expect(await Bun.file(bootNode).text()).toContain(
			SESSION_COMPONENT.split('/').pop() ?? '',
		);
		expect(ancestorLayouts(callback)).not.toContain(bootNode);

		// The positive half is on the component that actually opens.
		expect(await Bun.file(join(appRoot, SESSION_COMPONENT)).text()).toContain(
			'epicenter.open',
		);
	});

	test('the shell renders and does not open', async () => {
		// The other direction the boot can drift. The shell holds everything that
		// exists because the store is open, and the open itself is the one thing
		// that must not follow it down: a shell that opened would still build,
		// still start, and still pass every test above, because it is not an
		// ancestor of the callback.
		const shell = join(appRoot, SHELL);
		expect(await Bun.file(shell).text()).not.toContain('epicenter.open');
	});
});
