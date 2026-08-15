/**
 * The Epicenter data-contract vocabulary: what an application declares, and
 * what names the rows it declares.
 *
 * The central export is `defineWorkspace`: one application's complete,
 * immutable declaration of its durable workspace (ADR-0240). The package is
 * named for it. It used to be `@epicenter/lens`, after the model this one
 * replaced, where several release-local "lenses" could interpret one shared
 * workspaceId and none was canonical; an application now owns its workspaceId and
 * an opened runtime holds exactly one definition.
 *
 * Everything reachable from here is inert: types, an arktype schema, an address
 * grammar, and a listener registry. No sockets, no storage, no Yjs. That is not
 * a style preference, it is the promise `docs/licensing/licensing-strategy.md`
 * makes about the closure an installed app bundles (compiled, MIT, and
 * deliberately not reaching `@epicenter/data`, Yjs, blobs, auth, or the app
 * shell).
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
export * from './observation.js';
export * from './workspace.js';
