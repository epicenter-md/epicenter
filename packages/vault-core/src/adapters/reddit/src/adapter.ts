import { defineAdapter } from '@repo/vault-core';
import * as schema from './schema';

// Minimal, browser-usable adapter (no Node-only imports here)
export const redditAdapter = defineAdapter(() => ({
	id: 'reddit',
	schema,
}));
