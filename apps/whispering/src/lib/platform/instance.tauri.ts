import { createDesktopInstanceSetting } from '@epicenter/auth/desktop';
import { desktopAuthBootstrap } from './desktop-auth-bootstrap.tauri';

/** Desktop deployment writes belong to the Bun authority, never localStorage. */
export const instanceSetting = createDesktopInstanceSetting({
	bootstrap: desktopAuthBootstrap,
	brokerBaseURL: window.location.origin,
});
