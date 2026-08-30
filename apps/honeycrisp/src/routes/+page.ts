import { redirect } from '@sveltejs/kit';
import { auth } from '#platform/auth';
import { resolve } from '$app/paths';

/**
 * Send a bare visit to whichever library this person has.
 *
 * A load rather than a page, because there is nothing here to render: the old
 * version ran the same decision inside an `$effect` behind a spinner, which
 * meant mounting a component, painting a loading state, and then navigating
 * away from it.
 *
 * Resolved rather than written literally. The Epicenter build serves this SPA
 * below `/apps/honeycrisp`, and a bare `/device` is outside that base, so the
 * client router treats it as somewhere else entirely and hands it to the
 * browser, which asks the host for a page it does not serve.
 */
export function load(): never {
	redirect(
		307,
		auth.state.status === 'signed-out'
			? resolve('/device')
			: resolve('/account'),
	);
}
