import type { KvDefinitions } from '../document/kv.js';
import {
	type BlobPlaneContracts,
	defineWorkspace,
	lockWorkspace,
	type TableDefinitions,
	type WorkspaceDefinition,
} from './definition.js';
import { APPLICATION_GENERATION_LOCK_FORMAT } from './generation.js';

/** Build one locked generation for tests outside the lock-validation suite. */
export function defineTestWorkspace<
	const TTables extends TableDefinitions,
	const TKv extends KvDefinitions = Record<never, never>,
	const TBlobs extends BlobPlaneContracts = Record<never, never>,
>(config: {
	appId: string;
	dataGeneration?: number;
	name?: string;
	tables: TTables;
	kv?: TKv;
	blobs?: TBlobs;
}): WorkspaceDefinition<TTables, TKv, TBlobs> {
	const candidate = defineWorkspace({
		...config,
		dataGeneration: config.dataGeneration ?? 1,
	});
	return lockWorkspace(candidate, {
		format: APPLICATION_GENERATION_LOCK_FORMAT,
		appId: candidate.appId,
		generations: [candidate.proposedLockEntry],
	});
}
