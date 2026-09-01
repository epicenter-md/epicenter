/**
 * `#platform/epicenter` inside the trusted Epicenter origin.
 *
 * The host owns the SQLite files and the keychain; Local Mail's own data stays
 * client-owned in this WebView. Selected by the `epicenter-host` build
 * condition, never by a runtime test: this page runs in a WebView, so nothing
 * observable at runtime tells it apart from a browser tab.
 */

import { createEpicenter } from '@epicenter/app';
import { createDesktopBinding } from '@epicenter/app/desktop';
import { LOCAL_MAIL_APP_ID } from '@epicenter/local-mail/storage';

export const epicenter = createEpicenter({
	appId: LOCAL_MAIL_APP_ID,
	binding: createDesktopBinding({ appId: LOCAL_MAIL_APP_ID }),
});
