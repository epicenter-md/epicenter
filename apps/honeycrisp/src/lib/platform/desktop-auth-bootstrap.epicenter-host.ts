import { readDesktopAuthBootstrap } from '@epicenter/auth/desktop';

/**
 * Immutable deployment and identity snapshot for this WebView generation.
 *
 * The read is a module, not a call at each use site, because it takes the
 * element out of the DOM: `auth` and `instance` both need the snapshot, and a
 * second read would find nothing and throw.
 */
export const desktopAuthBootstrap = readDesktopAuthBootstrap();
