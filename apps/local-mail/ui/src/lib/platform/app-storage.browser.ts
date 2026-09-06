/**
 * What a browser tab owns for Local Mail: an OPFS SQLite pool and secrets that
 * live for the life of the tab.
 *
 * A browser build has no keychain, so `secrets.get` answers `null` after a
 * reload. That is the same answer a new desktop device gives, and the
 * application already handles it (ADR-0310).
 */

import { createBrowserAppStorage } from '@epicenter/app-storage/browser';
import { LOCAL_MAIL_APP_ID } from '@epicenter/local-mail/storage';

export const appStorage = createBrowserAppStorage({ appId: LOCAL_MAIL_APP_ID });
