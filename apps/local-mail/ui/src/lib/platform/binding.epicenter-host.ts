/**
 * `#platform/binding` inside the trusted Epicenter origin.
 *
 * The host owns the SQLite files and the keychain entries. Selected by the
 * `epicenter-host` build condition, never by a runtime test: this page runs in
 * a WebView, so nothing observable at runtime tells it apart from a browser
 * tab.
 */

import { createDesktopBinding } from '@epicenter/app/desktop';

export const binding = createDesktopBinding();
