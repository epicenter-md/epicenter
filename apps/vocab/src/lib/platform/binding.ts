/**
 * Who owns this build's SQLite files and keychain entries.
 *
 * One file with no build condition, the way `platform/auth.ts` next to it is
 * one file: Vocab is a browser application, and both of its builds (the web
 * app and the hosted candidate) run in a page. It uses neither capability
 * today, and still takes the owner its platform actually has, because
 * `createEpicenter` takes a binding rather than deciding for itself
 * (ADR-0339).
 *
 * A build that needs the trusted origin's keychain adds a `#platform/binding`
 * condition here, the way `apps/honeycrisp` does. Adding the seam before
 * anything reads a secret would be two files that must agree, to select
 * between two owners of nothing.
 */

import { createBrowserBinding } from '@epicenter/app/browser';

export const binding = createBrowserBinding();
