/**
 * `#platform/binding` for the standalone web build.
 *
 * OPFS for the mailbox cache, and a credential that lives exactly as long as
 * the tab (ADR-0310). Closing the tab therefore means connecting again, where
 * the desktop reopens with the account still connected and delivers what was
 * owed.
 */

import type { EpicenterBindingFactory } from '@epicenter/app';
import { createBrowserBinding } from '@epicenter/app/browser';

export const binding: EpicenterBindingFactory = createBrowserBinding();
