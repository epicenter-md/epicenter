import { type Adapter, defineAdapter } from '@repo/vault-core';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { RedditAdapterConfig } from './config';
import drizzleConfig from './drizzle.config';
import { metadata } from './metadata';
import { parseRedditExport } from './parse';
import * as tables from './schema';
import { upsertRedditData } from './upsert';
import { parseSchema } from './validation';

// Expose all tables from schema module (runtime values only; TS types are erased)
export const schema = tables;
// ArkType infers array schemas like `[ { ... } ]` as a tuple type with one element.
// Convert any such tuple properties into standard `T[]` arrays for our parser/upsert.
type Arrayify<T> = T extends readonly [infer E] ? E[] : T;
type Inferred = (typeof parseSchema)['infer'];
export type ParsedRedditExport = {
	[K in keyof Inferred]: Arrayify<Inferred[K]>;
};
// Back-compat for consumers still importing ParseResult from this module
export type ParseResult = ParsedRedditExport;

// Adapter export
export const redditAdapter = defineAdapter((args: RedditAdapterConfig) => {
	args; // TODO

	const adapter = {
		id: 'reddit',
		name: 'Reddit Adapter',
		schema,
		metadata,
		validator: parseSchema,
		drizzleConfig,
		parse: parseRedditExport,
		upsert: upsertRedditData,
	};

	return adapter;
});
