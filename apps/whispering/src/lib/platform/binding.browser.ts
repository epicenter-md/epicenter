/**
 * `#platform/binding` for the web and standalone Tauri builds.
 *
 * OPFS files and secrets that live exactly as long as the tab (ADR-0310).
 * Whispering owns no file and keeps no secret through this handle today, so
 * nothing here is ever called; it is passed because a handle scopes its files
 * and its keychain to the same application as its store, and the id it does
 * that with comes from one place (ADR-0339).
 *
 * The seam holds only the line that differs. Everything composed from it lives
 * in `$lib/whispering/app.ts`, once, for every build.
 */

import type { EpicenterBindingFactory } from '@epicenter/app';
import { createBrowserBinding } from '@epicenter/app/browser';

export const binding: EpicenterBindingFactory = createBrowserBinding();
