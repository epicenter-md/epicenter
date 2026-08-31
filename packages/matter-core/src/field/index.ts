/**
 * `@epicenter/matter-core/field`: Matter's copy of the closed field-type vocabulary.
 *
 * Two halves over ONE wire-form:
 * - `field.*` builders (authoring) construct a schema in the recognized form.
 * - `recognize` (recognition) classifies a stored schema back to its kind.
 *
 * They are inverses: `recognize` of a serialized `field.X(...)` is kind `X`.
 * `json` (the open escape kind) and {@link jsonValue} (its any-JSON inner) live here;
 * emptiness (`nullable`) does NOT, it is substrate policy each consumer layers on at
 * its own edge.
 *
 * A copy, deliberately. This was one shared `@epicenter/field` package until the
 * store took ownership of its own value vocabulary. Matter never depended on the
 * store: it edits markdown on disk and mirrors it into a disposable SQLite file,
 * and the two systems already emit frontmatter through different writers. What
 * they shared was kind names, not behaviour, so the shared package bought
 * co-ownership of a vocabulary neither could rename alone. This copy is free to
 * diverge; if the two ever have to agree again, what they will agree on is a file
 * format, not a TypeScript package.
 */

export { field, jsonValue } from './builders.js';
export { CalendarDateString } from './calendar-date-string.js';
export { DateTimeString } from './datetime-string.js';
export {
	compile,
	type Field,
	type FieldOf,
	type Kind,
	REFERENCE_KEYWORD,
	recognize,
	referenceTargetOf,
	storageOf,
} from './field.js';
export { InstantString } from './instant-string.js';
