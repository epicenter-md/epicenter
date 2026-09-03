/**
 * `#platform/epicenter` for the standalone web build.
 *
 * IndexedDB for Local Mail's account registry, OPFS for the mailbox cache, and
 * a credential that lives exactly as long as the tab (ADR-0310). Background
 * synchronization is a desktop capability; this build syncs while a person is
 * looking at it.
 *
 * One argument, because the runtime is the import path (ADR-0339). No
 * `definition` and no `account`: Local Mail holds no Epicenter Data, so its
 * handle has no `data` and no `account` to read.
 */

import { createEpicenter } from '@epicenter/app/browser';
import { LOCAL_MAIL_APP_ID } from '@epicenter/local-mail/storage';

export const epicenter = createEpicenter({ appId: LOCAL_MAIL_APP_ID });
