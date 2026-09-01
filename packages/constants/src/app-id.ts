/**
 * The one grammar for an app id.
 *
 * Its own module, and not because `app-data.ts` grew too long. That file
 * resolves an OS application-data root, so it imports `node:os` and `node:path`
 * and cannot be bundled into a page. The grammar is a pure predicate over a
 * string, and both ends of the application storage protocol need it: the page
 * validates a name before sending it, and the host validates the same name on
 * arrival. Leaving it beside the path resolution meant one of them had to keep
 * a second copy, which is how a client starts refusing what a server accepts.
 *
 * An app id names an application surface and its application-owned data root,
 * and two issuers name into that one space: admission issues one when it
 * accepts a folder, while the composition root issues ids for the engines it
 * composes. An admitted app commonly uses the same reverse-domain value for its
 * default data id (ADR-0210), but application identity and data identity remain
 * separate concepts at the data and sync boundaries.
 *
 * Dots are admitted because an admitted app's id *is* its reverse-domain data
 * id, and bare labels stay legal so the composed ids keep the directories they
 * already own.
 *
 * The first and last character must be alphanumeric, and that is load-bearing
 * rather than tidy: `appDataDir` joins an id onto the one data root, so a
 * grammar admitting `.` or `..` would hand a caller a path out of the root, and
 * one admitting a leading dot would let an app hide as a dotfile.
 */

const APP_ID_PATTERN = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

export function isAppId(value: string): boolean {
	return APP_ID_PATTERN.test(value);
}
