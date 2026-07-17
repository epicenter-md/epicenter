import { Database } from 'bun:sqlite';
import {
	type BaselineScanRequest,
	type EnrollRequest,
	openRowAuthority,
	type SyncRequest,
} from '@epicenter/row-sync';
import { createBunSqliteAdapter } from '@epicenter/row-sync/bun';
import * as Y from '@y/y';
import type { CanonicalReplicaTransport } from './canonical-replica.js';

export function mergedCompactState(parts: readonly Uint8Array[]): Uint8Array {
	const doc = new Y.Doc({ gc: true });
	try {
		for (const part of parts) Y.applyUpdate(doc, part);
		return Y.encodeStateAsUpdate(doc);
	} finally {
		doc.destroy();
	}
}

function isValidUpdate(update: Uint8Array): boolean {
	try {
		mergedCompactState([update]);
		return true;
	} catch {
		return false;
	}
}

export function openTestAuthority() {
	const database = new Database(':memory:');
	const authority = openRowAuthority({
		database: createBunSqliteAdapter(database),
		codec: { isValidUpdate, mergedCompactState },
	});
	return { authority, database };
}

export function createTestTransport(
	authority: ReturnType<typeof openRowAuthority>,
) {
	const enrollRequests: EnrollRequest[] = [];
	const syncRequests: SyncRequest[] = [];
	const baselineRequests: BaselineScanRequest[] = [];
	const transport: CanonicalReplicaTransport & {
		enrollRequests: EnrollRequest[];
		syncRequests: SyncRequest[];
		baselineRequests: BaselineScanRequest[];
	} = {
		enrollRequests,
		syncRequests,
		baselineRequests,
		async enroll(request) {
			enrollRequests.push(structuredClone(request));
			return authority.enroll(request);
		},
		async sync(request) {
			syncRequests.push(structuredClone(request));
			return authority.sync(request);
		},
		async baselineScan(request) {
			baselineRequests.push(structuredClone(request));
			return authority.baselineScan(request);
		},
	};
	return transport;
}

export function captureUpdate(change: (doc: Y.Doc) => void): Uint8Array {
	const doc = new Y.Doc();
	try {
		let captured: Uint8Array | undefined;
		doc.on('update', (update) => {
			captured = Uint8Array.from(update);
		});
		change(doc);
		if (!captured) throw new Error('Expected a Yjs update');
		return captured;
	} finally {
		doc.destroy();
	}
}

export function readText(
	parts: readonly Uint8Array[],
	root = 'editor',
): string {
	const doc = new Y.Doc();
	try {
		for (const part of parts) Y.applyUpdate(doc, part);
		return doc.get(root).toString();
	} finally {
		doc.destroy();
	}
}
