import { createDesktopBrokerAuth } from '@epicenter/auth/desktop';
import { desktopAuthBootstrap } from './desktop-auth-bootstrap.epicenter-host';
import type { PlatformAuth } from './types';

/** One window-local transport client over the process-wide Bun authority. */
export const auth: PlatformAuth = createDesktopBrokerAuth({
	bootstrap: desktopAuthBootstrap,
	brokerBaseURL: window.location.origin,
});
