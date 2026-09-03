/**
 * `#platform/epicenter` inside the trusted Epicenter origin.
 *
 * The host owns the SQLite files and the keychain. Selected by the
 * `epicenter-host` build condition, never by a runtime test: this page runs in
 * a WebView, so nothing observable at runtime tells it apart from a browser
 * tab.
 *
 * One argument, because the runtime is the import path (ADR-0339). No
 * `definition` and no `account`: Local Mail holds no Epicenter Data, so its
 * handle has no `data` and no `account` to read.
 */

import { createEpicenter } from '@epicenter/app/desktop';
import { LOCAL_MAIL_APP_ID } from '@epicenter/local-mail/storage';

export const epicenter = createEpicenter({ appId: LOCAL_MAIL_APP_ID });
