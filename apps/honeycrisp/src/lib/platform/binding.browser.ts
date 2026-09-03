/**
 * `#platform/epicenter` for the web and standalone builds.
 *
 * OPFS files and secrets that live exactly as long as the tab (ADR-0310).
 * Honeycrisp owns no file and keeps no secret today, so nothing here is ever
 * called; it is passed because a handle scopes its files and its keychain to
 * the same application as its store, and the id it does that with comes from
 * one place (ADR-0339).
 *
 * The seam holds only the line that differs. Everything composed from it lives
 * in `$lib/epicenter.svelte.ts`, once, for both builds.
 */

import { createBrowserEpicenter } from '@epicenter/app/browser';

export const createEpicenter = createBrowserEpicenter;
