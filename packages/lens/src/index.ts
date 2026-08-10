/**
 * The Epicenter data-contract vocabulary: what an application declares, and
 * what names the rows it declares.
 *
 * This is the front door, and it names the thing being built. It used to name
 * the opposite: `.` exported the superseded vocabulary and the current one
 * hid at `./lens`, so `@epicenter/lens` meant the half that is going away.
 * ADR-0224 called that arrangement a lie when `@epicenter/data` had it, and it
 * was the same lie here.
 *
 * Everything reachable from here is inert: types, an arktype schema, an address
 * grammar, and a listener registry. No sockets, no storage, no Yjs. That is not
 * a style preference, it is the promise `docs/licensing/licensing-strategy.md`
 * makes about the closure an installed app bundles (`@epicenter/app` to
 * `@epicenter/lens` to `@epicenter/field`, compiled, MIT, and deliberately not
 * reaching `@epicenter/data`, Yjs, blobs, auth, or the app shell).
 *
 * The superseded vocabulary, including the observation carrier that opened
 * WebSockets and redialled them, is deleted rather than moved (ADR-0227). That
 * carrier was the part that made the inert claim untrue while it lived here.
 */
export {
	CalendarDateString,
	compile,
	DateTimeString,
	type Field,
	type FieldOf,
	field,
	InstantString,
	jsonValue,
	type Kind,
	REFERENCE_KEYWORD,
	recognize,
	referenceTargetOf,
	storageOf,
} from '@epicenter/field';
export * from './addresses.js';
export * from './canonical.js';
export * from './json.js';
export * from './lens.js';
export * from './observation.js';
