/**
 * `#platform/epicenter` for the standalone web build.
 *
 * OPFS for the mailbox cache, and a credential that lives exactly as long as
 * the tab (ADR-0310). Background synchronization is a desktop capability; this
 * build syncs while a person is looking at it.
 */

import { createBrowserEpicenter } from '@epicenter/app/browser';
import { LOCAL_MAIL_APP_ID } from '@epicenter/local-mail/storage';

export const epicenter = createBrowserEpicenter({ appId: LOCAL_MAIL_APP_ID });
