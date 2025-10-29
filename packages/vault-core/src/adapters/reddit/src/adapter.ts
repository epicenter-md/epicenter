import { defineAdapter } from '@repo/vault-core';
import { redditTransforms } from '../migrations/transforms';
import { redditVersions } from '../migrations/versions';
import type { RedditAdapterConfig } from './config';
import { redditZipIngestor } from './ingestor';
import { metadata } from './metadata';
import * as schema from './schema';
import { parseSchema } from './validation';

// Unified Reddit adapter wired for core-orchestrated validation and ingestion.
// Tag alignment between versions and transforms is enforced by core defineAdapter typing.
export const redditAdapter = defineAdapter((_?: RedditAdapterConfig) => ({
	id: 'reddit',
	schema,
	metadata,
	validator: parseSchema,
	ingestors: [redditZipIngestor],
	versions: redditVersions,
	transforms: redditTransforms,
}));
