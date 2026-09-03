/**
 * `#platform/epicenter` inside the trusted Epicenter origin.
 *
 * The host owns the SQLite files and the keychain entries. Selected by the
 * `epicenter-host` build condition, never by a runtime test: this page runs in
 * a WebView, so nothing observable at runtime tells it apart from a browser
 * tab.
 */

import { createDesktopEpicenter } from '@epicenter/app/desktop';
import { LOCAL_MAIL_APP_ID } from '@epicenter/local-mail/storage';

export const epicenter = createDesktopEpicenter({ appId: LOCAL_MAIL_APP_ID });
