/**
 * `#platform/binding` for the standalone web build.
 *
 * OPFS for the mailbox cache, and a credential that lives exactly as long as
 * the tab (ADR-0310). Background synchronization is a desktop capability; this
 * build syncs while a person is looking at it.
 */

import type { EpicenterBindingFactory } from '@epicenter/app';
import { createBrowserBinding } from '@epicenter/app/browser';

export const binding: EpicenterBindingFactory = createBrowserBinding();
