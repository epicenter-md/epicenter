/**
 * The Google OAuth client this build authorizes through.
 *
 * Application-owned configuration, not an account secret (ADR-0310): it
 * identifies Local Mail to Google and is the same for every account a person
 * connects. It arrives at build time, because a page cannot read a machine's
 * environment and asking a person to paste one at runtime would be asking them
 * to be the release engineer.
 *
 * The secret half is not a secret in the sense the name suggests. This is
 * Google's installed-application pattern: the value ships inside the
 * application and PKCE is what protects the exchange.
 */

import type { GmailClientIdentity } from '@epicenter/local-mail/config';

const CLIENT_ID = import.meta.env.VITE_GMAIL_CLIENT_ID as string | undefined;
const CLIENT_SECRET = import.meta.env.VITE_GMAIL_CLIENT_SECRET as
	| string
	| undefined;

export class GmailIdentityMissingError extends Error {
	override readonly name = 'GmailIdentityMissing';
	constructor() {
		super(
			'This build has no Google OAuth client. Set VITE_GMAIL_CLIENT_ID and VITE_GMAIL_CLIENT_SECRET and build again.',
		);
	}
}

export function hasGmailIdentity(): boolean {
	return Boolean(CLIENT_ID && CLIENT_SECRET);
}

export function gmailIdentity(): GmailClientIdentity {
	if (!CLIENT_ID || !CLIENT_SECRET) throw new GmailIdentityMissingError();
	return { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET };
}
