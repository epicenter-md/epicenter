/**
 * What the trusted origin owns for Local Mail: Bun SQLite files under the app's
 * one directory, and OS keychain entries.
 *
 * No credential and no file handle crosses into the page; both are reached over
 * the host's same-origin storage route (ADR-0321, ADR-0310).
 */

import { createDesktopAppStorage } from '@epicenter/app-storage/desktop';
import { LOCAL_MAIL_APP_ID } from '@epicenter/local-mail/storage';

export const appStorage = createDesktopAppStorage({ appId: LOCAL_MAIL_APP_ID });
