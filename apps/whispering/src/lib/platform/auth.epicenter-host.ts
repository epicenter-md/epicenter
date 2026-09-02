import { createDesktopBrokerAuth } from '@epicenter/auth/desktop';
import { reactive } from '@epicenter/auth/svelte';
import { desktopAuthBootstrap } from './desktop-auth-bootstrap.epicenter-host';

/**
 * One window-local transport client over the process-wide Bun authority.
 *
 * It holds no credential, so `openWebSocket` denies permanently: desktop sync
 * belongs to the host process, not a window.
 */
export const auth = reactive(
	createDesktopBrokerAuth({
		bootstrap: desktopAuthBootstrap,
		brokerBaseURL: window.location.origin,
	}),
);
