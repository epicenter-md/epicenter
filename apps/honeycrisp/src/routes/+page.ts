import { redirect } from '@sveltejs/kit';
import { resolve } from '$app/paths';

/**
 * Send a bare visit to the notebook.
 *
 * A load rather than a page, because there is nothing here to render. There is
 * one destination now: a store is one replica of an authority, so a signed-out
 * visit has no second library to be sent to and the account route's own gate
 * is what asks for sign-in.
 *
 * Resolved rather than written literally, because the Epicenter build serves
 * this SPA below `/apps/honeycrisp` and a bare path is outside that base.
 */
export function load(): never {
	redirect(307, resolve('/account'));
}
