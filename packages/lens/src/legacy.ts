/**
 * The superseded data-contract vocabulary.
 *
 * `definitions.ts` is the TypeBox `Lens`/`TableDefinition` shape that
 * `@epicenter/data/legacy` and `@epicenter/app` are written against;
 * `from-json.ts` and `wire.ts` parse and serialize it; `carrier.ts` is the
 * multi-process observation carrier, which opens a WebSocket and redials it.
 *
 * It is a separate entry point so that "who still needs the old vocabulary" is
 * a grep for one specifier rather than a symbol-by-symbol audit, and so that
 * the front door can make the inert claim honestly. Nothing here is deprecated
 * in the sense of unmaintained: it is what every application except Honeycrisp
 * currently runs on. It is deprecated in the sense that nothing new should
 * reach for it.
 *
 * The dependency runs one way. These four import from the current vocabulary
 * (`addresses`, `observation`, `json`) and nothing current imports back, so
 * this file can be deleted whole when the last consumer moves.
 *
 * The handful of CURRENT names the legacy stack also needs are re-exported at
 * the bottom, so a consumer written against the old vocabulary names ONE
 * specifier. That is not tidiness: `@epicenter/app` is the published client an
 * installed app bundles, and reaching `.` would put arktype in its declaration
 * closure, which the licensing strategy's external-consumer gate is there to
 * notice. The old vocabulary is TypeBox and should stay resolvable without the
 * new one.
 */
export * from './carrier.js';
export * from './definitions.js';
export * from './from-json.js';
export * from './wire.js';

// Current-vocabulary names the legacy stack uses, re-exported so an old-
// vocabulary consumer needs one specifier and no arktype.
export type { RowAddress } from './addresses.js';
export {
	createInvalidationDispatcher,
	type InvalidationDispatcher,
	type InvalidationErrorReporter,
	type TableInvalidation,
	type TableInvalidationListener,
} from './observation.js';
export type { JsonObject, JsonValue } from './json.js';
