import type { parseSchema } from './validation';

// ArkType infers array schemas like `[ { ... } ]` as a tuple type with one element.
// Convert any such tuple properties into standard `T[]` arrays for our parser/upsert.
type Arrayify<T> = T extends readonly [infer E] ? E[] : T;
type Inferred = (typeof parseSchema)['infer'];
export type ParsedRedditExport = {
	[K in keyof Inferred]: Arrayify<Inferred[K]>;
};

// Back-compat alias
export type ParseResult = ParsedRedditExport;
