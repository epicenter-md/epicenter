/**
 * Hosted first-contact storage admission (ADR-0137).
 *
 * The route calls this policy only for an unknown replica. A refusal leaves the
 * push undispatched. Admission refreshes the account's structured observation,
 * preserves blob accounting, and registers a newly admitted workspace at zero
 * bytes before its first push creates durable authority state.
 */

import type { PrincipalId } from '@epicenter/identity';
import type {
	CurrentStateRecordsPartition,
	StorageObservation,
} from '@epicenter/server';
import { extractErrorMessage } from 'wellcrafted/error';

export type StorageAdmissionDependencies = {
	listObservations(principalId: PrincipalId): Promise<StorageObservation[]>;
	readAccountBytes(principalId: PrincipalId): Promise<number>;
	upsertObservation(
		observation: StorageObservation & { principalId: PrincipalId },
	): Promise<void>;
	resolveIncludedBytes(): Promise<number>;
	reportError?(message: string): void;
};

export type RegisteredStorageAdmissionDependencies = Pick<
	StorageAdmissionDependencies,
	'listObservations' | 'reportError'
>;

/** Allow first contact only for a workspace already known to hosted storage. */
export async function admitRegisteredStorageFirstContact(
	{
		listObservations,
		reportError = console.error,
	}: RegisteredStorageAdmissionDependencies,
	partition: CurrentStateRecordsPartition,
): Promise<'allow' | 'refuse'> {
	try {
		const observations = await listObservations(partition.principalId);
		return observations.some(
			(observation) =>
				observation.sourceKind === 'workspace' &&
				observation.sourceId === partition.workspaceId,
		)
			? 'allow'
			: 'refuse';
	} catch (cause) {
		reportError(
			`[storage] first-contact admission for ${partition.principalId}/${partition.workspaceId} failed: ${extractErrorMessage(cause)}`,
		);
		return 'refuse';
	}
}

/** Evaluate and register one hosted workspace before its first replica push. */
export async function admitStorageFirstContact(
	{
		listObservations,
		readAccountBytes,
		upsertObservation,
		resolveIncludedBytes,
		reportError = console.error,
	}: StorageAdmissionDependencies,
	partition: CurrentStateRecordsPartition,
): Promise<'allow' | 'refuse'> {
	try {
		const observations = await listObservations(partition.principalId);
		const registeredWorkspaceIds = new Set(
			observations
				.filter((observation) => observation.sourceKind === 'workspace')
				.map((observation) => observation.sourceId),
		);
		const blobBytes = observations
			.filter((observation) => observation.sourceKind === 'blobs')
			.reduce((sum, observation) => sum + observation.observedBytes, 0);
		const accountBytes = await readAccountBytes(partition.principalId);
		await upsertObservation({
			principalId: partition.principalId,
			sourceKind: 'structured',
			sourceId: 'account',
			observedBytes: accountBytes,
		});

		if (blobBytes + accountBytes >= (await resolveIncludedBytes())) {
			return 'refuse';
		}

		if (!registeredWorkspaceIds.has(partition.workspaceId)) {
			await upsertObservation({
				principalId: partition.principalId,
				sourceKind: 'workspace',
				sourceId: partition.workspaceId,
				observedBytes: 0,
			});
		}
		return 'allow';
	} catch (cause) {
		reportError(
			`[storage] first-contact admission for ${partition.principalId}/${partition.workspaceId} failed: ${extractErrorMessage(cause)}`,
		);
		return 'refuse';
	}
}
