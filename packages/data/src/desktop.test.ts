/**
 * Desktop surface detection.
 *
 * This answer decides which replica a surface reads and writes: a page served
 * by the Epicenter desktop host uses the host-owned one, anything else opens
 * its own in the browser. Getting it wrong does not fail loudly, it quietly
 * splits storage in two, so the signal has to survive everything else a surface
 * does to its DOM while booting.
 */
import { afterEach, expect, test } from 'bun:test';

import {
	DESKTOP_SURFACE_MARKER_NAME,
	isEpicenterDesktopSurface,
} from './desktop.js';

const MARKER = `meta[name="${DESKTOP_SURFACE_MARKER_NAME}"]`;
const AUTH_BOOTSTRAP = '#epicenter-auth-bootstrap';

type DocumentStub = { querySelector(selectors: string): unknown };
const globals = globalThis as { document?: DocumentStub };
const originalDocument = globals.document;

/** Present exactly these selectors as matching, and nothing else. */
function setDocument(present: readonly string[]): void {
	globals.document = {
		querySelector: (selectors) => (present.includes(selectors) ? {} : null),
	};
}

afterEach(() => {
	globals.document = originalDocument;
});

test('a page without a document is not a desktop surface', () => {
	globals.document = undefined;
	expect(isEpicenterDesktopSurface()).toBeFalse();
});

test('the host marker names a desktop surface', () => {
	setDocument([MARKER]);
	expect(isEpicenterDesktopSurface()).toBeTrue();
});

test('a surface stays a desktop surface after its auth bootstrap is consumed', () => {
	// A surface parses the auth bootstrap and removes it, because it carries an
	// identity snapshot. Storage routing runs later, from a mounted component,
	// and by then that element is gone.
	setDocument([MARKER, AUTH_BOOTSTRAP]);
	expect(isEpicenterDesktopSurface()).toBeTrue();

	setDocument([MARKER]);
	expect(isEpicenterDesktopSurface()).toBeTrue();
});

test('the auth bootstrap alone does not name a desktop surface', () => {
	// Guards the inverse of the bug: detection must not drift back onto an
	// element whose lifetime belongs to another concern.
	setDocument([AUTH_BOOTSTRAP]);
	expect(isEpicenterDesktopSurface()).toBeFalse();
});
