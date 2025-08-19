import { type ColumnDescriptions, defineImporter } from '@repo/vault-core';
import { redditAdapter } from './adapter';
import type { RedditAdapterConfig } from './config';
import drizzleConfig from './drizzle.config';
import { metadata } from './metadata';
import { parseRedditExport } from './parse';
import { upsertRedditData } from './upsert';
import { parseSchema } from './validation';

export type { ParsedRedditExport, ParseResult } from './types';

import type * as schema from './schema';

// Node-only Importer export, composed from the web-safe adapter + node parts
export const redditImporter = (args?: RedditAdapterConfig) =>
	defineImporter(redditAdapter(), {
		name: 'Reddit',
		// TODO: fill out remaining tables; cast for now to satisfy type
		metadata: metadata as unknown as ColumnDescriptions<typeof schema>,
		validator: parseSchema,
		drizzleConfig,
		parse: parseRedditExport,
		upsert: upsertRedditData,
	});
