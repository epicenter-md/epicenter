import { createDesktopBrokerAuth } from '@epicenter/auth/desktop';
import { fromAuth } from '@epicenter/auth/svelte';

/**
 * One window-local projection of the process-wide Bun credential authority.
 *
 * It holds no credential, so every dial is refused with `'no-credential-model'`
 * and the driver keeps dialling, reporting the refusal on its status
 * (ADR-0350). Nothing renders that refusal, because there is nothing a person
 * could do about it.
 *
 * **This build does not sync at all today.** The refusal used to say sync
 * belongs to the host process; the host process does not sync either, and
 * `apps/epicenter/src` contains no dial. So a replica opened here would reach
 * no authority, which is also why it cannot bootstrap one: listing or minting a
 * generation is an HTTP request this window cannot make.
 */
export const authClient = createDesktopBrokerAuth({
	brokerBaseURL: window.location.origin,
});

// Boot code takes `authClient`; a component that must track takes `auth`.
export const auth = fromAuth(authClient);
