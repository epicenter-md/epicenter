/**
 * `#platform/epicenter` for the standalone web build.
 *
 * IndexedDB for Local Mail's account registry, OPFS for the mailbox cache, and
 * a credential that lives exactly as long as the tab (ADR-0310). Background
 * synchronization is a desktop capability; this build syncs while a person is
 * looking at it.
 */

import { createEpicenter } from '@epicenter/app';
import { createBrowserBinding } from '@epicenter/app/browser';
import { LOCAL_MAIL_APP_ID } from '@epicenter/local-mail/storage';

export const epicenter = createEpicenter({
	appId: LOCAL_MAIL_APP_ID,
	binding: createBrowserBinding({ appId: LOCAL_MAIL_APP_ID }),
});
